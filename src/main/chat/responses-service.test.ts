import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatStreamEvent, ChatStreamUpdate } from '../../shared/chat'
import {
  startResponsesStub,
  type ResponsesStub,
  type ResponsesStubScript
} from '../../testing/responses-sse-stub'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import {
  activateModelProvider,
  addBuiltinProvider,
  setDefaultProviderModel
} from '../settings/provider-writes'
import { createCustomProvider } from '../settings/provider-editing'
import { readProviderModels } from '../settings/providers'
import type { SecretStore } from '../settings/secret-store'
import { resolveChatConfig } from './config'
import { createChatService } from './service'

/**
 * #67 OpenAI Responses 的真实链路测试：不 mock pi 流，只把 HTTP 端点换成
 * 本地 Responses SSE stub，让 pi 真正解析 `response.created` /
 * `output_item.added` / `reasoning_summary_text.delta` / `output_text.delta` /
 * `response.completed`。全部密钥为合成值。
 */

const stubs: ResponsesStub[] = []

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function stub(script: ResponsesStubScript): Promise<ResponsesStub> {
  const created = await startResponsesStub(script)
  stubs.push(created)
  return created
}

const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${plain}`,
  decrypt: (sealed) =>
    sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null
}

type Collector = {
  events: ChatStreamEvent[]
  send: (update: ChatStreamUpdate) => void
  waitFor: (
    predicate: (events: readonly ChatStreamEvent[]) => boolean,
    timeoutMs?: number
  ) => Promise<void>
}

function collector(): Collector {
  const events: ChatStreamEvent[] = []
  return {
    events,
    send: (update) => events.push(update.event),
    waitFor: (predicate, timeoutMs = 4000) =>
      waitUntil(() => predicate(events), timeoutMs)
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('等待事件超时')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const userTurn = { role: 'user' as const, content: '你好' }

describe('OpenAI Responses 协议', () => {
  let directory: string
  let database: AppDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'english-learning-responses-'))
    database = openDatabase(join(directory, 'test.db'))
    migrate(database)
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  function addAndActivate(
    catalogProviderId: 'openai' | 'xai',
    baseUrl: string,
    apiKey: string
  ): string {
    const added = addBuiltinProvider(
      database,
      secrets,
      { catalogProviderId, apiKey },
      { now: '2026-11-21T00:00:00.000Z' }
    )
    if (added.status !== 'saved') {
      throw new Error('内置 provider 没存上')
    }
    database
      .prepare('UPDATE model_provider SET base_url = ? WHERE id = ?')
      .run(baseUrl, added.providerId)
    activateModelProvider(database, added.providerId)
    return added.providerId
  }

  function service(): ReturnType<typeof createChatService> {
    return createChatService({
      resolveConfig: () => resolveChatConfig(database, secrets, {})
    })
  }

  it.each([
    ['openai', 'chat-latest', 'gpt-5', 'sk-synthetic-openai'],
    ['xai', 'grok-4.3', 'grok-4.5', 'sk-synthetic-xai']
  ] as const)(
    '%s：目录默认模型走 /responses，思考先到、正文后到；换默认模型只影响下一次',
    async (catalogId, defaultModel, nextModel, apiKey) => {
      const target = await stub({
        kind: 'stream',
        thinking: ['先', '想'],
        text: ['答', '案'],
        textDelayMs: 20
      })
      const providerId = addAndActivate(catalogId, `${target.baseUrl}/v1`, apiKey)
      const config = resolveChatConfig(database, secrets, {})
      expect(config?.descriptor).toMatchObject({
        provider: catalogId,
        model: defaultModel,
        api: 'openai-responses',
        baseUrl: `${target.baseUrl}/v1`,
        reasoning: true
      })

      const chat = service()
      const { events, send, waitFor } = collector()
      chat.start(
        { threadId: 'thread-1', streamId: 'stream-responses-1', messages: [userTurn] },
        send
      )
      await waitFor((current) => current.some((event) => event.type === 'done'))

      expect(events).toEqual([
        { type: 'thinking', text: '先' },
        { type: 'thinking', text: '想' },
        { type: 'text', text: '答' },
        { type: 'text', text: '案' },
        { type: 'done' }
      ])

      const request = target.requests[0]
      expect(request?.url).toBe('/v1/responses')
      expect(request?.headers.authorization).toBe(`Bearer ${apiKey}`)
      expect(request?.body).toMatchObject({
        model: defaultModel,
        stream: true,
        store: false,
        input: [
          { role: 'user', content: [{ type: 'input_text', text: '你好' }] }
        ],
        reasoning: { effort: 'high', summary: 'auto' }
      })
      expect(request?.body.include).toContain('reasoning.encrypted_content')
      // Responses 请求没有 Chat Completions 的 messages / thinking 字段。
      expect(request?.body.messages).toBeUndefined()
      expect(request?.body.thinking).toBeUndefined()

      // 换默认模型：下一次调用才换，前面已经发出的请求不改。
      const model = readProviderModels(database, providerId).find(
        (candidate) => candidate.modelId === nextModel
      )
      expect(model).toBeDefined()
      expect(
        setDefaultProviderModel(database, providerId, model!.id)
      ).toMatchObject({ status: 'saved' })

      chat.start(
        { threadId: 'thread-1', streamId: 'stream-responses-2', messages: [userTurn] },
        send
      )
      await waitFor(
        (current) => current.filter((event) => event.type === 'done').length === 2
      )

      expect(target.requests).toHaveLength(2)
      expect(target.requests[0]?.body.model).toBe(defaultModel)
      expect(target.requests[1]?.body.model).toBe(nextModel)
    }
  )

  it('普通不支持思考的模型不带 reasoning 字段，也没有思维链事件', async () => {
    const target = await stub({ kind: 'stream', text: ['答案'] })
    const providerId = addAndActivate('openai', `${target.baseUrl}/v1`, 'sk-synthetic-openai')
    const plain = readProviderModels(database, providerId).find(
      (model) => model.modelId === 'gpt-4.1'
    )
    expect(plain).toMatchObject({ api: 'openai-responses', reasoning: false })
    expect(
      setDefaultProviderModel(database, providerId, plain!.id)
    ).toMatchObject({ status: 'saved' })

    const config = resolveChatConfig(database, secrets, {})
    expect(config?.descriptor).toMatchObject({
      model: 'gpt-4.1',
      api: 'openai-responses',
      reasoning: false
    })

    const chat = service()
    const { events, send, waitFor } = collector()
    chat.start(
      { threadId: 'thread-1', streamId: 'stream-responses-plain', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(events).toEqual([{ type: 'text', text: '答案' }, { type: 'done' }])
    const body = target.requests[0]?.body
    expect(body).toMatchObject({ model: 'gpt-4.1', stream: true })
    expect(body?.reasoning).toBeUndefined()
    expect(body?.thinking).toBeUndefined()
  })

  it('自定义 provider 选 OpenAI Responses：模型行按该协议发送；high 不支持时降级到 medium', async () => {
    const target = await stub({
      kind: 'stream',
      thinking: ['降级', '思考'],
      text: ['回答']
    })
    const created = createCustomProvider(database, secrets, {
      providerKey: 'responses-relay',
      displayName: 'Responses 中转',
      protocol: 'openai-responses',
      baseUrl: `${target.baseUrl}/v1`,
      authMode: 'stored',
      apiKey: 'sk-synthetic-relay',
      model: { modelId: 'custom-reasoner' }
    })
    expect(created.status).toBe('saved')
    if (created.status !== 'saved') return

    // 自定义模型可以只有 medium：默认 high 必须按真实能力表降一档。
    database
      .prepare(
        `UPDATE model_provider_model
            SET reasoning = 1, thinking_level_map = ?
          WHERE provider_id = ? AND model_id = 'custom-reasoner'`
      )
      .run(
        JSON.stringify({
          off: null,
          minimal: null,
          low: null,
          medium: 'medium',
          high: null
        }),
        created.providerId
      )
    activateModelProvider(database, created.providerId)

    const config = resolveChatConfig(database, secrets, {})
    expect(config?.descriptor).toMatchObject({
      provider: 'responses-relay',
      model: 'custom-reasoner',
      api: 'openai-responses',
      reasoning: true
    })

    const chat = service()
    const { events, send, waitFor } = collector()
    chat.start(
      { threadId: 'thread-1', streamId: 'stream-responses-custom', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(events).toEqual([
      { type: 'thinking', text: '降级' },
      { type: 'thinking', text: '思考' },
      { type: 'text', text: '回答' },
      { type: 'done' }
    ])
    expect(target.requests[0]?.url).toBe('/v1/responses')
    expect(target.requests[0]?.headers.authorization).toBe('Bearer sk-synthetic-relay')
    expect(target.requests[0]?.body).toMatchObject({
      model: 'custom-reasoner',
      reasoning: { effort: 'medium', summary: 'auto' }
    })
  })

  it.each([
    [401, 'AUTH', 'invalid-key'],
    [402, 'QUOTA', 'insufficient-balance'],
    [413, 'CONTEXT_WINDOW', 'context-too-long'],
    [429, 'RATE_LIMIT', 'rate-limited'],
    [500, 'SERVER', 'server-busy'],
    [503, 'SERVER', 'server-busy']
  ] as const)(
    'HTTP %i 归为 %s，保留 request id 且只发一次请求',
    async (status, kind, code) => {
      const target = await stub({
        kind: 'status',
        status,
        headers: { 'x-request-id': `req-responses-${status}` }
      })
      addAndActivate('openai', `${target.baseUrl}/v1`, 'sk-synthetic-openai')
      const chat = service()
      const { events, send, waitFor } = collector()

      chat.start(
        { threadId: 'thread-1', streamId: `stream-responses-${status}`, messages: [userTurn] },
        send
      )
      await waitFor((current) => current.some((event) => event.type === 'error'))

      expect(events[0]).toMatchObject({
        type: 'error',
        error: {
          kind,
          code,
          status,
          requestId: `req-responses-${status}`
        }
      })
      expect(events.some((event) => event.type === 'done')).toBe(false)
      // maxRetries: 0：失败一次不偷偷重发。
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(target.requests).toHaveLength(1)
    }
  )

  it('连不上 Responses 端点时归为网络异常，且没有状态码', async () => {
    const target = await stub({ kind: 'stream', text: ['不该出现'] })
    addAndActivate('openai', 'http://127.0.0.1:1', 'sk-synthetic-openai')
    const chat = service()
    const { events, send, waitFor } = collector()

    chat.start(
      { threadId: 'thread-1', streamId: 'stream-responses-network', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'error'))

    expect(events).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({ kind: 'TRANSPORT', code: 'network' })
      }
    ])
    if (events[0]?.type === 'error') {
      expect(events[0].error.status).toBeUndefined()
    }
    expect(target.requests).toHaveLength(0)
  })

  it('停止会中断 Responses 流，保留已收到的思维链与正文，不再补 done / error', async () => {
    const target = await stub({
      kind: 'hang',
      thinking: ['想'],
      text: ['半句']
    })
    addAndActivate('openai', `${target.baseUrl}/v1`, 'sk-synthetic-openai')
    const chat = service()
    const { events, send, waitFor } = collector()

    chat.start(
      { threadId: 'thread-1', streamId: 'stream-responses-stop', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'text'))

    expect(chat.stop('stream-responses-stop')).toEqual({ stopped: true })
    await waitUntil(() => target.abortedConnections > 0)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(events.filter((event) => event.type === 'thinking')).toEqual([
      { type: 'thinking', text: '想' }
    ])
    expect(events.filter((event) => event.type === 'text')).toEqual([
      { type: 'text', text: '半句' }
    ])
    expect(events.some((event) => event.type === 'done' || event.type === 'error')).toBe(
      false
    )
  })

  it('200 但没有内容也没有终止事件时不假装完成', async () => {
    const target = await stub({ kind: 'end-early' })
    addAndActivate('openai', `${target.baseUrl}/v1`, 'sk-synthetic-openai')
    const chat = service()
    const { events, send, waitFor } = collector()

    chat.start(
      { threadId: 'thread-1', streamId: 'stream-responses-early', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'error'))

    expect(events.some((event) => event.type === 'done')).toBe(false)
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { kind: 'TRANSPORT', code: 'network' }
    })
  })

  it('正常完成但没有任何内容块时归为 EMPTY_RESPONSE', async () => {
    const target = await stub({ kind: 'stream', text: [] })
    addAndActivate('openai', `${target.baseUrl}/v1`, 'sk-synthetic-openai')
    const chat = service()
    const { events, send, waitFor } = collector()

    chat.start(
      { threadId: 'thread-1', streamId: 'stream-responses-empty', messages: [userTurn] },
      send
    )
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
  })
})
