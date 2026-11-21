import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatStreamEvent, ChatStreamUpdate } from '../../shared/chat'
import { findModelProvider } from '../../shared/model-catalog'
import {
  startSseStub,
  type SseStub,
  type StubScript
} from '../../testing/sse-stub'
import { openDatabase, type AppDatabase } from '../db/database'
import { createBackup, restoreBackup } from '../data/backup'
import { migrate } from '../db/migrations'
import {
  activateModelProvider,
  addBuiltinProvider,
  setDefaultProviderModel
} from '../settings/provider-writes'
import type { SecretStore } from '../settings/secret-store'
import { listModelProviders, readProviderModels } from '../settings/providers'
import type { ChatConfig } from './config'
import { resolveChatConfig } from './config'
import { descriptorOfCatalogModel, type ChatModelDescriptor } from './model-descriptor'
import { streamChatCompletion } from './pi-stream'
import type { RetryTiming } from './retry'
import { createChatService } from './service'

const stubs: SseStub[] = []

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function stub(script: StubScript): Promise<SseStub> {
  const created = await startSseStub(script)
  stubs.push(created)
  return created
}

const DEEPSEEK_COMPAT = {
  supportsStore: false,
  supportsDeveloperRole: false,
  maxTokensField: 'max_tokens',
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: 'deepseek',
  supportsStrictMode: true
}

function descriptorFor(
  target: SseStub,
  patch: Partial<ChatModelDescriptor> = {}
): ChatModelDescriptor {
  return {
    provider: 'deepseek',
    model: 'deepseek-flash',
    api: 'openai-completions',
    baseUrl: target.baseUrl,
    contextWindow: 1000000,
    maxTokens: 384000,
    input: ['text'],
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
    compat: DEEPSEEK_COMPAT,
    ...patch
  }
}

function configFor(target: SseStub): ChatConfig {
  const descriptor = descriptorFor(target)
  return {
    apiKey: 'test-key',
    baseUrl: descriptor.baseUrl,
    model: descriptor.model,
    descriptor
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
    waitFor: (predicate, timeoutMs = 3000) => waitUntil(() => predicate(events), timeoutMs)
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('等待事件超时')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const userTurn = { role: 'user' as const, content: '你好' }

/** 只替换等待与抖动的系统边界：策略（5 次上限、退避表）仍由生产代码决定。 */
const fastRetry: RetryTiming = {
  random: () => 0.5,
  sleep: async () => true
}

function recordedRetry(): { timing: RetryTiming; delays: number[] } {
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

describe('createChatService', () => {
  it('思维链先、正文后，事件按抵达顺序归一，请求显式带思考强度', async () => {
    const target = await stub({
      kind: 'stream',
      thinking: ['先', '想'],
      text: ['答', '案'],
      chunkDelayMs: 5,
      textDelayMs: 20
    })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    expect(
      service.start({ threadId: 'thread-1', streamId: 'stream-1', messages: [userTurn] }, send)
    ).toEqual({ accepted: true })
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(events).toEqual([
      { type: 'thinking', text: '先' },
      { type: 'thinking', text: '想' },
      { type: 'text', text: '答' },
      { type: 'text', text: '案' },
      { type: 'done' }
    ])

    const request = target.requests[0]
    expect(request).toBeDefined()
    expect(request?.url).toBe('/chat/completions')
    expect(request?.headers.authorization).toBe('Bearer test-key')
    expect(request?.body).toMatchObject({
      model: 'deepseek-flash',
      stream: true,
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      messages: [userTurn]
    })
  })

  it('SSE 一行被网络拆成两段时仍归并成同一条事件', async () => {
    const target = await stub({
      kind: 'stream',
      thinking: ['想'],
      text: ['答'],
      fragmentChunks: true,
      chunkDelayMs: 1,
      textDelayMs: 5
    })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-fragmented', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(events).toEqual([
      { type: 'thinking', text: '想' },
      { type: 'text', text: '答' },
      { type: 'done' }
    ])
  })

  it.each([
    [401, 'invalid-key', 'AUTH'],
    [402, 'insufficient-balance', 'QUOTA'],
    [413, 'context-too-long', 'CONTEXT_WINDOW'],
    [429, 'rate-limited', 'RATE_LIMIT'],
    [500, 'server-busy', 'SERVER'],
    [503, 'server-busy', 'SERVER'],
    [400, 'unknown', 'INVALID_REQUEST']
  ] as const)('HTTP %i 归为 %s，并保留稳定分类与状态码', async (status, code, kind) => {
    const target = await stub({ kind: 'status', status })
    const service = createChatService({
      resolveConfig: () => configFor(target),
      retryTiming: fastRetry
    })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: `stream-${status}`, messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    const event = events.find((candidate) => candidate.type === 'error')
    expect(event).toMatchObject({ type: 'error', error: { code, kind, status } })
    if (status === 401) {
      expect(event).toMatchObject({ error: { requestId: 'stub-401' } })
    }
  })

  it('request id 只从响应头来，Retry-After 一并捕获，报文不参与猜状态', async () => {
    const target = await stub({
      kind: 'status',
      status: 429,
      message: 'too many requests',
      headers: { 'x-request-id': 'req-header-429', 'retry-after': '3' }
    })
    const service = createChatService({
      resolveConfig: () => configFor(target),
      retryTiming: fastRetry
    })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-header', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    expect(events[0]).toMatchObject({
      type: 'error',
      error: {
        code: 'rate-limited',
        kind: 'RATE_LIMIT',
        status: 429,
        requestId: 'req-header-429',
        retryAfterMs: 3000
      }
    })
  })

  it('响应 200 之后连接断掉时归为网络异常，不假装生成完成', async () => {
    const target = await stub({
      kind: 'truncate',
      thinking: ['想'],
      text: ['半句']
    })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-truncate', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    const event = events.find((candidate) => candidate.type === 'error')
    expect(event).toMatchObject({ type: 'error', error: { code: 'network', kind: 'TRANSPORT' } })
    expect(events.some((candidate) => candidate.type === 'done')).toBe(false)
    expect(events.filter((candidate) => candidate.type === 'thinking')).toHaveLength(1)
  })

  it('流在 finish_reason 之前结束时归为网络异常，不假装生成完成', async () => {
    const target = await stub({
      kind: 'end-early',
      thinking: ['想'],
      text: ['半句']
    })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-end-early', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    const event = events.find((candidate) => candidate.type === 'error')
    expect(event).toMatchObject({ type: 'error', error: { code: 'network' } })
    expect(events.some((candidate) => candidate.type === 'done')).toBe(false)
  })

  it('成功响应但一个内容块都没有时归为 EMPTY_RESPONSE，不假装 done', async () => {
    const target = await stub({ kind: 'stream', text: [] })
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
  })

  it('空回答也保留捕获到的状态码、request id 与 Retry-After，不丢排障信息', async () => {
    const target = await stub({
      kind: 'stream',
      text: [],
      headers: { 'x-request-id': 'req-empty', 'retry-after': '3' }
    })
    const service = createChatService({
      resolveConfig: () => configFor(target),
      retryTiming: fastRetry
    })
    const { events, send, waitFor } = collector()

    service.start(
      { threadId: 'thread-1', streamId: 'stream-empty-headers', messages: [userTurn] },
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
          requestId: 'req-empty',
          retryAfterMs: 3000,
          detail: expect.any(String)
        }
      }
    ])
    // 空回答不是成功：不能因此把 provider 标成已验证。
    expect(events.some((event) => event.type === 'done')).toBe(false)
  })

  it('连不上模型服务时归为网络异常，稳定分类是 TRANSPORT', async () => {
    const service = createChatService({
      retryTiming: fastRetry,
      resolveConfig: () => ({
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:1',
        model: 'deepseek-flash',
        descriptor: {
          provider: 'deepseek',
          model: 'deepseek-flash',
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1',
          contextWindow: 1000000,
          maxTokens: 384000,
          input: ['text'],
          reasoning: false
        }
      })
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

  it('没有配置密钥时给出配置错误，不发起请求', async () => {
    const service = createChatService({ resolveConfig: () => null })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-config', messages: [userTurn] }, send)
    await waitFor((current) => current.length > 0)

    expect(events).toEqual([{ type: 'error', error: { code: 'not-configured' } }])
  })

  it('本机密钥缺失或解不开时在发送前明确报配置错误，不拿空密钥请求', async () => {
    const target = await stub({ kind: 'stream', text: ['不该出现'] })
    const service = createChatService({
      resolveConfig: () => ({
        ...configFor(target),
        apiKey: '',
        missingCredential: true
      })
    })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-missing-key', messages: [userTurn] }, send)
    await waitFor((current) => current.length > 0)

    expect(events[0]).toMatchObject({ type: 'error', error: { code: 'not-configured' } })
    expect(target.requests).toHaveLength(0)
  })

  it('环境变量缺失的错误里点名变量，并带上结构化原因供界面展示', async () => {
    const target = await stub({ kind: 'stream', text: ['不该出现'] })
    const service = createChatService({
      resolveConfig: () => ({
        ...configFor(target),
        apiKey: '',
        missingCredential: true,
        credentialProblem: { kind: 'env-missing', envVar: 'MISSING_PROVIDER_KEY' }
      })
    })
    const { events, send, waitFor } = collector()

    service.start(
      { threadId: 'thread-1', streamId: 'stream-env-missing', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.length > 0)

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'not-configured',
          detail: expect.stringContaining('MISSING_PROVIDER_KEY'),
          credential: { kind: 'env-missing', envVar: 'MISSING_PROVIDER_KEY' }
        }
      }
    ])
    expect(target.requests).toHaveLength(0)
  })

  it('本机密文解不开的错误不再笼统说「缺失」', async () => {
    const target = await stub({ kind: 'stream', text: ['不该出现'] })
    const service = createChatService({
      resolveConfig: () => ({
        ...configFor(target),
        apiKey: '',
        missingCredential: true,
        credentialProblem: { kind: 'stored-decrypt-failed' }
      })
    })
    const { events, send, waitFor } = collector()

    service.start(
      { threadId: 'thread-1', streamId: 'stream-decrypt-failed', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.length > 0)

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'not-configured',
          detail: '本机保存的密钥解不开',
          credential: { kind: 'stored-decrypt-failed' }
        }
      }
    ])
    expect(target.requests).toHaveLength(0)
  })

  it('停止会中断请求，已收到的内容保留，且不再补发 done 或 error', async () => {
    const target = await stub({ kind: 'hang', thinking: ['想'], text: ['半句'] })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-stop', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'text'))

    expect(service.hasActiveThread('thread-1')).toBe(true)
    expect(service.hasActiveThread('another-thread')).toBe(false)
    expect(service.stop('stream-stop')).toEqual({ stopped: true })
    await waitUntil(() => target.abortedConnections > 0)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(events.filter((event) => event.type === 'thinking')).toEqual([
      { type: 'thinking', text: '想' }
    ])
    expect(events.some((event) => event.type === 'done' || event.type === 'error')).toBe(false)
    expect(service.stop('stream-stop')).toEqual({ stopped: false })
  })

  it('同一 streamId 不会被启动两次', async () => {
    const target = await stub({ kind: 'hang' })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { send } = collector()

    expect(
      service.start({ threadId: 'thread-1', streamId: 'stream-duplicate', messages: [userTurn] }, send)
    ).toEqual({ accepted: true })
    expect(
      service.start({ threadId: 'thread-1', streamId: 'stream-duplicate', messages: [userTurn] }, send)
    ).toEqual({ accepted: false })

    service.stop('stream-duplicate')
  })

  it('service 层的 normal 对 500 最多重试 5 次：只显示最终错误，退避是 500ms→8s', async () => {
    const target = await stub({ kind: 'status', status: 500 })
    const recorded = recordedRetry()
    const service = createChatService({
      resolveConfig: () => configFor(target),
      retryTiming: recorded.timing
    })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-once', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    expect(target.requests).toHaveLength(6)
    expect(recorded.delays).toEqual([500, 1000, 2000, 4000, 8000])
    expect(events).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({ code: 'server-busy', kind: 'SERVER', status: 500 })
      }
    ])
  })
})

describe('配置回写与切换', () => {
  it('一次成功调用后把使用中的 provider 标成已验证', async () => {
    const target = await stub({ kind: 'stream', text: ['答'] })
    const verified: string[] = []
    const service = createChatService({
      resolveConfig: () => ({ ...configFor(target), providerId: 'provider-1' }),
      onVerified: (providerId) => verified.push(providerId)
    })
    const { send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-verified', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(verified).toEqual(['provider-1'])
  })

  it('出错时不把 provider 标成已验证', async () => {
    const target = await stub({ kind: 'status', status: 500 })
    const verified: string[] = []
    const service = createChatService({
      resolveConfig: () => ({ ...configFor(target), providerId: 'provider-1' }),
      onVerified: (providerId) => verified.push(providerId),
      retryTiming: fastRetry
    })
    const { send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-failed', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    expect(verified).toEqual([])
  })

  it('每次调用重新解析配置，切换只影响之后的调用', async () => {
    const first = await stub({ kind: 'stream', text: ['一'] })
    const second = await stub({ kind: 'stream', text: ['二'] })
    let current: ChatConfig = configFor(first)
    const service = createChatService({ resolveConfig: () => current })
    const { send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-first', messages: [userTurn] }, send)
    await waitFor((events) => events.some((event) => event.type === 'done'))

    current = {
      ...configFor(second),
      model: 'deepseek-v4-pro',
      descriptor: descriptorFor(second, { model: 'deepseek-v4-pro' })
    }
    service.start({ threadId: 'thread-1', streamId: 'stream-second', messages: [userTurn] }, send)
    await waitFor(
      (events) => events.filter((event) => event.type === 'done').length === 2
    )

    expect(first.requests[0]?.body.model).toBe('deepseek-flash')
    expect(second.requests[0]?.body.model).toBe('deepseek-v4-pro')
  })
})

describe('内置 provider 与描述符进请求', () => {
  let directory: string
  let database: AppDatabase

  const secrets: SecretStore = {
    encrypt: (plain) => `sealed:${plain}`,
    decrypt: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null)
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'english-learning-chat-builtin-'))
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

  it('Kimi 用目录模型与自己的端点发请求；思考按 compat 发，不用 DeepSeek 目录冒充', async () => {
    const target = await stub({ kind: 'stream', text: ['答'] })
    const providerId = addAndActivate('kimi', 'sk-kimi-0001')
    pointAt(providerId, `${target.baseUrl}/v1`)

    const config = resolveChatConfig(database, secrets, {})
    expect(config?.descriptor).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k2.6',
      api: 'openai-completions',
      baseUrl: `${target.baseUrl}/v1`,
      contextWindow: 262144,
      maxTokens: 262144,
      reasoning: true
    })
    const service = createChatService({ resolveConfig: () => config })
    const { send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-kimi', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'done'))

    const request = target.requests[0]
    expect(request?.url).toBe('/v1/chat/completions')
    expect(request?.headers.authorization).toBe('Bearer sk-kimi-0001')
    expect(request?.body).toMatchObject({
      model: 'kimi-k2.6',
      thinking: { type: 'enabled' }
    })
    expect(request?.body.reasoning_effort).toBeUndefined()
  })

  it('换默认模型后下一次调用才换模型；kimi-k3 按 openai 思考格式发 reasoning_effort', async () => {
    const target = await stub({ kind: 'stream', text: ['答'] })
    const providerId = addAndActivate('kimi', 'sk-kimi-0001')
    pointAt(providerId, `${target.baseUrl}/v1`)
    const k3 = readProviderModels(database, providerId).find(
      (model) => model.modelId === 'kimi-k3'
    )!
    expect(setDefaultProviderModel(database, providerId, k3.id)).toMatchObject({
      status: 'saved'
    })

    const service = createChatService({
      resolveConfig: () => resolveChatConfig(database, secrets, {})
    })
    const { send, waitFor } = collector()
    service.start({ threadId: 'thread-1', streamId: 'stream-kimi-k3', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'done'))

    const request = target.requests[0]
    expect(request?.body.model).toBe('kimi-k3')
    expect(request?.body.reasoning_effort).toBe('high')
    expect(request?.body.thinking).toBeUndefined()
  })

  it('GLM 用 zai 思考格式，模型与容量来自它自己的目录', async () => {
    const target = await stub({ kind: 'stream', text: ['答'] })
    const providerId = addAndActivate('glm', 'sk-glm-0001')
    pointAt(providerId, `${target.baseUrl}/v4`)

    const service = createChatService({
      resolveConfig: () => resolveChatConfig(database, secrets, {})
    })
    const { send, waitFor } = collector()
    service.start({ threadId: 'thread-1', streamId: 'stream-glm', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'done'))

    const request = target.requests[0]
    expect(request?.url).toBe('/v4/chat/completions')
    expect(request?.body).toMatchObject({
      model: 'glm-4.7',
      thinking: { type: 'enabled', clear_thinking: false }
    })
    expect(resolveChatConfig(database, secrets, {})?.descriptor).toMatchObject({
      contextWindow: 204800,
      maxTokens: 131072
    })
  })

  it('非思考的迁移模型不传 thinking / reasoning_effort，请求里发它自己的模型名', async () => {
    const target = await stub({ kind: 'stream', text: ['答'] })
    database
      .prepare(
        `INSERT INTO model_provider (
           id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
           secret_ciphertext, retry_policy, verification, last_error, last_checked_at,
           last_verified_at, source, catalog_provider_id, default_model_id, created_at,
           updated_at
         ) VALUES ('provider-old', 'old-gateway', '旧中转', 'openai-completions', ?, 'env',
                   'OLD_KEY', NULL, '{"mode":"normal"}', 'unverified', NULL, NULL, NULL,
                   'custom', NULL, 'model-old', '2026-11-21T00:00:00.000Z',
                   '2026-11-21T00:00:00.000Z')`
      )
      .run(target.baseUrl)
    database
      .prepare(
        `INSERT INTO model_provider_model (
           id, provider_id, model_id, display_name, api, base_url, context_window,
           max_tokens, input, reasoning, thinking_level_map, compat, source, sort,
           created_at, updated_at
         ) VALUES ('model-old', 'provider-old', 'mystery-model', 'mystery-model',
                   'openai-completions', NULL, NULL, NULL, 'text', 0, NULL, NULL,
                   'manual', 0, '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')`
      )
      .run()
    activateModelProvider(database, 'provider-old')

    const config = resolveChatConfig(database, secrets, { OLD_KEY: 'sk-old' })
    expect(config?.descriptor).toMatchObject({
      model: 'mystery-model',
      contextWindow: 1000000,
      maxTokens: 128000,
      reasoning: false
    })
    const service = createChatService({ resolveConfig: () => config })
    const { send, waitFor } = collector()
    service.start({ threadId: 'thread-1', streamId: 'stream-old', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'done'))

    const request = target.requests[0]
    expect(request?.body.model).toBe('mystery-model')
    expect(request?.body.thinking).toBeUndefined()
    expect(request?.body.reasoning_effort).toBeUndefined()
  })

  it('备份恢复后的内置 provider 丢了本机密钥：发送前明确报配置错误，不发任何请求', async () => {
    const target = await stub({ kind: 'stream', text: ['不该被调用'] })
    const providerId = addAndActivate('deepseek', 'sk-deepseek-0001')
    // 地址指向本地 stub：如果仍在发送，请求数会立刻暴露出来。
    pointAt(providerId, target.baseUrl)
    const backupFile = join(directory, 'backup.db')
    await createBackup(database, { file: backupFile, now: '2026-11-21T01:00:00.000Z' })
    const restored = await restoreBackup(database, {
      file: backupFile,
      snapshotDirectory: join(directory, 'snapshots'),
      now: '2026-11-21T02:00:00.000Z'
    })
    expect(restored.status).toBe('restored')
    // 备份按设计抹掉本机密文；恢复后 provider 还在、仍是使用中。
    expect(
      database
        .prepare('SELECT secret_ciphertext, source FROM model_provider WHERE id = ?')
        .get(providerId)
    ).toEqual({ secret_ciphertext: null, source: 'builtin' })

    const config = resolveChatConfig(database, secrets, {})
    expect(config).toMatchObject({ apiKey: '', providerId, missingCredential: true })

    const service = createChatService({ resolveConfig: () => config })
    const { events, send, waitFor } = collector()
    service.start({ threadId: 'thread-1', streamId: 'stream-restored', messages: [userTurn] }, send)
    await waitFor((current) => current.length > 0)

    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'not-configured',
          detail: expect.any(String),
          credential: { kind: 'stored-missing' }
        }
      }
    ])
    expect(target.requests).toHaveLength(0)
  })

  it('保存了内置 provider 但没点「使用这个」时不静默改用环境变量里的另一套密钥', async () => {
    const target = await stub({ kind: 'stream', text: ['不该被调用'] })
    const added = addBuiltinProvider(
      database,
      secrets,
      { catalogProviderId: 'deepseek', apiKey: 'sk-provider-0001' },
      { now: '2026-11-21T00:00:00.000Z' }
    )
    if (added.status !== 'saved') throw new Error('没存上')
    // 没有 activateModelProvider：provider 行存在但没有使用中。
    const env = {
      DEEPSEEK_API_KEY: 'sk-env-other-0002',
      DEEPSEEK_BASE_URL: target.baseUrl,
      DEEPSEEK_MODEL: 'env-model'
    }
    expect(listModelProviders(database, { secrets, env })[0]?.active).toBe(false)

    const service = createChatService({
      resolveConfig: () => resolveChatConfig(database, secrets, env)
    })
    const { events, send, waitFor } = collector()
    service.start(
      { threadId: 'thread-1', streamId: 'stream-unactivated', messages: [userTurn] },
      send
    )
    await waitFor((current) => current.length > 0)

    expect(events).toEqual([{ type: 'error', error: { code: 'not-configured' } }])
    expect(target.requests).toHaveLength(0)
  })

  it('两个并发请求各用各的捕获与协议状态，一个失败不污染另一个', async () => {
    const failing = await stub({
      kind: 'status',
      status: 401,
      headers: { 'x-request-id': 'req-concurrent-fail' }
    })
    const passing = await stub({ kind: 'stream', text: ['好的'] })

    const events: ChatStreamEvent[][] = [[], []]
    const first = streamChatCompletion({
      ...configFor(failing),
      messages: [userTurn],
      signal: new AbortController().signal,
      onEvent: (event) => events[0]!.push(event)
    })
    const second = streamChatCompletion({
      ...configFor(passing),
      messages: [userTurn],
      apiKey: 'other-key',
      descriptor: descriptorFor(passing, { model: 'kimi-k3', provider: 'kimi-2' }),
      signal: new AbortController().signal,
      onEvent: (event) => events[1]!.push(event)
    })

    await Promise.all([first, second])

    expect(events[0]).toEqual([
      {
        type: 'error',
        error: expect.objectContaining({
          kind: 'AUTH',
          requestId: 'req-concurrent-fail'
        })
      }
    ])
    expect(events[1]?.at(-1)).toEqual({ type: 'done' })
    expect(failing.requests[0]?.headers.authorization).toBe('Bearer test-key')
    expect(passing.requests[0]?.headers.authorization).toBe('Bearer other-key')
    expect(passing.requests[0]?.body.model).toBe('kimi-k3')
  })
})

describe('streamChatCompletion', () => {
  it('描述符指向的协议不可用时明确报错且不发请求', async () => {
    const target = await stub({ kind: 'stream', text: ['不该出现'] })
    const events: ChatStreamEvent[] = []

    await streamChatCompletion({
      apiKey: 'test-key',
      descriptor: descriptorFor(target, { api: 'pi-messages' as never }),
      messages: [userTurn],
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event)
    })

    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: 'unknown', kind: 'UNKNOWN' }
    })
    expect(target.requests).toHaveLength(0)
  })

  it('目录模型没有思考能力时省略 reasoning；有 high 时需要 high', async () => {
    const high = findModelProvider('deepseek')!
    const model = high.models[0]!
    const descriptor = descriptorOfCatalogModel(model, 'http://127.0.0.1:1', 'deepseek')
    expect(descriptor.reasoning).toBe(true)
    expect(descriptor.thinkingLevelMap?.high).toBe('high')
  })
})
