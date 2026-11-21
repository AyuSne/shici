import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatStreamEvent, ChatStreamUpdate } from '../../shared/chat'
import { findCatalogModel, type ModelProtocol } from '../../shared/model-catalog'
import {
  startAnthropicStub,
  type AnthropicStub,
  type AnthropicStubScript
} from '../../testing/anthropic-sse-stub'
import {
  startGeminiSseStub,
  type GeminiSseStub,
  type GeminiStubScript
} from '../../testing/gemini-sse-stub'
import {
  startResponsesStub,
  type ResponsesStub,
  type ResponsesStubScript
} from '../../testing/responses-sse-stub'
import { startSseStub, type SseStub, type StubScript } from '../../testing/sse-stub'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import {
  activateModelProvider,
  addBuiltinProvider,
  setDefaultProviderModel
} from '../settings/provider-writes'
import { listModelProviders, readProviderModels } from '../settings/providers'
import type { SecretStore } from '../settings/secret-store'
import { resolveChatConfig } from './config'
import { loadOpenCodeGoProvider } from './opencode-go'
import { piModelOf, piRuntimeProviderId } from './pi-model'
import { createChatService } from './service'

/**
 * #70 OpenCode GO 的真实链路测试：不 mock pi，把聚合目录里的模型地址指到
 * 本地四种协议 stub，让 pi 的**内置 opencode-go Provider** 真正按
 * `model.api` 分派；请求里的密钥一律用合成值，测试不联网。
 *
 * 覆盖：四协议分派、逐模型地址优先、请求级密钥、正文/思维链/错误、
 * 两套 GO 的密钥隔离、停止保留已输出、缺密钥不发请求、不支持 high 时降级。
 */

type AnyStub = SseStub | AnthropicStub | GeminiSseStub | ResponsesStub

const stubs: AnyStub[] = []

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${plain}`,
  decrypt: (sealed) =>
    sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null
}

type Collector = {
  events: ChatStreamEvent[]
  send: (update: ChatStreamUpdate) => void
  waitFor: (predicate: (events: readonly ChatStreamEvent[]) => boolean) => Promise<void>
}

function collector(): Collector {
  const events: ChatStreamEvent[] = []
  return {
    events,
    send: (update) => events.push(update.event),
    waitFor: (predicate) => waitUntil(() => predicate(events))
  }
}

const userTurn = { role: 'user' as const, content: '你好' }

describe('OpenCode GO 的内置 Provider', () => {
  it('直接复用 pi 的 opencodeGoProvider 对象：同一个对象、id 与 32 个模型', async () => {
    const first = await loadOpenCodeGoProvider()
    const second = await loadOpenCodeGoProvider()

    // 复用同一个 Provider 对象，而不是每次按协议重造一套。
    expect(second).toBe(first)
    expect(first.id).toBe('opencode-go')
    expect(first.name).toBe('OpenCode Go')
    expect(first.getModels()).toHaveLength(32)
    expect(new Set(first.getModels().map((model) => model.api))).toEqual(
      new Set([
        'openai-completions',
        'openai-responses',
        'anthropic-messages',
        'google-generative-ai'
      ])
    )
  })
})

describe('OpenCode GO 聚合入口', () => {
  let directory: string
  let database: AppDatabase

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'english-learning-opencode-go-'))
    database = openDatabase(join(directory, 'test.db'))
    migrate(database)
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  function addGo(apiKey = 'sk-go-synthetic-0001', envVar?: string): string {
    const added = addBuiltinProvider(
      database,
      secrets,
      envVar === undefined
        ? { catalogProviderId: 'opencode-go', apiKey }
        : { catalogProviderId: 'opencode-go', authMode: 'env', envVar },
      { now: '2026-11-21T00:00:00.000Z' }
    )
    if (added.status !== 'saved') {
      throw new Error(`GO 没存上：${JSON.stringify(added)}`)
    }
    return added.providerId
  }

  function setDefault(providerId: string, modelId: string): void {
    const row = readProviderModels(database, providerId).find(
      (model) => model.modelId === modelId
    )
    if (row === undefined) throw new Error(`GO 目录里没有 ${modelId}`)
    expect(setDefaultProviderModel(database, providerId, row.id)).toMatchObject({
      status: 'saved'
    })
  }

  /**
   * 只改模型行的地址，模拟用户把某条模型指到本地服务；provider 的统一地址
   * 故意指向不可达地址，任何「用单地址覆盖模型地址」的实现都会在这里断掉。
   */
  function pointModelsAt(
    providerId: string,
    protocol: ModelProtocol,
    baseUrl: string
  ): void {
    database
      .prepare(
        `UPDATE model_provider_model SET base_url = ?
          WHERE provider_id = ? AND api = ?`
      )
      .run(baseUrl, providerId, protocol)
    database
      .prepare('UPDATE model_provider SET base_url = ? WHERE id = ?')
      .run('http://127.0.0.1:1', providerId)
  }

  function service() {
    return createChatService({
      resolveConfig: () => resolveChatConfig(database, secrets, {})
    })
  }

  type ProtocolCase = {
    protocol: ModelProtocol
    modelId: string
    stubPath: string
    urlOf: (stub: AnyStub) => string
    authHeader: (request: { headers: Record<string, string | string[] | undefined> }) => void
  }

  const cases: ProtocolCase[] = [
    {
      protocol: 'openai-completions',
      modelId: 'beam-free',
      stubPath: '/chat/completions',
      urlOf: (stub) => stub.baseUrl,
      authHeader: (request) => {
        expect(request.headers.authorization).toBe('Bearer sk-go-synthetic-0001')
      }
    },
    {
      protocol: 'openai-responses',
      modelId: 'gpt-5.6-luna',
      stubPath: '/v1/responses',
      urlOf: (stub) => `${stub.baseUrl}/v1`,
      authHeader: (request) => {
        expect(request.headers.authorization).toBe('Bearer sk-go-synthetic-0001')
      }
    },
    {
      protocol: 'anthropic-messages',
      modelId: 'claude-haiku-5-5',
      stubPath: '/v1/messages',
      urlOf: (stub) => stub.baseUrl,
      authHeader: (request) => {
        expect(request.headers['x-api-key']).toBe('sk-go-synthetic-0001')
        expect(request.headers.authorization).toBeUndefined()
      }
    },
    {
      protocol: 'google-generative-ai',
      modelId: 'gemini-4-argon',
      stubPath: `/v1beta/models/gemini-4-argon:streamGenerateContent`,
      urlOf: (stub) => `${stub.baseUrl}/v1beta`,
      authHeader: (request) => {
        expect(request.headers['x-goog-api-key']).toBe('sk-go-synthetic-0001')
      }
    }
  ]

  it.each(cases)(
    '$protocol：按模型 api 分派、模型地址优先、请求级密钥、正文与思维链、401 保留 request id',
    async (testCase) => {
      const script = {
        kind: 'stream' as const,
        thinking: ['先', '想'],
        text: ['答', '案'],
        textDelayMs: 10
      }
      let stub: AnyStub
      if (testCase.protocol === 'openai-completions') {
        stub = await startSseStub(script satisfies StubScript)
      } else if (testCase.protocol === 'openai-responses') {
        stub = await startResponsesStub(script satisfies ResponsesStubScript)
      } else if (testCase.protocol === 'anthropic-messages') {
        stub = await startAnthropicStub(script satisfies AnthropicStubScript)
      } else {
        stub = await startGeminiSseStub(script satisfies GeminiStubScript)
      }
      stubs.push(stub)

      const providerId = addGo()
      pointModelsAt(providerId, testCase.protocol, testCase.urlOf(stub))
      activateModelProvider(database, providerId)
      setDefault(providerId, testCase.modelId)

      const config = resolveChatConfig(database, secrets, {})
      expect(config?.descriptor).toMatchObject({
        provider: 'opencode-go',
        catalogProviderId: 'opencode-go',
        model: testCase.modelId,
        api: testCase.protocol,
        // 模型地址优先：provider 的统一地址是不可达的占位。
        baseUrl: testCase.urlOf(stub)
      })
      // 能力查询与真实请求看到同一个 pi 模型：运行时 provider 是内置聚合 id。
      expect(piRuntimeProviderId(config!.descriptor)).toBe('opencode-go')
      expect(piModelOf(config!.descriptor)).toMatchObject({
        provider: 'opencode-go',
        api: testCase.protocol,
        baseUrl: testCase.urlOf(stub)
      })

      const chat = service()
      const { events, send, waitFor } = collector()
      chat.start(
        { threadId: 'thread-1', streamId: `stream-go-${testCase.protocol}`, messages: [userTurn] },
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

      const typed = stub as {
        requests: { url: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[]
      }
      expect(typed.requests).toHaveLength(1)
      const request = typed.requests[0]!
      expect(request.url.split('?')[0]).toBe(testCase.stubPath)
      testCase.authHeader(request)
      if (testCase.protocol === 'google-generative-ai') {
        // Gemini 把模型放在 URL 里，请求体没有 model 字段。
        expect(request.url).toContain(`/models/${testCase.modelId}:`)
        expect(request.body).not.toHaveProperty('model')
        expect(request.body).toMatchObject({ contents: [{ role: 'user' }] })
      } else {
        expect(request.body).toMatchObject({ model: testCase.modelId })
      }
      // 模型元数据与目录一致：GO 的 32 个模型都支持思考，high 可用。
      expect(findCatalogModel('opencode-go', testCase.modelId)?.reasoning).toBe(true)

      // 同一条模型再发一次得到 401：稳定分类、request id 与 maxRetries: 0。
      if (testCase.protocol === 'openai-completions') {
        ;(stub as SseStub).setScript({
          kind: 'status',
          status: 401,
          headers: { 'x-request-id': 'req-go-401' }
        })
      } else if (testCase.protocol === 'openai-responses') {
        ;(stub as ResponsesStub).setScript({
          kind: 'status',
          status: 401,
          headers: { 'x-request-id': 'req-go-401' }
        })
      } else if (testCase.protocol === 'anthropic-messages') {
        ;(stub as AnthropicStub).setScript({
          kind: 'status',
          status: 401,
          headers: { 'x-request-id': 'req-go-401' }
        })
      } else {
        ;(stub as GeminiSseStub).setScript({
          kind: 'status',
          status: 401,
          headers: { 'x-request-id': 'req-go-401' }
        })
      }

      chat.start(
        { threadId: 'thread-1', streamId: `stream-go-401-${testCase.protocol}`, messages: [userTurn] },
        send
      )
      await waitFor((current) => current.some((event) => event.type === 'error'))
      const error = events.find((event) => event.type === 'error')
      expect(error).toMatchObject({
        type: 'error',
        error: { kind: 'AUTH', code: 'invalid-key', status: 401, requestId: 'req-go-401' }
      })
      expect(typed.requests).toHaveLength(2)
    }
  )

  it('两套 GO 各用各的请求级密钥：稳定 Provider ID 不同，运行期仍是同一个内置 Provider', async () => {
    const stub = await startSseStub({
      kind: 'stream',
      thinking: ['想'],
      text: ['答']
    })
    stubs.push(stub)

    const first = addGo('sk-go-one', undefined)
    const second = addGo('sk-go-two', undefined)
    pointModelsAt(first, 'openai-completions', stub.baseUrl)
    pointModelsAt(second, 'openai-completions', stub.baseUrl)
    const providers = listModelProviders(database, { secrets, env: {} })
    expect(providers.map((provider) => provider.providerKey)).toEqual([
      'opencode-go',
      'opencode-go-2'
    ])

    const chat = service()
    const firstRun = collector()
    activateModelProvider(database, first)
    setDefault(first, 'beam-free')
    chat.start(
      { threadId: 'thread-1', streamId: 'stream-go-first', messages: [userTurn] },
      firstRun.send
    )
    await firstRun.waitFor((current) => current.some((event) => event.type === 'done'))

    activateModelProvider(database, second)
    setDefault(second, 'deepseek-v4-pro')
    const secondRun = collector()
    chat.start(
      { threadId: 'thread-1', streamId: 'stream-go-second', messages: [userTurn] },
      secondRun.send
    )
    await secondRun.waitFor((current) => current.some((event) => event.type === 'done'))

    expect(stub.requests).toHaveLength(2)
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-go-one')
    expect(stub.requests[0]?.body.model).toBe('beam-free')
    expect(stub.requests[1]?.headers.authorization).toBe('Bearer sk-go-two')
    expect(stub.requests[1]?.body.model).toBe('deepseek-v4-pro')
  })

  it('不支持 high 的 GO 模型按既有能力省略 reasoning，不报错也不显示思维链', async () => {
    const stub = await startSseStub({ kind: 'stream', text: ['普通回答'] })
    stubs.push(stub)

    // kimi-k3 的 thinkingLevelMap 只给了 max：high 与更低档都不可用。
    const providerId = addGo()
    pointModelsAt(providerId, 'openai-completions', stub.baseUrl)
    activateModelProvider(database, providerId)
    setDefault(providerId, 'kimi-k3')

    const config = resolveChatConfig(database, secrets, {})
    expect(config?.descriptor).toMatchObject({ model: 'kimi-k3', reasoning: true })

    const chat = service()
    const { events, send, waitFor } = collector()
    chat.start(
      { threadId: 'thread-1', streamId: 'stream-go-no-high', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(events).toEqual([{ type: 'text', text: '普通回答' }, { type: 'done' }])
    const body = stub.requests[0]?.body as Record<string, unknown>
    expect(body).toMatchObject({ model: 'kimi-k3', stream: true })
    expect(body.thinking).toBeUndefined()
    expect(body.reasoning_effort).toBeUndefined()
  })

  it('停止会中断 GO 流：保留已收到的思维链与正文，不补 done / error', async () => {
    const stub = await startSseStub({
      kind: 'hang',
      thinking: ['想'],
      text: ['半句']
    })
    stubs.push(stub)

    const providerId = addGo()
    pointModelsAt(providerId, 'openai-completions', stub.baseUrl)
    activateModelProvider(database, providerId)
    setDefault(providerId, 'beam-free')

    const chat = service()
    const { events, send, waitFor } = collector()
    chat.start(
      { threadId: 'thread-1', streamId: 'stream-go-stop', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'text'))

    expect(chat.stop('stream-go-stop')).toEqual({ stopped: true })
    await waitUntil(() => stub.abortedConnections > 0)
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

  it('GO 配置缺失密钥时发送前明确报缺失，绝不匿名请求', async () => {
    const stub = await startSseStub({ kind: 'stream', text: ['不该出现'] })
    stubs.push(stub)

    const providerId = addGo('', 'E2E_GO_MISSING_KEY')
    pointModelsAt(providerId, 'openai-completions', stub.baseUrl)
    activateModelProvider(database, providerId)

    const config = resolveChatConfig(database, secrets, {})
    expect(config).toMatchObject({
      missingCredential: true,
      credentialProblem: { kind: 'env-missing', envVar: 'E2E_GO_MISSING_KEY' }
    })

    const chat = service()
    const { events, send, waitFor } = collector()
    chat.start(
      { threadId: 'thread-1', streamId: 'stream-go-missing', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.some((event) => event.type === 'error'))

    expect(events[0]).toMatchObject({
      type: 'error',
      error: {
        code: 'not-configured',
        credential: { kind: 'env-missing', envVar: 'E2E_GO_MISSING_KEY' }
      }
    })
    expect(stub.requests).toHaveLength(0)
  })
})

async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('等待事件超时')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
