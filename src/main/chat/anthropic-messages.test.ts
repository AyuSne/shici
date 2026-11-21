import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatStreamEvent, ChatStreamUpdate } from '../../shared/chat'
import { isCustomProviderProtocol } from '../../shared/model-protocols'
import { readBuiltinProviderSetup } from '../../shared/model-builtin'
import {
  startAnthropicStub,
  type AnthropicStub,
  type AnthropicStubScript
} from '../../testing/anthropic-sse-stub'
import { unusedBaseUrl } from '../../testing/sse-stub'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { createCustomProvider } from '../settings/provider-editing'
import {
  activateModelProvider,
  addBuiltinProvider,
  setDefaultProviderModel
} from '../settings/provider-writes'
import { readProviderModels } from '../settings/providers'
import type { SecretStore } from '../settings/secret-store'
import type { ChatConfig } from './config'
import { resolveChatConfig } from './config'
import type { ChatModelDescriptor } from './model-descriptor'
import type { RetryTiming } from './retry'
import { createChatService } from './service'

/**
 * #65：Anthropic Messages 走真实 pi 请求，只连本地 SSE stub。
 * 这里覆盖正文 / 思维链 / 停止 / 空回答 / 断流 / HTTP 分类 / 鉴权与请求字段，
 * 以及内置 anthropic+minimax 与自定义 anthropic-messages provider 的配置链路。
 */

const stubs: AnthropicStub[] = []

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function stub(script: AnthropicStubScript): Promise<AnthropicStub> {
  const created = await startAnthropicStub(script)
  stubs.push(created)
  return created
}

/** Claude 的当前目录模型走自适应思考；high 映射成 output_config.effort=high。 */
const ANTHROPIC_COMPAT = { forceAdaptiveThinking: true }

function descriptorFor(
  target: AnthropicStub,
  patch: Partial<ChatModelDescriptor> = {}
): ChatModelDescriptor {
  return {
    provider: 'anthropic',
    model: 'claude-fable-5',
    api: 'anthropic-messages',
    baseUrl: target.baseUrl,
    contextWindow: 1000000,
    maxTokens: 128000,
    input: ['text'],
    reasoning: true,
    compat: ANTHROPIC_COMPAT,
    ...patch
  }
}

function configFor(target: AnthropicStub, patch: Partial<ChatConfig> = {}): ChatConfig {
  const descriptor = descriptorFor(target)
  return {
    apiKey: 'sk-ant-synthetic-0001',
    baseUrl: descriptor.baseUrl,
    model: descriptor.model,
    descriptor,
    ...patch
  }
}

function collector(): {
  events: ChatStreamEvent[]
  send: (update: ChatStreamUpdate) => void
  waitFor: (
    predicate: (events: readonly ChatStreamEvent[]) => boolean,
    timeoutMs?: number
  ) => Promise<void>
} {
  const events: ChatStreamEvent[] = []
  return {
    events,
    send: (update) => events.push(update.event),
    waitFor: (predicate, timeoutMs = 5000) => waitUntil(() => predicate(events), timeoutMs)
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('等待事件超时')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const userTurn = { role: 'user' as const, content: '你好' }

/** 只替换等待与抖动：策略仍按生产代码的 normal / 5 次执行。 */
const fastRetry: RetryTiming = {
  random: () => 0.5,
  sleep: async () => true
}

function pathOf(url: string): string {
  return url.split('?')[0] ?? url
}

describe('Anthropic Messages 流式请求（真实 pi + 本地 SSE stub）', () => {
  it('思维链先、正文后；x-api-key、anthropic-version、/v1/messages 与 high 思考都进请求', async () => {
    const target = await stub({
      kind: 'stream',
      thinking: ['先', '想'],
      text: ['答', '案'],
      chunkDelayMs: 5,
      textDelayMs: 40
    })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    expect(
      service.start(
        { threadId: 'thread-1', streamId: 'stream-anthropic', messages: [userTurn] },
        send
      )
    ).toEqual({ accepted: true })
    await waitFor((current) => current.some((event) => event.type === 'done'))

    // 思维链整体先于正文；事件按抵达顺序归一，不掺入 pi 的其它事件。
    const types = events.map((event) => event.type)
    expect(types).toEqual(['thinking', 'thinking', 'text', 'text', 'done'])
    expect(events).toEqual([
      { type: 'thinking', text: '先' },
      { type: 'thinking', text: '想' },
      { type: 'text', text: '答' },
      { type: 'text', text: '案' },
      { type: 'done' }
    ])

    const request = target.requests[0]
    expect(request).toBeDefined()
    expect(pathOf(request?.url ?? '')).toBe('/v1/messages')
    // Anthropic Messages 用 x-api-key，不发 Bearer Authorization。
    expect(request?.headers['x-api-key']).toBe('sk-ant-synthetic-0001')
    expect(request?.headers.authorization).toBeUndefined()
    expect(request?.headers['anthropic-version']).toBe('2023-06-01')
    expect(request?.body).toMatchObject({
      model: 'claude-fable-5',
      stream: true,
      max_tokens: 128000,
      messages: [{ role: 'user' }],
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'high' }
    })
    // 用户消息被 pi 转成 Anthropic 的 content block 数组（带缓存标记），原文不丢。
    expect(JSON.stringify(request?.body.messages)).toContain('你好')
  })

  it('非思考模型不传 thinking / output_config，正文照常流式输出', async () => {
    const target = await stub({ kind: 'stream', text: ['普', '通'] })
    const descriptor = descriptorFor(target, {
      model: 'relay-plain-model',
      reasoning: false,
      compat: undefined,
      maxTokens: 64000
    })
    const service = createChatService({
      resolveConfig: () => ({
        apiKey: 'sk-ant-synthetic-0002',
        baseUrl: target.baseUrl,
        model: descriptor.model,
        descriptor
      })
    })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-plain', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(events).toEqual([
      { type: 'text', text: '普' },
      { type: 'text', text: '通' },
      { type: 'done' }
    ])
    const request = target.requests[0]
    expect(request?.body.model).toBe('relay-plain-model')
    expect(request?.body.thinking).toBeUndefined()
    expect(request?.body.output_config).toBeUndefined()
    expect(request?.headers['x-api-key']).toBe('sk-ant-synthetic-0002')
  })

  it('模型不支持 high 时降级到 low，并按 low 发思考预算', async () => {
    const target = await stub({ kind: 'stream', thinking: ['想'], text: ['答'] })
    const descriptor = descriptorFor(target, {
      model: 'MiniMax-M2.7',
      compat: undefined,
      // 只支持 off 与 low：medium 也不可用，才能证明降级选的是 low 而不是 medium。
      thinkingLevelMap: { high: null, medium: null, minimal: null, low: 'low' }
    })
    const service = createChatService({
      resolveConfig: () => ({
        apiKey: 'sk-ant-synthetic-0003',
        baseUrl: target.baseUrl,
        model: descriptor.model,
        descriptor
      })
    })
    const { send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-low', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'done'))

    const request = target.requests[0]
    // low = 2048；high 的 16384 不能出现。
    expect(request?.body.thinking).toMatchObject({ type: 'enabled', budget_tokens: 2048 })
    expect(request?.body.output_config).toBeUndefined()
  })

  it('停止会中断请求：已收到的思维链与正文保留，不再补 done 或 error', async () => {
    const target = await stub({ kind: 'hang', thinking: ['想'], text: ['半句'] })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-stop', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'text'))

    expect(service.stop('stream-stop')).toEqual({ stopped: true })
    await waitUntil(() => target.abortedConnections > 0)
    await new Promise((resolve) => setTimeout(resolve, 80))

    expect(events.filter((event) => event.type === 'thinking')).toEqual([
      { type: 'thinking', text: '想' }
    ])
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: '半句' }
    ])
    expect(events.some((event) => event.type === 'done' || event.type === 'error')).toBe(false)
    expect(service.stop('stream-stop')).toEqual({ stopped: false })
  })

  it.each([
    [401, 'invalid-key', 'AUTH'],
    [402, 'insufficient-balance', 'QUOTA'],
    [413, 'context-too-long', 'CONTEXT_WINDOW'],
    [429, 'rate-limited', 'RATE_LIMIT'],
    [500, 'server-busy', 'SERVER'],
    [503, 'server-busy', 'SERVER'],
    [400, 'unknown', 'INVALID_REQUEST']
  ] as const)('HTTP %i 归为 %s，保留稳定分类与状态码', async (status, code, kind) => {
    const target = await stub({
      kind: 'status',
      status,
      headers:
        status === 401
          ? { 'request-id': 'req-anthropic-401' }
          : status === 429
            ? { 'request-id': 'req-anthropic-429', 'retry-after': '3' }
            : {}
    })
    const service = createChatService({
      resolveConfig: () => configFor(target),
      retryTiming: fastRetry
    })
    const { events, send, waitFor } = collector()

    service.start(
      { threadId: 'thread-1', streamId: `stream-status-${status}`, messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'error'))

    const event = events.find((candidate) => candidate.type === 'error')
    expect(event).toMatchObject({ type: 'error', error: { code, kind, status } })
    if (status === 401) {
      expect(event).toMatchObject({ error: { requestId: 'req-anthropic-401' } })
    }
    if (status === 429) {
      expect(event).toMatchObject({
        error: { requestId: 'req-anthropic-429', retryAfterMs: 3000 }
      })
    }
    // 401/402/413 不重试；429/500/503 是临时错误，耗尽前共发 6 次。
    expect(target.requests).toHaveLength(
      code === 'rate-limited' || code === 'server-busy' ? 6 : 1
    )
  })

  it('service 层按 normal 重试 500 直到耗尽（6 次），低层仍是一次调用一次请求', async () => {
    const target = await stub({ kind: 'status', status: 500 })
    const service = createChatService({
      resolveConfig: () => configFor(target),
      retryTiming: fastRetry
    })
    const { send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-once', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    expect(target.requests).toHaveLength(6)
  })

  it('连不上服务时归为网络异常，稳定分类是 TRANSPORT 且没有状态码', async () => {
    const baseUrl = await unusedBaseUrl()
    const descriptor = descriptorFor({ baseUrl } as AnthropicStub, { baseUrl })
    const service = createChatService({
      resolveConfig: () => ({
        apiKey: 'sk-ant-synthetic-0004',
        baseUrl,
        model: descriptor.model,
        descriptor
      }),
      retryTiming: fastRetry
    })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-network', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    const event = events[0]
    expect(event).toMatchObject({ type: 'error', error: { code: 'network', kind: 'TRANSPORT' } })
    if (event?.type === 'error') {
      expect(event.error.status).toBeUndefined()
    }
  })

  it('成功响应但没有任何内容块时归为 EMPTY_RESPONSE，不假装 done', async () => {
    const target = await stub({ kind: 'stream' })
    const service = createChatService({
      resolveConfig: () => configFor(target),
      retryTiming: fastRetry
    })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-empty', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'empty-response',
          kind: 'EMPTY_RESPONSE',
          status: 200,
          detail: expect.any(String)
        }
      }
    ])
    expect(events.some((event) => event.type === 'done')).toBe(false)
  })

  it('流在 message_stop 之前结束时归为网络异常，已收到的内容保留', async () => {
    const target = await stub({ kind: 'end-early', thinking: ['想'], text: ['半句'] })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start(
      { threadId: 'thread-1', streamId: 'stream-end-early', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'error'))

    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'network', kind: 'TRANSPORT' }
    })
    expect(events.some((event) => event.type === 'done')).toBe(false)
    expect(events.filter((event) => event.type === 'text')).toHaveLength(1)
  })

  it('响应 200 之后连接断掉时归为网络异常，不假装生成完成', async () => {
    const target = await stub({ kind: 'truncate', thinking: ['想'], text: ['半句'] })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start(
      { threadId: 'thread-1', streamId: 'stream-truncate', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'error'))

    expect(events.find((event) => event.type === 'error')).toMatchObject({
      type: 'error',
      error: { code: 'network', kind: 'TRANSPORT' }
    })
    expect(events.some((event) => event.type === 'done')).toBe(false)
    expect(events.filter((event) => event.type === 'thinking')).toHaveLength(1)
  })
})

describe('Anthropic / MiniMax 内置入口与自定义协议', () => {
  let directory: string
  let database: AppDatabase

  const secrets: SecretStore = {
    encrypt: (plain) => `sealed:${plain}`,
    decrypt: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null)
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'english-learning-anthropic-'))
    database = openDatabase(join(directory, 'test.db'))
    migrate(database)
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  function addAndActivate(catalogProviderId: string, apiKey: string): string {
    const added = addBuiltinProvider(
      database,
      secrets,
      { catalogProviderId, apiKey },
      { now: '2026-11-21T00:00:00.000Z' }
    )
    if (added.status !== 'saved') throw new Error('没存上')
    activateModelProvider(database, added.providerId)
    return added.providerId
  }

  function pointAt(providerId: string, baseUrl: string): void {
    database
      .prepare('UPDATE model_provider SET base_url = ? WHERE id = ?')
      .run(baseUrl, providerId)
  }

  it('内置目录带出 Anthropic 与 MiniMax：协议、端点、模型与思考元数据都来自目录', () => {
    const anthropic = readBuiltinProviderSetup('anthropic')
    expect(anthropic).toMatchObject({
      displayName: 'Anthropic',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
      envVar: 'ANTHROPIC_API_KEY'
    })
    expect(anthropic?.models.length).toBeGreaterThan(0)
    expect(anthropic?.models[0]).toMatchObject({
      id: 'claude-fable-5',
      api: 'anthropic-messages',
      contextWindow: 1000000,
      maxTokens: 128000,
      reasoning: true
    })

    const minimax = readBuiltinProviderSetup('minimax')
    expect(minimax).toMatchObject({
      displayName: 'MiniMax',
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.minimax.io/anthropic',
      envVar: 'MINIMAX_API_KEY'
    })
    expect(minimax?.models.map((model) => model.id)).toEqual([
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M3',
      'MiniMax-M3.1-Flash'
    ])
    expect(minimax?.models[0]).toMatchObject({
      api: 'anthropic-messages',
      contextWindow: 204800,
      maxTokens: 131072,
      reasoning: true
    })
  })

  it('Anthropic Messages 已开放为自定义协议', () => {
    expect(isCustomProviderProtocol('anthropic-messages')).toBe(true)
  })

  it('Anthropic 内置 provider 用目录模型与自己的端点真发请求；换默认模型只影响之后的调用', async () => {
    const target = await stub({ kind: 'stream', thinking: ['想'], text: ['答'] })
    const providerId = addAndActivate('anthropic', 'sk-ant-synthetic-0005')
    pointAt(providerId, target.baseUrl)

    const config = resolveChatConfig(database, secrets, {})
    expect(config?.descriptor).toMatchObject({
      provider: 'anthropic',
      model: 'claude-fable-5',
      api: 'anthropic-messages',
      baseUrl: target.baseUrl,
      contextWindow: 1000000,
      maxTokens: 128000,
      reasoning: true
    })

    const service = createChatService({
      resolveConfig: () => resolveChatConfig(database, secrets, {})
    })
    const { events, send, waitFor } = collector()
    service.start(
      { threadId: 'thread-1', streamId: 'stream-anthropic-builtin', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(events.map((event) => event.type)).toEqual([
      'thinking',
      'text',
      'done'
    ])
    const first = target.requests[0]
    expect(pathOf(first?.url ?? '')).toBe('/v1/messages')
    expect(first?.headers['x-api-key']).toBe('sk-ant-synthetic-0005')
    expect(first?.body).toMatchObject({
      model: 'claude-fable-5',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' }
    })

    // 换默认模型：下一次请求才换，历史不受影响。
    const sonnet = readProviderModels(database, providerId).find(
      (model) => model.modelId === 'claude-sonnet-5'
    )!
    expect(setDefaultProviderModel(database, providerId, sonnet.id)).toMatchObject({
      status: 'saved'
    })
    service.start(
      { threadId: 'thread-1', streamId: 'stream-anthropic-sonnet', messages: [userTurn] },
      send
    )
    await waitFor(
      (current) => current.filter((event) => event.type === 'done').length === 2
    )
    expect(target.requests[1]?.body.model).toBe('claude-sonnet-5')
  })

  it('MiniMax 用 Anthropic 兼容端点，思考按 high 发预算，容量来自自己的目录', async () => {
    const target = await stub({ kind: 'stream', thinking: ['想'], text: ['答'] })
    const providerId = addAndActivate('minimax', 'sk-minimax-synthetic-0001')
    pointAt(providerId, `${target.baseUrl}/anthropic`)

    const config = resolveChatConfig(database, secrets, {})
    expect(config?.descriptor).toMatchObject({
      provider: 'minimax',
      model: 'MiniMax-M2.7',
      api: 'anthropic-messages',
      baseUrl: `${target.baseUrl}/anthropic`,
      contextWindow: 204800,
      maxTokens: 131072,
      reasoning: true
    })

    const service = createChatService({ resolveConfig: () => config })
    const { send, waitFor } = collector()
    service.start(
      { threadId: 'thread-1', streamId: 'stream-minimax', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'done'))

    const request = target.requests[0]
    expect(pathOf(request?.url ?? '')).toBe('/anthropic/v1/messages')
    expect(request?.headers['x-api-key']).toBe('sk-minimax-synthetic-0001')
    expect(request?.body).toMatchObject({
      model: 'MiniMax-M2.7',
      max_tokens: 131072,
      thinking: { type: 'enabled', budget_tokens: 16384 }
    })
  })

  it('自定义 anthropic-messages provider：模型行使用该协议，真实请求带 x-api-key', async () => {
    const target = await stub({ kind: 'stream', text: ['自定义中转可用。'] })
    const created = createCustomProvider(
      database,
      secrets,
      {
        providerKey: 'relay-anthropic',
        displayName: 'Anthropic 中转',
        protocol: 'anthropic-messages',
        baseUrl: target.baseUrl,
        authMode: 'stored',
        apiKey: 'sk-relay-synthetic-0001',
        model: { modelId: 'relay-anthropic-model' }
      },
      { now: '2026-11-21T00:00:00.000Z' }
    )
    if (created.status !== 'saved') throw new Error(`没存上：${created.reason}`)
    activateModelProvider(database, created.providerId)

    // 模型行的协议就是创建时选的协议，不靠 provider 行临时推。
    expect(readProviderModels(database, created.providerId)[0]).toMatchObject({
      modelId: 'relay-anthropic-model',
      api: 'anthropic-messages',
      reasoning: false
    })

    const service = createChatService({
      resolveConfig: () => resolveChatConfig(database, secrets, {})
    })
    const { events, send, waitFor } = collector()
    service.start(
      { threadId: 'thread-1', streamId: 'stream-custom-anthropic', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(events.at(-1)).toEqual({ type: 'done' })
    const request = target.requests[0]
    expect(pathOf(request?.url ?? '')).toBe('/v1/messages')
    expect(request?.headers['x-api-key']).toBe('sk-relay-synthetic-0001')
    expect(request?.body.model).toBe('relay-anthropic-model')
    // 目录里没有这个模型：没有思考能力，不传 thinking。
    expect(request?.body.thinking).toBeUndefined()
  })
})
