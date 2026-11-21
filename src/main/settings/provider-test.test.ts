import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderProtocol } from '../../shared/model-providers'
import {
  PROVIDER_TEST_MAX_OUTPUT_TOKENS,
  PROVIDER_TEST_TIMEOUT_MS
} from '../../shared/provider-test'
import { startAnthropicStub } from '../../testing/anthropic-sse-stub'
import { startGeminiSseStub } from '../../testing/gemini-sse-stub'
import { startResponsesStub } from '../../testing/responses-sse-stub'
import { startSseStub, unusedBaseUrl } from '../../testing/sse-stub'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { testProviderConnection } from './provider-test'
import { createCustomProvider } from './provider-editing'
import { addBuiltinProvider } from './provider-writes'
import { readDefaultModel, readModelProvider } from './providers'
import type { SecretStore } from './secret-store'

type StubRequest = {
  method: string
  url: string
  headers: Record<string, unknown>
  body: Record<string, unknown>
}

type StatusScript = {
  kind: 'status'
  status: number
  headers?: Readonly<Record<string, string>>
}

type ProtocolStub = {
  baseUrl: string
  requests: StubRequest[]
  setScript(script: StatusScript): void
  close(): Promise<void>
}

let directory: string
let database: AppDatabase
const stubs: ProtocolStub[] = []
const hanging: Array<{ close(): Promise<void> }> = []

/** 可逆的假加密：只用来观察密钥有没有被读取，不参与任何断言。 */
const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (sealed) =>
    sealed.startsWith('sealed:')
      ? Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')
      : null
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-provider-test-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
})

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
  await Promise.all(hanging.splice(0).map((server) => server.close()))
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function protocolStub(protocol: ProviderProtocol): Promise<ProtocolStub> {
  let created: ProtocolStub
  switch (protocol) {
    case 'openai-completions':
      created = await startSseStub({ kind: 'stream', text: ['ok'] })
      break
    case 'openai-responses':
      created = await startResponsesStub({ kind: 'stream', text: ['ok'] })
      break
    case 'anthropic-messages':
      created = await startAnthropicStub({ kind: 'stream', text: ['ok'] })
      break
    case 'google-generative-ai':
      created = await startGeminiSseStub({ kind: 'stream', text: ['ok'] })
      break
    default:
      throw new Error(`没有为 ${String(protocol)} 准备 stub`)
  }
  stubs.push(created)
  return created
}

async function hangingServer(): Promise<string> {
  const server = createServer(() => {
    // 故意不响应：交给测试连接自己的超时。
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  hanging.push({
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  })
  return `http://127.0.0.1:${address.port}`
}

function seedBuiltin(
  catalogProviderId: 'deepseek' | 'openai' | 'anthropic' | 'gemini',
  baseUrl: string,
  authMode: 'stored' | 'env',
  envVar?: string
): string {
  const added = addBuiltinProvider(database, secrets, {
    catalogProviderId,
    authMode,
    ...(envVar === undefined ? {} : { envVar }),
    apiKey: authMode === 'stored' ? 'sk-builtin-stored' : ''
  })
  if (added.status !== 'saved') throw new Error('内置 provider 没存上')
  pointAt(added.providerId, baseUrl)
  return added.providerId
}

let customSequence = 0

function seedCustom(
  protocol: ProviderProtocol,
  baseUrl: string,
  authMode: 'stored' | 'env'
): string {
  customSequence += 1
  const created = createCustomProvider(database, secrets, {
    providerKey: `relay-${customSequence}`,
    displayName: '自定义中转',
    protocol,
    baseUrl,
    authMode,
    ...(authMode === 'env' ? { envVar: 'CUSTOM_PROVIDER_KEY' } : {}),
    apiKey: authMode === 'stored' ? 'sk-custom-stored' : '',
    model: { modelId: 'relay-model' }
  })
  if (created.status !== 'saved') throw new Error('自定义 provider 没存上')
  return created.providerId
}

function pointAt(providerId: string, baseUrl: string): void {
  database
    .prepare('UPDATE model_provider SET base_url = ? WHERE id = ?')
    .run(baseUrl, providerId)
}

function envFor(authMode: 'stored' | 'env', protocol: ProviderProtocol): NodeJS.ProcessEnv {
  if (authMode === 'stored') return {}
  const builtinVar: Record<string, string> = {
    'openai-completions': 'DEEPSEEK_API_KEY',
    'openai-responses': 'OPENAI_API_KEY',
    'anthropic-messages': 'ANTHROPIC_API_KEY',
    'google-generative-ai': 'GEMINI_API_KEY'
  }
  // 内置与环境变量各用各的名字；测试按 provider 的实际 env_var 取值。
  return {
    [builtinVar[protocol]!]: 'sk-env-secret',
    MOONSHOT_API_KEY: 'sk-env-secret',
    ZAI_API_KEY: 'sk-env-secret',
    MINIMAX_API_KEY: 'sk-env-secret',
    XAI_API_KEY: 'sk-env-secret',
    CUSTOM_PROVIDER_KEY: 'sk-env-secret'
  }
}

function expectedAuthHeader(protocol: ProviderProtocol, key: string): Record<string, string> {
  switch (protocol) {
    case 'anthropic-messages':
      return { 'x-api-key': key }
    case 'google-generative-ai':
      return { 'x-goog-api-key': key }
    default:
      return { authorization: `Bearer ${key}` }
  }
}

function outputBudget(protocol: ProviderProtocol, body: Record<string, unknown>): unknown {
  switch (protocol) {
    case 'openai-responses':
      return body.max_output_tokens
    case 'google-generative-ai':
      return (body.generationConfig as Record<string, unknown> | undefined)?.maxOutputTokens
    default:
      // 自定义 OpenAI 兼容入口按 pi 的探测结果可能用 max_completion_tokens。
      return body.max_tokens ?? body.max_completion_tokens
  }
}

/** 探针不应打开思考：只允许明确的「关」或完全不传。 */
function expectNoHighReasoning(
  protocol: ProviderProtocol,
  body: Record<string, unknown>
): void {
  const generationConfig = body.generationConfig as Record<string, unknown> | undefined
  switch (protocol) {
    case 'openai-completions':
      // DeepSeek 兼容层会显式发 thinking:disabled；允许明确关闭，不允许开启。
      expect((body.thinking as { type?: string } | undefined)?.type ?? 'disabled').toBe(
        'disabled'
      )
      expect(body.reasoning_effort).toBeUndefined()
      return
    case 'openai-responses': {
      const reasoning = body.reasoning as { effort?: string } | undefined
      expect(reasoning?.effort ?? 'none').toBe('none')
      return
    }
    case 'anthropic-messages':
      expect(body.thinking).toBeUndefined()
      return
    case 'google-generative-ai': {
      const thinking = generationConfig?.thinkingConfig as
        | { includeThoughts?: boolean; thinkingBudget?: number; thinkingLevel?: string }
        | undefined
      expect(thinking?.includeThoughts).toBeUndefined()
      expect(thinking?.thinkingBudget ?? 0).toBe(0)
      expect(thinking?.thinkingLevel).toBeUndefined()
      return
    }
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const BUILTIN_CASE: Record<ProviderProtocol, 'deepseek' | 'openai' | 'anthropic' | 'gemini'> = {
  'openai-completions': 'deepseek',
  'openai-responses': 'openai',
  'anthropic-messages': 'anthropic',
  'google-generative-ai': 'gemini'
}

const PROTOCOLS: readonly ProviderProtocol[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
]

describe('testProviderConnection：四种协议 × 内置/自定义 × 本机/环境', () => {
  const cases = PROTOCOLS.flatMap((protocol) =>
    (['builtin', 'custom'] as const).flatMap((source) =>
      (['stored', 'env'] as const).map((authMode) => ({ protocol, source, authMode }))
    )
  )

  it.each(cases)(
    '$protocol · $source · $authMode：发一次最小请求，成功后只写验证状态',
    async ({ protocol, source, authMode }) => {
      const stub = await protocolStub(protocol)
      const providerId =
        source === 'builtin'
          ? seedBuiltin(BUILTIN_CASE[protocol], stub.baseUrl, authMode)
          : seedCustom(protocol, stub.baseUrl, authMode)
      const before = readModelProvider(database, providerId)

      const result = await testProviderConnection(database, secrets, envFor(authMode, protocol), {
        providerId
      })

      expect(result).toMatchObject({ status: 'verified', persisted: true })
      expect(stub.requests).toHaveLength(1)

      const request = stub.requests[0]!
      expect(request.method).toBe('POST')
      expect(request.headers).toMatchObject(
        expectedAuthHeader(protocol, authMode === 'env' ? 'sk-env-secret' : source === 'builtin' ? 'sk-builtin-stored' : 'sk-custom-stored')
      )
      expect(outputBudget(protocol, request.body)).toBe(PROVIDER_TEST_MAX_OUTPUT_TOKENS)
      // 探针不打开思考：一次最小请求不为测试连接生成思维链。
      expectNoHighReasoning(protocol, request.body)

      const after = readModelProvider(database, providerId)
      expect(after).toMatchObject({
        verification: 'verified',
        lastError: null,
        lastErrorRequestId: null
      })
      expect(after?.lastCheckedAt).not.toBeNull()
      expect(after?.lastVerifiedAt).toBe(after?.lastCheckedAt)
      // 成功不改任何配置字段。
      expect(after).toMatchObject({
        providerKey: before?.providerKey,
        protocol: before?.protocol,
        baseUrl: before?.baseUrl,
        authMode: before?.authMode,
        envVar: before?.envVar,
        secretCiphertext: before?.secretCiphertext,
        defaultModelRowId: before?.defaultModelRowId
      })
    }
  )
})

describe('testProviderConnection：失败分类与配置保留', () => {
  it.each([
    [401, 'invalid-key'],
    [403, 'invalid-key'],
    [400, 'invalid-config'],
    [404, 'invalid-config'],
    [402, 'quota'],
    [413, 'invalid-config'],
    [429, 'rate-limit'],
    [500, 'server'],
    [503, 'server']
  ] as const)('HTTP %i 归为 %s，保留原配置与原密钥并写回原因', async (status, reason) => {
    const protocol: ProviderProtocol = 'openai-completions'
    const stub = await protocolStub(protocol)
    stub.setScript({
      kind: 'status',
      status,
      headers: { 'x-request-id': `req-${status}` }
    })
    const providerId = seedCustom(protocol, stub.baseUrl, 'stored')
    const before = readModelProvider(database, providerId)

    const result = await testProviderConnection(database, secrets, {}, { providerId })

    expect(result).toMatchObject({ status: 'failed', persisted: true, reason })
    if (result.status !== 'failed') throw new Error('应当失败')
    expect(result.error.status).toBe(status)
    expect(result.requestId).toBe(`req-${status}`)
    expect(result.error.requestId).toBe(`req-${status}`)

    const after = readModelProvider(database, providerId)
    expect(after).toMatchObject({
      verification: 'unverified',
      lastError: reason,
      lastErrorRequestId: `req-${status}`
    })
    expect(after?.lastCheckedAt).not.toBeNull()
    // 测试失败不动地址、协议、密钥来源与默认模型。
    expect(after).toMatchObject({
      protocol: before?.protocol,
      baseUrl: before?.baseUrl,
      authMode: before?.authMode,
      envVar: before?.envVar,
      secretCiphertext: before?.secretCiphertext,
      defaultModelRowId: before?.defaultModelRowId
    })
  })

  it('缺密钥时不发请求，明确点名环境变量', async () => {
    const stub = await protocolStub('openai-completions')
    const providerId = seedCustom('openai-completions', stub.baseUrl, 'env')
    const before = readModelProvider(database, providerId)

    const result = await testProviderConnection(database, secrets, {}, { providerId })

    expect(result).toMatchObject({ status: 'failed', persisted: true, reason: 'missing-credential' })
    if (result.status !== 'failed') throw new Error('应当失败')
    expect(result.error).toMatchObject({
      code: 'not-configured',
      credential: { kind: 'env-missing', envVar: 'CUSTOM_PROVIDER_KEY' }
    })
    expect(stub.requests).toHaveLength(0)
    expect(readModelProvider(database, providerId)).toMatchObject({
      verification: 'unverified',
      lastError: 'missing-credential',
      baseUrl: before?.baseUrl,
      envVar: before?.envVar
    })
  })

  it('本机密文解不开时按缺失报错，不匿名请求', async () => {
    const stub = await protocolStub('openai-completions')
    const providerId = seedCustom('openai-completions', stub.baseUrl, 'stored')
    database
      .prepare(`UPDATE model_provider SET secret_ciphertext = 'broken-ciphertext' WHERE id = ?`)
      .run(providerId)

    const result = await testProviderConnection(database, secrets, {}, { providerId })

    expect(result).toMatchObject({ status: 'failed', reason: 'missing-credential' })
    if (result.status !== 'failed') throw new Error('应当失败')
    expect(result.error.credential).toEqual({ kind: 'stored-decrypt-failed' })
    expect(stub.requests).toHaveLength(0)
  })

  it('超时在总时长内及时收口，原因记为超时且不挂住', async () => {
    const baseUrl = await hangingServer()
    const providerId = seedCustom('openai-completions', baseUrl, 'stored')

    const startedAt = Date.now()
    const result = await testProviderConnection(database, secrets, {}, { providerId }, {
      timeoutMs: 120
    })
    const elapsed = Date.now() - startedAt

    expect(result).toMatchObject({ status: 'failed', persisted: true, reason: 'timeout' })
    if (result.status !== 'failed') throw new Error('应当失败')
    expect(result.error).toMatchObject({ kind: 'TIMEOUT' })
    // 没有响应头就没有 request id：不伪造一个。
    expect(result.requestId).toBeUndefined()
    expect(result.error.requestId).toBeUndefined()
    expect(elapsed).toBeLessThan(2000)
    // 生产口径固定 8 秒；测试只注入更短的超时。
    expect(PROVIDER_TEST_TIMEOUT_MS).toBe(8000)
    expect(readModelProvider(database, providerId)).toMatchObject({
      verification: 'unverified',
      lastError: 'timeout'
    })
  })

  it('响应头已带 request id 后正文挂住：超时仍保留这个 id', async () => {
    const stub = await startSseStub({
      kind: 'hang',
      headers: { 'x-request-id': 'req-hang-1' }
    })
    stubs.push(stub)
    const providerId = seedCustom('openai-completions', stub.baseUrl, 'stored')

    const result = await testProviderConnection(database, secrets, {}, { providerId }, {
      timeoutMs: 120
    })

    expect(result).toMatchObject({
      status: 'failed',
      persisted: true,
      reason: 'timeout',
      requestId: 'req-hang-1'
    })
    if (result.status !== 'failed') throw new Error('应当失败')
    expect(result.error.requestId).toBe('req-hang-1')
    expect(readModelProvider(database, providerId)).toMatchObject({
      verification: 'unverified',
      lastError: 'timeout',
      lastErrorRequestId: 'req-hang-1'
    })
  })

  it('地址连不上时按网络异常记录，并给出网络原因', async () => {
    const baseUrl = await unusedBaseUrl()
    const providerId = seedCustom('openai-completions', baseUrl, 'stored')

    const result = await testProviderConnection(database, secrets, {}, { providerId })

    expect(result).toMatchObject({ status: 'failed', persisted: true, reason: 'network' })
    if (result.status !== 'failed') throw new Error('应当失败')
    expect(result.error).toMatchObject({ kind: 'TRANSPORT' })
    expect(readModelProvider(database, providerId)).toMatchObject({
      verification: 'unverified',
      lastError: 'network'
    })
  })

  it('不认识的协议不发请求，明确报协议不受支持', async () => {
    const stub = await protocolStub('openai-completions')
    const providerId = seedCustom('openai-completions', stub.baseUrl, 'stored')
    database
      .prepare(`UPDATE model_provider SET protocol = 'mistral-conversations' WHERE id = ?`)
      .run(providerId)
    database
      .prepare(`UPDATE model_provider_model SET api = 'mistral-conversations' WHERE provider_id = ?`)
      .run(providerId)

    const result = await testProviderConnection(database, secrets, {}, { providerId })

    expect(result).toMatchObject({
      status: 'failed',
      persisted: true,
      reason: 'unsupported-protocol'
    })
    expect(stub.requests).toHaveLength(0)
  })

  it('没有模型时不发请求，明确报没有可用模型', async () => {
    const stub = await protocolStub('openai-completions')
    const providerId = seedCustom('openai-completions', stub.baseUrl, 'stored')
    database.prepare('DELETE FROM model_provider_model WHERE provider_id = ?').run(providerId)

    const result = await testProviderConnection(database, secrets, {}, { providerId })

    expect(result).toMatchObject({ status: 'failed', persisted: true, reason: 'no-model' })
    expect(stub.requests).toHaveLength(0)
  })

  it('200 但没有正文也算一次成功往返：连通性看的是协议往返', async () => {
    const stub = await startSseStub({ kind: 'stream', text: [] })
    stubs.push(stub)
    const providerId = seedCustom('openai-completions', stub.baseUrl, 'stored')

    const result = await testProviderConnection(database, secrets, {}, { providerId })

    expect(result).toMatchObject({ status: 'verified', persisted: true })
    expect(readModelProvider(database, providerId)?.verification).toBe('verified')
  })

  it('聚合入口（OpenCode GO）按默认模型的协议与地址测试连接', async () => {
    const stub = await protocolStub('openai-completions')
    const added = addBuiltinProvider(database, secrets, {
      catalogProviderId: 'opencode-go',
      authMode: 'env',
      envVar: 'GO_TEST_KEY'
    })
    if (added.status !== 'saved') throw new Error('OpenCode GO 没存上')
    const providerId = added.providerId
    // 真实目录里模型各自带地址；测试只把默认模型（openai-completions 那条）
    // 指到本地 stub，协议与分派仍走聚合入口自己的实现。
    database
      .prepare(`UPDATE model_provider SET base_url = NULL WHERE id = ?`)
      .run(providerId)
    database
      .prepare(
        `UPDATE model_provider_model SET base_url = ?
          WHERE provider_id = ? AND api = 'openai-completions'`
      )
      .run(stub.baseUrl, providerId)
    const defaultModel = readDefaultModel(database, readModelProvider(database, providerId)!)

    const result = await testProviderConnection(
      database,
      secrets,
      { GO_TEST_KEY: 'sk-go-test' },
      { providerId }
    )

    expect(result).toMatchObject({ status: 'verified', persisted: true })
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0]?.body.model).toBe(defaultModel?.modelId)
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-go-test')
    expect(readModelProvider(database, providerId)).toMatchObject({
      verification: 'verified',
      lastError: null
    })
  })
})

describe('testProviderConnection：运行中配置变更时旧结果不误写', () => {
  it('测试期间换了地址：成功也只报 persisted=false，新配置仍是未验证', async () => {
    const stub = await startSseStub({
      kind: 'stream',
      text: ['ok'],
      firstChunkDelayMs: 250
    })
    stubs.push(stub)
    const providerId = seedCustom('openai-completions', stub.baseUrl, 'stored')

    const pending = testProviderConnection(database, secrets, {}, { providerId })
    await waitUntil(() => stub.requests.length === 1)
    database
      .prepare(
        `UPDATE model_provider SET base_url = 'https://changed.example.com/v1', updated_at = ?
          WHERE id = ?`
      )
      .run('2099-01-01T00:00:00.000Z', providerId)

    const result = await pending

    expect(result).toMatchObject({ status: 'verified', persisted: false })
    expect(readModelProvider(database, providerId)).toMatchObject({
      baseUrl: 'https://changed.example.com/v1',
      verification: 'unverified',
      lastError: null,
      lastCheckedAt: null
    })
  })

  it('测试期间删掉 provider：报 missing，不再写任何状态', async () => {
    const stub = await startSseStub({
      kind: 'stream',
      text: ['ok'],
      firstChunkDelayMs: 250
    })
    stubs.push(stub)
    const providerId = seedCustom('openai-completions', stub.baseUrl, 'stored')

    const pending = testProviderConnection(database, secrets, {}, { providerId })
    await waitUntil(() => stub.requests.length === 1)
    database.prepare('DELETE FROM model_provider WHERE id = ?').run(providerId)

    await expect(pending).resolves.toEqual({ status: 'missing' })
    expect(stub.requests).toHaveLength(1)
  })

  it('测试期间换密钥 / 换默认模型同样不会把旧结果写回', async () => {
    const stub = await startSseStub({
      kind: 'stream',
      text: ['ok'],
      firstChunkDelayMs: 250
    })
    stubs.push(stub)
    const providerId = seedCustom('openai-completions', stub.baseUrl, 'stored')

    const pending = testProviderConnection(database, secrets, {}, { providerId })
    await waitUntil(() => stub.requests.length === 1)
    database
      .prepare(
        `UPDATE model_provider SET secret_ciphertext = ?, updated_at = ? WHERE id = ?`
      )
      .run(secrets.encrypt('sk-replaced-key'), '2099-01-02T00:00:00.000Z', providerId)

    const result = await pending

    expect(result).toMatchObject({ status: 'verified', persisted: false })
    expect(readModelProvider(database, providerId)).toMatchObject({
      secretCiphertext: secrets.encrypt('sk-replaced-key'),
      verification: 'unverified'
    })
  })
})
