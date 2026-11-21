import { channel } from 'node:diagnostics_channel'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatStreamEvent } from '../../shared/chat'
import { findCatalogModel } from '../../shared/model-catalog'
import {
  startGeminiSseStub,
  type GeminiSseStub,
  type GeminiStubScript
} from '../../testing/gemini-sse-stub'
import { startSseStub, unusedBaseUrl, type SseStub } from '../../testing/sse-stub'
import { descriptorOfCatalogModel, type ChatModelDescriptor } from './model-descriptor'
import { streamChatCompletion } from './pi-stream'

const geminiStubs: GeminiSseStub[] = []
const openaiStubs: SseStub[] = []

afterEach(async () => {
  await Promise.all(geminiStubs.splice(0).map((stub) => stub.close()))
  await Promise.all(openaiStubs.splice(0).map((stub) => stub.close()))
})

async function stub(script: GeminiStubScript): Promise<GeminiSseStub> {
  const created = await startGeminiSseStub(script)
  geminiStubs.push(created)
  return created
}

async function openaiStub(script: Parameters<typeof startSseStub>[0]): Promise<SseStub> {
  const created = await startSseStub(script)
  openaiStubs.push(created)
  return created
}

/** 真实 Gemini 目录描述符，只把地址指到本地 stub；不手写模型元数据。 */
function descriptorAt(
  baseUrl: string,
  modelId = 'gemini-2.5-flash',
  patch: Partial<ChatModelDescriptor> = {}
): ChatModelDescriptor {
  const model = findCatalogModel('gemini', modelId)!
  return {
    ...descriptorOfCatalogModel(model, `${baseUrl}/v1beta`, 'gemini'),
    ...patch
  }
}

function descriptorFor(
  target: GeminiSseStub,
  patch: Partial<ChatModelDescriptor> = {}
): ChatModelDescriptor {
  return descriptorAt(target.baseUrl, patch.model ?? 'gemini-2.5-flash', patch)
}

const userTurn = { role: 'user' as const, content: '你好' }

async function collect(
  descriptor: ChatModelDescriptor,
  options: { apiKey?: string; signal?: AbortSignal } = {}
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = []
  await streamChatCompletion({
    apiKey: options.apiKey ?? 'synthetic-gemini-key',
    descriptor,
    messages: [userTurn],
    systemPrompt: '用中文简短回答。',
    signal: options.signal ?? new AbortController().signal,
    onEvent: (event) => events.push(event)
  })
  return events
}

function errorOf(events: readonly ChatStreamEvent[]) {
  const event = events.find((candidate) => candidate.type === 'error')
  if (event?.type !== 'error') throw new Error('没有错误事件')
  return event.error
}

describe('Gemini API 流式请求', () => {
  it('思维链先、正文后；端点、鉴权头与 thinkingConfig 都按 Gemini 协议发', async () => {
    const target = await stub({
      kind: 'stream',
      thinking: ['先', '想'],
      text: ['答', '案'],
      textDelayMs: 20
    })

    const events = await collect(descriptorFor(target))

    expect(events).toEqual([
      { type: 'thinking', text: '先' },
      { type: 'thinking', text: '想' },
      { type: 'text', text: '答' },
      { type: 'text', text: '案' },
      { type: 'done' }
    ])

    expect(target.requests).toHaveLength(1)
    const request = target.requests[0]!
    expect(request.method).toBe('POST')
    expect(request.url).toBe(
      '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'
    )
    // Gemini 用 x-goog-api-key，不是 Bearer；模型在 URL 里，不在 body 里。
    expect(request.headers['x-goog-api-key']).toBe('synthetic-gemini-key')
    expect(request.headers.authorization).toBeUndefined()
    expect(request.body).toMatchObject({
      generationConfig: {
        maxOutputTokens: 65536,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 }
      },
      contents: [{ role: 'user', parts: [{ text: '你好' }] }]
    })
    expect(request.body.systemInstruction).toMatchObject({
      parts: [{ text: '用中文简短回答。' }]
    })
    expect(request.body.model).toBeUndefined()
  })

  it('SSE 一行被网络拆成两段时仍归并成同一条事件', async () => {
    const target = await stub({
      kind: 'stream',
      thinking: ['想'],
      text: ['答'],
      fragmentChunks: true
    })

    const events = await collect(descriptorFor(target))

    expect(events).toEqual([
      { type: 'thinking', text: '想' },
      { type: 'text', text: '答' },
      { type: 'done' }
    ])
  })

  it('Gemini 3 用离散 thinkingLevel 档位，而不是 token 预算', async () => {
    const target = await stub({ kind: 'stream', text: ['答'] })

    const events = await collect(descriptorFor(target, { model: 'gemini-3-flash-preview' }))

    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(target.requests[0]?.url).toBe(
      '/v1beta/models/gemini-3-flash-preview:streamGenerateContent?alt=sse'
    )
    expect(target.requests[0]?.body).toMatchObject({
      generationConfig: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' }
      }
    })
  })

  it('不支持思考的模型不发 thinkingConfig，也不产生思维链事件', async () => {
    const target = await stub({ kind: 'stream', text: ['普通回答'] })
    const descriptor: ChatModelDescriptor = {
      ...descriptorFor(target),
      model: 'relay-text-model',
      reasoning: false,
      thinkingLevelMap: undefined
    }

    const events = await collect(descriptor)

    expect(events).toEqual([{ type: 'text', text: '普通回答' }, { type: 'done' }])
    const config = target.requests[0]?.body.generationConfig as Record<string, unknown>
    expect(config).toBeDefined()
    expect(config.thinkingConfig).toBeUndefined()
  })

  it('high 不在能力表时降一档：medium 的模型按 medium 预算请求', async () => {
    const target = await stub({ kind: 'stream', thinking: ['想'], text: ['答'] })
    const descriptor: ChatModelDescriptor = {
      ...descriptorFor(target),
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: 'medium',
        high: null,
        xhigh: null,
        max: null
      }
    }

    await collect(descriptor)

    // gemini-2.5-flash 的 medium 预算是 8192；不是 high 的 24576。
    expect(target.requests[0]?.body).toMatchObject({
      generationConfig: { thinkingConfig: { includeThoughts: true, thinkingBudget: 8192 } }
    })
  })

  it('停止会中断 Gemini 请求，已收到的内容保留，且不再补发 done 或 error', async () => {
    const target = await stub({ kind: 'hang', thinking: ['想'], text: ['半句'] })
    const controller = new AbortController()
    const events: ChatStreamEvent[] = []

    const running = streamChatCompletion({
      apiKey: 'synthetic-gemini-key',
      descriptor: descriptorFor(target),
      messages: [userTurn],
      signal: controller.signal,
      onEvent: (event) => events.push(event)
    })
    await waitUntil(() => events.some((event) => event.type === 'text'))
    expect(events.filter((event) => event.type === 'thinking')).toEqual([
      { type: 'thinking', text: '想' }
    ])

    controller.abort()
    await running
    await waitUntil(() => target.abortedConnections > 0)

    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: '半句' }
    ])
    expect(events.some((event) => event.type === 'done' || event.type === 'error')).toBe(false)
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
    const target = await stub({ kind: 'status', status })

    const events = await collect(descriptorFor(target))

    expect(errorOf(events)).toMatchObject({ code, kind, status })
    expect(events.some((event) => event.type === 'done')).toBe(false)
  })

  it('request id 只从响应头来，Retry-After 一并捕获', async () => {
    const target = await stub({
      kind: 'status',
      status: 429,
      headers: { 'x-goog-request-id': 'req-gemini-429', 'retry-after': '3' }
    })

    const events = await collect(descriptorFor(target))

    expect(errorOf(events)).toMatchObject({
      code: 'rate-limited',
      kind: 'RATE_LIMIT',
      status: 429,
      requestId: 'req-gemini-429',
      retryAfterMs: 3000
    })
  })

  it('连不上 Gemini 端点时归为网络异常，不伪造状态码', async () => {
    const baseUrl = await unusedBaseUrl()

    const events = await collect(descriptorAt(baseUrl))

    const error = errorOf(events)
    expect(error).toMatchObject({ code: 'network', kind: 'TRANSPORT' })
    expect(error.status).toBeUndefined()
  })

  it('失败的一次调用只发一次请求，maxRetries 为 0', async () => {
    const target = await stub({ kind: 'status', status: 500 })

    await collect(descriptorFor(target))
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(target.requests).toHaveLength(1)
  })

  it('200 之后连接断掉时归为网络异常，不假装生成完成', async () => {
    const target = await stub({ kind: 'truncate', thinking: ['想'], text: ['半句'] })

    const events = await collect(descriptorFor(target))

    expect(errorOf(events)).toMatchObject({ code: 'network', kind: 'TRANSPORT' })
    expect(events.some((event) => event.type === 'done')).toBe(false)
    expect(events.filter((event) => event.type === 'thinking')).toHaveLength(1)
  })

  it('流在 finishReason 之前结束时归为网络异常，不假装生成完成', async () => {
    const target = await stub({ kind: 'end-early', thinking: ['想'], text: ['半句'] })

    const events = await collect(descriptorFor(target))

    expect(errorOf(events)).toMatchObject({ code: 'network' })
    expect(events.some((event) => event.type === 'done')).toBe(false)
  })

  it('成功响应但一个内容块都没有时归为 EMPTY_RESPONSE，不假装 done', async () => {
    const target = await stub({ kind: 'stream', thinking: [], text: [] })

    const events = await collect(descriptorFor(target))

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
  })
})

describe('Gemini 并发与请求归属', () => {
  it('同一 baseUrl 并发两个 Gemini 流：401 与 429 各归各的 capture 与 request id', async () => {
    const target = await stub({
      kind: 'per-model',
      scripts: {
        'gemini-2.5-flash': {
          kind: 'status',
          status: 401,
          headers: { 'x-goog-request-id': 'req-flash-401' }
        },
        'gemini-2.5-pro': {
          kind: 'status',
          status: 429,
          headers: { 'x-goog-request-id': 'req-pro-429', 'retry-after': '2' }
        }
      }
    })

    const [flash, pro] = await Promise.all([
      collect(descriptorAt(target.baseUrl, 'gemini-2.5-flash')),
      collect(descriptorAt(target.baseUrl, 'gemini-2.5-pro'))
    ])

    expect(errorOf(flash)).toMatchObject({
      kind: 'AUTH',
      status: 401,
      requestId: 'req-flash-401'
    })
    expect(errorOf(pro)).toMatchObject({
      kind: 'RATE_LIMIT',
      status: 429,
      requestId: 'req-pro-429',
      retryAfterMs: 2000
    })
    expect(target.requests).toHaveLength(2)
  })

  it('同 baseUrl 并发：后启动的先结束，不吞掉另一个流的事件', async () => {
    const target = await stub({
      kind: 'per-model',
      scripts: {
        'gemini-2.5-flash': {
          kind: 'stream',
          thinking: ['甲思'],
          text: ['甲答'],
          firstChunkDelayMs: 120,
          chunkDelayMs: 10
        },
        'gemini-2.5-pro': {
          kind: 'stream',
          thinking: ['乙思'],
          text: ['乙答'],
          chunkDelayMs: 1
        }
      }
    })

    const finished: string[] = []
    const flash = collect(descriptorAt(target.baseUrl, 'gemini-2.5-flash')).then(
      (events) => {
        finished.push('flash')
        return events
      }
    )
    const pro = collect(descriptorAt(target.baseUrl, 'gemini-2.5-pro')).then((events) => {
      finished.push('pro')
      return events
    })
    const [flashEvents, proEvents] = await Promise.all([flash, pro])

    expect(finished[0]).toBe('pro')
    expect(flashEvents).toEqual([
      { type: 'thinking', text: '甲思' },
      { type: 'text', text: '甲答' },
      { type: 'done' }
    ])
    expect(proEvents).toEqual([
      { type: 'thinking', text: '乙思' },
      { type: 'text', text: '乙答' },
      { type: 'done' }
    ])
  })

  it('同 baseUrl 并发：先启动的先结束，两个流的事件仍各归各的', async () => {
    const target = await stub({
      kind: 'per-model',
      scripts: {
        'gemini-2.5-flash': {
          kind: 'stream',
          thinking: ['甲思'],
          text: ['甲答'],
          chunkDelayMs: 1
        },
        'gemini-2.5-pro': {
          kind: 'stream',
          thinking: ['乙思'],
          text: ['乙答'],
          firstChunkDelayMs: 120,
          chunkDelayMs: 10
        }
      }
    })

    const finished: string[] = []
    const flash = collect(descriptorAt(target.baseUrl, 'gemini-2.5-flash')).then(
      (events) => {
        finished.push('flash')
        return events
      }
    )
    const pro = collect(descriptorAt(target.baseUrl, 'gemini-2.5-pro')).then((events) => {
      finished.push('pro')
      return events
    })
    const [flashEvents, proEvents] = await Promise.all([flash, pro])

    expect(finished[0]).toBe('flash')
    expect(flashEvents).toEqual([
      { type: 'thinking', text: '甲思' },
      { type: 'text', text: '甲答' },
      { type: 'done' }
    ])
    expect(proEvents).toEqual([
      { type: 'thinking', text: '乙思' },
      { type: 'text', text: '乙答' },
      { type: 'done' }
    ])
  })

  it('Gemini 与 OpenAI Chat Completions 并发：各用各的捕获，互不污染状态与 request id', async () => {
    const gemini = await stub({ kind: 'stream', thinking: ['想'], text: ['Gemini 答'] })
    const openai = await openaiStub({
      kind: 'status',
      status: 401,
      headers: { 'x-request-id': 'req-openai-401' }
    })

    const openaiEvents: ChatStreamEvent[] = []
    const [geminiEvents] = await Promise.all([
      collect(descriptorFor(gemini)),
      streamChatCompletion({
        apiKey: 'synthetic-openai-key',
        descriptor: {
          provider: 'deepseek',
          model: 'deepseek-flash',
          api: 'openai-completions',
          baseUrl: openai.baseUrl,
          contextWindow: 1000000,
          maxTokens: 384000,
          input: ['text'],
          reasoning: false
        },
        messages: [userTurn],
        signal: new AbortController().signal,
        onEvent: (event) => openaiEvents.push(event)
      })
    ])

    expect(geminiEvents).toEqual([
      { type: 'thinking', text: '想' },
      { type: 'text', text: 'Gemini 答' },
      { type: 'done' }
    ])
    expect(errorOf(openaiEvents)).toMatchObject({
      kind: 'AUTH',
      status: 401,
      requestId: 'req-openai-401'
    })
  })

  it('所有 Gemini scope 结束后取消诊断通道订阅，不残留监听', async () => {
    expect(channel('undici:request:create').hasSubscribers).toBe(false)
    expect(channel('undici:request:headers').hasSubscribers).toBe(false)
    expect(channel('undici:request:error').hasSubscribers).toBe(false)
  })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('等待条件超时')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
