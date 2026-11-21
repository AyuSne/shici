import { afterEach, describe, expect, it } from 'vitest'
import type { ChatStreamEvent, ChatStreamUpdate } from '../../shared/chat'
import { findCatalogModel } from '../../shared/model-catalog'
import type { ProviderRetryPolicy } from '../../shared/model-providers'
import {
  startAnthropicStub,
  type AnthropicStubResponse
} from '../../testing/anthropic-sse-stub'
import {
  startGeminiSseStub,
  type GeminiStubResponse
} from '../../testing/gemini-sse-stub'
import {
  startResponsesStub,
  type ResponsesStubResponse
} from '../../testing/responses-sse-stub'
import { startSseStub, type StubResponse } from '../../testing/sse-stub'
import type { ChatConfig } from './config'
import { descriptorOfCatalogModel, type ChatModelDescriptor } from './model-descriptor'
import type { RetryTiming } from './retry'
import { createChatService } from './service'

/**
 * #69 的验收跑在真实服务层 + 四种协议各自的本地 SSE stub 上：
 * 不碰私有重试函数，也不 mock pi 或 service 的内部协作者。
 *
 * 等待与抖动用确定性的 `RetryTiming` 替身，策略本身（最多 5 次、退避表、
 * 哪些分类可重试、Retry-After 下限）仍由产品代码决定。
 */

type Step =
  | { kind: 'fail'; status: number; headers?: Readonly<Record<string, string>> }
  | { kind: 'success'; text: string; thinking?: readonly string[] }
  | { kind: 'empty' }
  | { kind: 'truncate'; text?: readonly string[]; thinking?: readonly string[] }

type Closeable = { close(): Promise<void> }

const stubs: Closeable[] = []

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

function track<T extends Closeable>(stub: T): T {
  stubs.push(stub)
  return stub
}

type Harness = {
  name: string
  start: (steps: readonly Step[]) => Promise<{ baseUrl: string; requests: readonly unknown[] } & Closeable>
  descriptorAt: (baseUrl: string) => ChatModelDescriptor
}

const OPENAI_CHAT: Harness = {
  name: 'OpenAI Chat Completions',
  descriptorAt: (baseUrl) =>
    descriptorOfCatalogModel(
      findCatalogModel('deepseek', 'deepseek-flash')!,
      baseUrl,
      'deepseek'
    ),
  async start(steps) {
    return track(
      await startSseStub({ kind: 'sequence', scripts: steps.map(openAiResponse) })
    )
  }
}

const OPENAI_RESPONSES: Harness = {
  name: 'OpenAI Responses',
  descriptorAt: (baseUrl) =>
    descriptorOfCatalogModel(
      findCatalogModel('openai', 'gpt-5')!,
      `${baseUrl}/v1`,
      'openai'
    ),
  async start(steps) {
    return track(
      await startResponsesStub({
        kind: 'sequence',
        scripts: steps.map(responsesResponse)
      })
    )
  }
}

const ANTHROPIC: Harness = {
  name: 'Anthropic Messages',
  descriptorAt: (baseUrl) =>
    descriptorOfCatalogModel(
      findCatalogModel('anthropic', 'claude-fable-5')!,
      baseUrl,
      'anthropic'
    ),
  async start(steps) {
    return track(
      await startAnthropicStub({
        kind: 'sequence',
        scripts: steps.map(anthropicResponse)
      })
    )
  }
}

const GEMINI: Harness = {
  name: 'Gemini API',
  descriptorAt: (baseUrl) =>
    descriptorOfCatalogModel(
      findCatalogModel('gemini', 'gemini-2.5-flash')!,
      `${baseUrl}/v1beta`,
      'gemini'
    ),
  async start(steps) {
    return track(
      await startGeminiSseStub({
        kind: 'sequence',
        scripts: steps.map(geminiResponse)
      })
    )
  }
}

const HARNESSES = [OPENAI_CHAT, OPENAI_RESPONSES, ANTHROPIC, GEMINI] as const

function openAiResponse(step: Step): StubResponse {
  switch (step.kind) {
    case 'fail':
      return { kind: 'status', status: step.status, headers: step.headers }
    case 'success':
      return {
        kind: 'stream',
        text: [step.text],
        ...(step.thinking === undefined ? {} : { thinking: step.thinking })
      }
    case 'empty':
      return { kind: 'stream', text: [] }
    case 'truncate':
      return {
        kind: 'truncate',
        ...(step.text === undefined ? {} : { text: step.text }),
        ...(step.thinking === undefined ? {} : { thinking: step.thinking })
      }
  }
}

function responsesResponse(step: Step): ResponsesStubResponse {
  switch (step.kind) {
    case 'fail':
      return { kind: 'status', status: step.status, headers: step.headers }
    case 'success':
      return {
        kind: 'stream',
        text: [step.text],
        ...(step.thinking === undefined ? {} : { thinking: step.thinking })
      }
    case 'empty':
      return { kind: 'stream', text: [] }
    case 'truncate':
      return {
        kind: 'truncate',
        ...(step.text === undefined ? {} : { text: step.text }),
        ...(step.thinking === undefined ? {} : { thinking: step.thinking })
      }
  }
}

function anthropicResponse(step: Step): AnthropicStubResponse {
  switch (step.kind) {
    case 'fail':
      return { kind: 'status', status: step.status, headers: step.headers }
    case 'success':
      return {
        kind: 'stream',
        text: [step.text],
        ...(step.thinking === undefined ? {} : { thinking: step.thinking })
      }
    case 'empty':
      return { kind: 'stream', text: [] }
    case 'truncate':
      return {
        kind: 'truncate',
        ...(step.text === undefined ? {} : { text: step.text }),
        ...(step.thinking === undefined ? {} : { thinking: step.thinking })
      }
  }
}

function geminiResponse(step: Step): GeminiStubResponse {
  switch (step.kind) {
    case 'fail':
      return { kind: 'status', status: step.status, headers: step.headers }
    case 'success':
      return {
        kind: 'stream',
        text: [step.text],
        ...(step.thinking === undefined ? {} : { thinking: step.thinking })
      }
    case 'empty':
      return { kind: 'stream', text: [] }
    case 'truncate':
      return {
        kind: 'truncate',
        ...(step.text === undefined ? {} : { text: step.text }),
        ...(step.thinking === undefined ? {} : { thinking: step.thinking })
      }
  }
}

type RecordedTiming = {
  timing: RetryTiming
  delays: number[]
}

/** 抖动固定为 1.0（random=0.5），等待立即返回并留下每次退避毫秒数。 */
function recordedTiming(): RecordedTiming {
  const delays: number[] = []
  return {
    delays,
    timing: {
      random: () => 0.5,
      sleep: async (ms) => {
        delays.push(ms)
        return true
      }
    }
  }
}

function configFor(
  descriptor: ChatModelDescriptor,
  policy: ProviderRetryPolicy = { mode: 'normal' }
): ChatConfig {
  return {
    apiKey: 'test-key',
    baseUrl: descriptor.baseUrl,
    model: descriptor.model,
    providerId: 'provider-retry',
    descriptor,
    retryPolicy: policy
  }
}

type Collected = {
  events: ChatStreamEvent[]
  verified: string[]
  start: (service: ReturnType<typeof createChatService>, streamId?: string) => void
}

function collect(): Collected {
  const events: ChatStreamEvent[] = []
  const verified: string[] = []
  return {
    events,
    verified,
    start(service, streamId = 'stream-retry') {
      service.start(
        { threadId: 'thread-1', streamId, messages: [{ role: 'user', content: '你好' }] },
        (update: ChatStreamUpdate) => events.push(update.event)
      )
    }
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('等待事件超时')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function terminalOf(events: readonly ChatStreamEvent[]): ChatStreamEvent | undefined {
  return events.find((event) => event.type === 'done' || event.type === 'error')
}

describe.each(HARNESSES)('$name 的共享重试执行层', (harness) => {
  it('连续失败 2 次后成功：中间错误不显示，正文与 done 只出现一次，provider 转已验证', async () => {
    const target = await harness.start([
      { kind: 'fail', status: 500, headers: { 'x-request-id': 'req-fail-1' } },
      { kind: 'fail', status: 500, headers: { 'x-request-id': 'req-fail-2' } },
      { kind: 'success', text: '终于成功' }
    ])
    const recorded = recordedTiming()
    const collected = collect()
    const service = createChatService({
      resolveConfig: () => configFor(harness.descriptorAt(target.baseUrl)),
      retryTiming: recorded.timing,
      onVerified: (providerId) => collected.verified.push(providerId)
    })

    collected.start(service)
    await waitUntil(() => terminalOf(collected.events) !== undefined)

    expect(collected.events).toEqual([
      { type: 'text', text: '终于成功' },
      { type: 'done' }
    ])
    expect(collected.events.some((event) => event.type === 'error')).toBe(false)
    expect(collected.verified).toEqual(['provider-retry'])
    expect(target.requests).toHaveLength(3)
    expect(recorded.delays).toEqual([500, 1000])
  })

  it('持续失败：normal 共尝试 6 次后只显示最后一次的真实错误与 request id', async () => {
    const target = await harness.start(
      [1, 2, 3, 4, 5, 6].map((index) => ({
        kind: 'fail' as const,
        status: 500,
        headers: { 'x-request-id': `req-exhaust-${index}` }
      }))
    )
    const recorded = recordedTiming()
    const collected = collect()
    const service = createChatService({
      resolveConfig: () => configFor(harness.descriptorAt(target.baseUrl)),
      retryTiming: recorded.timing
    })

    collected.start(service)
    await waitUntil(() => terminalOf(collected.events) !== undefined)

    expect(collected.events).toHaveLength(1)
    expect(collected.events[0]).toMatchObject({
      type: 'error',
      error: {
        code: 'server-busy',
        kind: 'SERVER',
        status: 500,
        requestId: 'req-exhaust-6'
      }
    })
    expect(target.requests).toHaveLength(6)
    expect(recorded.delays).toEqual([500, 1000, 2000, 4000, 8000])
  })

  it('normal 不重试 AUTH；always 重试所有模型请求失败直到耗尽', async () => {
    const normalTarget = await harness.start([
      { kind: 'fail', status: 401, headers: { 'x-request-id': 'req-auth-normal' } }
    ])
    const normalRecorded = recordedTiming()
    const normal = collect()
    const normalService = createChatService({
      resolveConfig: () => configFor(harness.descriptorAt(normalTarget.baseUrl)),
      retryTiming: normalRecorded.timing
    })
    normal.start(normalService)
    await waitUntil(() => terminalOf(normal.events) !== undefined)

    expect(normal.events).toHaveLength(1)
    expect(normal.events[0]).toMatchObject({
      type: 'error',
      error: { kind: 'AUTH', status: 401, requestId: 'req-auth-normal' }
    })
    expect(normalTarget.requests).toHaveLength(1)
    expect(normalRecorded.delays).toEqual([])

    const alwaysTarget = await harness.start(
      [1, 2, 3, 4, 5, 6].map((index) => ({
        kind: 'fail' as const,
        status: 401,
        headers: { 'x-request-id': `req-auth-always-${index}` }
      }))
    )
    const alwaysRecorded = recordedTiming()
    const always = collect()
    const alwaysService = createChatService({
      resolveConfig: () =>
        configFor(harness.descriptorAt(alwaysTarget.baseUrl), { mode: 'always' }),
      retryTiming: alwaysRecorded.timing
    })
    always.start(alwaysService, 'stream-always')
    await waitUntil(() => terminalOf(always.events) !== undefined)

    expect(always.events).toHaveLength(1)
    expect(always.events[0]).toMatchObject({
      type: 'error',
      error: { kind: 'AUTH', status: 401, requestId: 'req-auth-always-6' }
    })
    expect(alwaysTarget.requests).toHaveLength(6)
    expect(alwaysRecorded.delays).toEqual([500, 1000, 2000, 4000, 8000])
  })

  it('正文已经到达后断流：保留正文、显示最终错误，绝不再自动重试', async () => {
    const target = await harness.start([
      { kind: 'truncate', text: ['半句正文'] }
    ])
    const recorded = recordedTiming()
    const collected = collect()
    const service = createChatService({
      resolveConfig: () => configFor(harness.descriptorAt(target.baseUrl)),
      retryTiming: recorded.timing
    })

    collected.start(service)
    await waitUntil(() => terminalOf(collected.events) !== undefined)

    expect(collected.events).toEqual([
      { type: 'text', text: '半句正文' },
      {
        type: 'error',
        error: expect.objectContaining({ code: 'network', kind: 'TRANSPORT' })
      }
    ])
    expect(target.requests).toHaveLength(1)
    expect(recorded.delays).toEqual([])
  })
})

describe('重试策略的边界', () => {
  it('只有思维链到达后断流也不重试，保留思维链', async () => {
    const target = track(
      await startSseStub({
        kind: 'truncate',
        thinking: ['先想']
      })
    )
    const recorded = recordedTiming()
    const collected = collect()
    const service = createChatService({
      resolveConfig: () => configFor(OPENAI_CHAT.descriptorAt(target.baseUrl)),
      retryTiming: recorded.timing
    })

    collected.start(service)
    await waitUntil(() => terminalOf(collected.events) !== undefined)

    expect(collected.events).toEqual([
      { type: 'thinking', text: '先想' },
      {
        type: 'error',
        error: expect.objectContaining({ code: 'network', kind: 'TRANSPORT' })
      }
    ])
    expect(target.requests).toHaveLength(1)
    expect(recorded.delays).toEqual([])
  })

  it('EMPTY_RESPONSE 属于临时错误：空回答后重试，第二次有内容才算完成', async () => {
    const target = track(
      await startSseStub({
        kind: 'sequence',
        scripts: [
          { kind: 'stream', text: [] },
          { kind: 'stream', text: ['第二次有内容'] }
        ]
      })
    )
    const recorded = recordedTiming()
    const collected = collect()
    const service = createChatService({
      resolveConfig: () => configFor(OPENAI_CHAT.descriptorAt(target.baseUrl)),
      retryTiming: recorded.timing
    })

    collected.start(service)
    await waitUntil(() => terminalOf(collected.events) !== undefined)

    expect(collected.events).toEqual([
      { type: 'text', text: '第二次有内容' },
      { type: 'done' }
    ])
    expect(target.requests).toHaveLength(2)
    expect(recorded.delays).toEqual([500])
  })

  it('Retry-After 是不提前的下限：1 秒时等待至少 1 秒，超过 10 秒则直接放弃', async () => {
    const retried = track(
      await startSseStub({
        kind: 'sequence',
        scripts: [
          {
            kind: 'status',
            status: 429,
            headers: { 'x-request-id': 'req-429', 'retry-after': '1' }
          },
          { kind: 'stream', text: ['等到了'] }
        ]
      })
    )
    const recorded = recordedTiming()
    const collected = collect()
    const service = createChatService({
      resolveConfig: () => configFor(OPENAI_CHAT.descriptorAt(retried.baseUrl)),
      retryTiming: recorded.timing
    })
    collected.start(service)
    await waitUntil(() => terminalOf(collected.events) !== undefined)

    expect(collected.events).toEqual([
      { type: 'text', text: '等到了' },
      { type: 'done' }
    ])
    expect(retried.requests).toHaveLength(2)
    expect(recorded.delays[0]).toBeGreaterThanOrEqual(1000)

    const abandoned = track(
      await startSseStub({
        kind: 'status',
        status: 429,
        headers: { 'x-request-id': 'req-429-long', 'retry-after': '11' }
      })
    )
    const abandonedRecorded = recordedTiming()
    const abandonedEvents = collect()
    const abandonedService = createChatService({
      resolveConfig: () => configFor(OPENAI_CHAT.descriptorAt(abandoned.baseUrl)),
      retryTiming: abandonedRecorded.timing
    })
    abandonedEvents.start(abandonedService, 'stream-abandon')
    await waitUntil(() => terminalOf(abandonedEvents.events) !== undefined)

    expect(abandonedEvents.events).toHaveLength(1)
    expect(abandonedEvents.events[0]).toMatchObject({
      type: 'error',
      error: { kind: 'RATE_LIMIT', status: 429, requestId: 'req-429-long' }
    })
    expect(abandoned.requests).toHaveLength(1)
    expect(abandonedRecorded.delays).toEqual([])
  })

  it('退避期间停止：取消等待中的重试，不再发请求也不补错误', async () => {
    const target = track(await startSseStub({ kind: 'status', status: 500 }))
    let notifyWaiting: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      notifyWaiting = resolve
    })
    const timing: RetryTiming = {
      random: () => 0.5,
      sleep(_ms, signal) {
        return new Promise<boolean>((resolve) => {
          notifyWaiting?.()
          signal.addEventListener('abort', () => resolve(false), { once: true })
        })
      }
    }
    const collected = collect()
    const service = createChatService({
      resolveConfig: () => configFor(OPENAI_CHAT.descriptorAt(target.baseUrl)),
      retryTiming: timing
    })

    collected.start(service, 'stream-stop-backoff')
    await waitUntil(() => target.requests.length === 1)
    await waiting
    expect(service.stop('stream-stop-backoff')).toEqual({ stopped: true })

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(target.requests).toHaveLength(1)
    expect(collected.events).toEqual([])
  })

  it('always 也不重试本地缺钥匙预检：请求数为 0，只显示配置错误', async () => {
    const target = track(await startSseStub({ kind: 'stream', text: ['不该出现'] }))
    const recorded = recordedTiming()
    const collected = collect()
    const service = createChatService({
      resolveConfig: () => ({
        ...configFor(OPENAI_CHAT.descriptorAt(target.baseUrl), { mode: 'always' }),
        apiKey: '',
        missingCredential: true,
        credentialProblem: { kind: 'stored-missing' }
      }),
      retryTiming: recorded.timing
    })

    collected.start(service)
    await waitUntil(() => terminalOf(collected.events) !== undefined)

    expect(collected.events).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({ code: 'not-configured' })
      }
    ])
    expect(target.requests).toHaveLength(0)
    expect(recorded.delays).toEqual([])
  })
})
