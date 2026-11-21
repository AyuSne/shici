import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { unusedBaseUrl } from '../../testing/sse-stub'
import { startModelListStub, type ModelListStub } from '../../testing/model-list-stub'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { fetchProviderModels, modelsListEndpoint } from './model-discovery'
import { createCustomProvider } from './provider-editing'
import { readProviderModels } from './providers'
import { addBuiltinProvider } from './provider-writes'
import type { SecretStore } from './secret-store'

let directory: string
let database: AppDatabase
const stubs: ModelListStub[] = []

/** 可控替身：加密只是打标记；测试密钥全是合成值。 */
const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${plain}`,
  decrypt: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-model-discovery-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
})

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function stubWith(script: Parameters<typeof startModelListStub>[0]): Promise<ModelListStub> {
  const stub = await startModelListStub(script)
  stubs.push(stub)
  return stub
}

describe('OpenAI 协议模型列表', () => {
  it('OpenAI Chat Completions：GET {base}/models，保留路径前缀并带 Bearer 当前密钥', async () => {
    const stub = await stubWith({
      body: JSON.stringify({ data: [{ id: 'alpha' }, { id: 'beta' }] })
    })

    const result = await fetchProviderModels(database, secrets, {}, {
      source: 'custom',
      protocol: 'openai-completions',
      baseUrl: `${stub.baseUrl}/relay/openai/v1`,
      authMode: 'stored',
      apiKey: 'sk-synthetic-0001'
    })

    expect(result).toEqual({
      status: 'fetched',
      candidates: [
        {
          modelId: 'alpha',
          displayName: 'alpha',
          contextWindow: null,
          maxTokens: null,
          reasoning: null,
          origin: 'remote'
        },
        {
          modelId: 'beta',
          displayName: 'beta',
          contextWindow: null,
          maxTokens: null,
          reasoning: null,
          origin: 'remote'
        }
      ]
    })
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0]?.method).toBe('GET')
    expect(stub.requests[0]?.url).toBe('/relay/openai/v1/models')
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-synthetic-0001')
  })

  it('上游明确给出思考能力时如实保留；没有字段就是未知，不伪造 false', async () => {
    const stub = await stubWith({
      body: JSON.stringify({
        data: [
          { id: 'reasoner', reasoning: true },
          { id: 'plain-model', reasoning: false },
          { id: 'unknown-model' }
        ]
      })
    })

    const result = await fetchProviderModels(database, secrets, {}, {
      source: 'custom',
      protocol: 'openai-completions',
      baseUrl: stub.baseUrl,
      authMode: 'stored',
      apiKey: 'sk-synthetic-0009'
    })

    if (result.status !== 'fetched') throw new Error('unreachable')
    expect(result.candidates.map((candidate) => candidate.reasoning)).toEqual([
      true,
      false,
      null
    ])
  })

  it('OpenAI Responses：同一套 GET {base}/models 与 Bearer 头，不追加 chat 路径', async () => {
    const stub = await stubWith({
      body: JSON.stringify({ data: [{ id: 'gpt-x' }] })
    })

    const result = await fetchProviderModels(database, secrets, {}, {
      source: 'custom',
      protocol: 'openai-responses',
      baseUrl: `${stub.baseUrl}/v1`,
      authMode: 'stored',
      apiKey: 'sk-synthetic-0002'
    })

    expect(result).toMatchObject({ status: 'fetched' })
    expect(stub.requests[0]?.url).toBe('/v1/models')
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-synthetic-0002')
  })
})

describe('Anthropic 协议模型列表', () => {
  it('GET {root}/v1/models?limit=1000，带 x-api-key 与 anthropic-version', async () => {
    const stub = await stubWith({
      body: JSON.stringify({
        data: [
          { id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5', type: 'model' }
        ]
      })
    })

    const result = await fetchProviderModels(database, secrets, {}, {
      source: 'custom',
      protocol: 'anthropic-messages',
      baseUrl: stub.baseUrl,
      authMode: 'stored',
      apiKey: 'sk-ant-synthetic-0003'
    })

    expect(result).toEqual({
      status: 'fetched',
      candidates: [
        {
          modelId: 'claude-sonnet-4-5',
          displayName: 'Claude Sonnet 4.5',
          contextWindow: null,
          maxTokens: null,
          reasoning: null,
          origin: 'remote'
        }
      ]
    })
    expect(stub.requests[0]?.url).toBe('/v1/models?limit=1000')
    expect(stub.requests[0]?.headers['x-api-key']).toBe('sk-ant-synthetic-0003')
    expect(stub.requests[0]?.headers['anthropic-version']).toBe('2023-06-01')
  })

  it('地址已经带 /v1 时不重复拼成 /v1/v1', async () => {
    const stub = await stubWith({ body: JSON.stringify({ data: [{ id: 'claude' }] }) })

    await fetchProviderModels(database, secrets, {}, {
      source: 'custom',
      protocol: 'anthropic-messages',
      baseUrl: `${stub.baseUrl}/anthropic/v1`,
      authMode: 'stored',
      apiKey: 'sk-ant-synthetic-0004'
    })

    expect(stub.requests[0]?.url).toBe('/anthropic/v1/models?limit=1000')
  })
})

describe('Gemini 协议模型列表', () => {
  it('GET {base}/models?pageSize=1000，用 x-goog-api-key，过滤无生成能力条目并去掉 models/ 前缀', async () => {
    const stub = await stubWith({
      body: JSON.stringify({
        models: [
          {
            name: 'models/gemini-2.5-pro',
            displayName: 'Gemini 2.5 Pro',
            supportedGenerationMethods: ['generateContent', 'countTokens'],
            inputTokenLimit: 1_048_576,
            outputTokenLimit: 65_536
          },
          {
            name: 'models/text-embedding-004',
            displayName: 'Text Embedding',
            supportedGenerationMethods: ['embedContent'],
            inputTokenLimit: 2_048,
            outputTokenLimit: 1
          },
          {
            name: 'gemini-2.5-flash',
            displayName: 'Gemini 2.5 Flash',
            supportedGenerationMethods: ['streamGenerateContent'],
            inputTokenLimit: 1_000_000,
            outputTokenLimit: 8_192
          }
        ]
      })
    })

    const result = await fetchProviderModels(database, secrets, {}, {
      source: 'custom',
      protocol: 'google-generative-ai',
      baseUrl: `${stub.baseUrl}/v1beta`,
      authMode: 'stored',
      apiKey: 'AIza-synthetic-0005'
    })

    expect(result).toEqual({
      status: 'fetched',
      candidates: [
        {
          modelId: 'gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          contextWindow: 1_048_576,
          maxTokens: 65_536,
          reasoning: null,
          origin: 'remote'
        },
        {
          modelId: 'gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          contextWindow: 1_000_000,
          maxTokens: 8_192,
          reasoning: null,
          origin: 'remote'
        }
      ]
    })
    expect(stub.requests[0]?.url).toBe('/v1beta/models?pageSize=1000')
    expect(stub.requests[0]?.headers['x-goog-api-key']).toBe('AIza-synthetic-0005')
  })
})

// 由后续红绿循环补齐：内置本地目录、凭据优先级、4 MiB、超时与失败分类。

describe('模型列表地址拼接的边界', () => {
  it('已带 /models 不重复，尾部斜杠与旧查询串都收干净', () => {
    expect(
      modelsListEndpoint('openai-completions', 'https://relay.example.com/v1/models/')
    ).toBe('https://relay.example.com/v1/models')
    expect(
      modelsListEndpoint('openai-responses', 'https://relay.example.com/v1?old=1')
    ).toBe('https://relay.example.com/v1/models')
    expect(
      modelsListEndpoint('anthropic-messages', 'https://api.anthropic.com/v1/')
    ).toBe('https://api.anthropic.com/v1/models?limit=1000')
    expect(
      modelsListEndpoint('google-generative-ai', 'https://generativelanguage.googleapis.com/v1beta/models/')
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000')
  })
})

describe('内置目录：候选也会排除已存在的模型', () => {
  it('knownModelIds 里已有的目录模型不再返回', async () => {
    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      source: 'builtin',
      catalogProviderId: 'deepseek',
      baseUrl: 'https://not-used.example.com',
      authMode: 'stored',
      knownModelIds: [' deepseek-flash ']
    }))

    if (result.status !== 'fetched') throw new Error('unreachable')
    expect(result.candidates.map((candidate) => candidate.modelId)).toEqual([
      'deepseek-v4-pro'
    ])
  })
})

function requestOf(
  patch: Partial<Parameters<typeof fetchProviderModels>[3]>
): Parameters<typeof fetchProviderModels>[3] {
  return {
    source: 'custom',
    protocol: 'openai-completions',
    baseUrl: 'https://relay.example.com/v1',
    authMode: 'stored',
    ...patch
  }
}

function snapshot(): unknown {
  return {
    providers: database
      .prepare(
        `SELECT id, provider_key, auth_mode, env_var, secret_ciphertext, verification,
                default_model_id, updated_at
           FROM model_provider ORDER BY id`
      )
      .all(),
    models: database
      .prepare(
        `SELECT id, provider_id, model_id, source, sort, updated_at
           FROM model_provider_model ORDER BY id`
      )
      .all()
  }
}

function createStoredRelay(patch: Partial<Parameters<typeof createCustomProvider>[2]> = {}) {
  const result = createCustomProvider(database, secrets, {
    providerKey: 'relay-seeded',
    displayName: 'Seeded Relay',
    protocol: 'openai-completions',
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-saved-synthetic-7777',
    model: { modelId: 'seeded-model' },
    ...patch
  })
  if (result.status !== 'saved') {
    throw new Error(`seed provider failed: ${JSON.stringify(result)}`)
  }
  return result.providerId
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition was not met in time')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('内置目录：永远本地、零 HTTP', () => {
  it('DeepSeek 即使表单地址指向别的服务也直接返回本地目录，不解析密钥', async () => {
    const stub = await stubWith({ body: JSON.stringify({ data: [{ id: 'wrong' }] }) })
    const decrypt = vi.fn(() => {
      throw new Error('must not decrypt')
    })

    const result = await fetchProviderModels(
      database,
      { encrypt: (plain) => plain, decrypt },
      {},
      requestOf({
        source: 'builtin',
        catalogProviderId: 'deepseek',
        baseUrl: stub.baseUrl,
        authMode: 'env',
        envVar: 'NOT_SET_ANYWHERE'
      })
    )

    expect(result).toMatchObject({ status: 'fetched' })
    if (result.status !== 'fetched') throw new Error('unreachable')
    expect(result.candidates.map((candidate) => candidate.modelId)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro'
    ])
    expect(result.candidates[0]).toEqual({
      modelId: 'deepseek-flash',
      displayName: expect.any(String),
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      reasoning: true,
      origin: 'catalog'
    })
    expect(stub.requests).toHaveLength(0)
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('OpenCode GO 也返回聚合本地目录（含 Anthropic / Gemini 模型），仍不联网', async () => {
    const stub = await stubWith({ body: '{"data":[]}' })
    createStoredRelay()
    database
      .prepare(
        `UPDATE model_provider
            SET source = 'builtin', catalog_provider_id = 'opencode-go'
          WHERE provider_key = 'relay-seeded'`
      )
      .run()

    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      source: 'builtin',
      catalogProviderId: 'opencode-go',
      baseUrl: stub.baseUrl,
      authMode: 'env',
      envVar: 'UNSET'
    }))

    if (result.status !== 'fetched') throw new Error('unreachable')
    const ids = result.candidates.map((candidate) => candidate.modelId)
    expect(ids).toContain('claude-haiku-5-5')
    expect(ids).toContain('gemini-4-argon')
    expect(ids).toContain('deepseek-v4-pro')
    expect(result.candidates.every((candidate) => candidate.origin === 'catalog')).toBe(true)
    expect(stub.requests).toHaveLength(0)
  })

  it('不认识的内置身份明确报 unknown-catalog，不发请求', async () => {
    const stub = await stubWith({ body: '{"data":[]}' })

    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      source: 'builtin',
      catalogProviderId: 'not-in-catalog',
      baseUrl: stub.baseUrl,
      authMode: 'stored'
    }))

    expect(result).toEqual({ status: 'rejected', reason: 'unknown-catalog' })
    expect(stub.requests).toHaveLength(0)
  })
})

describe('自定义 API 凭据优先级', () => {
  it('本机模式：明确编辑同一套 provider 且没填新密钥时复用它的已存密钥', async () => {
    const stub = await stubWith({ body: JSON.stringify({ data: [{ id: 'relay-model' }] }) })
    const providerId = createStoredRelay()

    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      providerId,
      baseUrl: stub.baseUrl,
      authMode: 'stored',
      apiKey: ''
    }))

    expect(result).toMatchObject({ status: 'fetched' })
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-saved-synthetic-7777')
    expect(JSON.stringify(result)).not.toContain('sk-saved-synthetic-7777')
  })

  it('本机模式：表单里的新密钥优先于已存密钥，且结果不回显密钥', async () => {
    const stub = await stubWith({ body: JSON.stringify({ data: [{ id: 'relay-model' }] }) })
    const providerId = createStoredRelay()

    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      providerId,
      baseUrl: stub.baseUrl,
      authMode: 'stored',
      apiKey: 'sk-replacement-synthetic-8888'
    }))

    expect(result).toMatchObject({ status: 'fetched' })
    expect(stub.requests[0]?.headers.authorization).toBe(
      'Bearer sk-replacement-synthetic-8888'
    )
    expect(JSON.stringify(result)).not.toContain('sk-replacement-synthetic-8888')
    expect(JSON.stringify(result)).not.toContain('sk-saved-synthetic-7777')
  })

  it('环境模式：只按表单当前变量名解析，忽略请求里的 apiKey 与遗留密文', async () => {
    const stub = await stubWith({ body: JSON.stringify({ data: [{ id: 'relay-model' }] }) })
    const providerId = createStoredRelay({
      authMode: 'env',
      envVar: 'E2E_OLD_NAME',
      apiKey: 'sk-should-be-ignored'
    })
    database
      .prepare(`UPDATE model_provider SET secret_ciphertext = 'legacy:stale' WHERE id = ?`)
      .run(providerId)
    const decrypt = vi.fn(() => {
      throw new Error('env mode must not decrypt')
    })

    const result = await fetchProviderModels(
      database,
      { encrypt: (plain) => plain, decrypt },
      { E2E_OLD_NAME: 'sk-env-old', E2E_NEW_NAME: 'sk-env-current' },
      requestOf({
        providerId,
        baseUrl: stub.baseUrl,
        authMode: 'env',
        envVar: 'E2E_NEW_NAME',
        apiKey: 'sk-request-must-be-ignored'
      })
    )

    expect(result).toMatchObject({ status: 'fetched' })
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-env-current')
    expect(decrypt).not.toHaveBeenCalled()
  })

  it('环境模式：缺变量名 / 变量没值都明确点名，不发请求', async () => {
    const stub = await stubWith({ body: '{"data":[]}' })

    await expect(
      fetchProviderModels(database, secrets, {}, requestOf({
        baseUrl: stub.baseUrl,
        authMode: 'env',
        envVar: '  '
      }))
    ).resolves.toEqual({
      status: 'rejected',
      reason: 'missing-credential',
      problem: 'env-var-unset'
    })

    await expect(
      fetchProviderModels(database, secrets, {}, requestOf({
        baseUrl: stub.baseUrl,
        authMode: 'env',
        envVar: 'E2E_MISSING_NAME'
      }))
    ).resolves.toEqual({
      status: 'rejected',
      reason: 'missing-credential',
      problem: 'env-missing',
      envVar: 'E2E_MISSING_NAME'
    })
    expect(stub.requests).toHaveLength(0)
  })

  it('环境变量名撞上对象继承属性时按缺失点名变量，不抛 TypeError 也不发请求', async () => {
    const stub = await stubWith({ body: '{"data":[]}' })

    for (const envVar of ['constructor', '__proto__']) {
      await expect(
        fetchProviderModels(database, secrets, {}, requestOf({
          baseUrl: stub.baseUrl,
          authMode: 'env',
          envVar
        })),
        envVar
      ).resolves.toEqual({
        status: 'rejected',
        reason: 'missing-credential',
        problem: 'env-missing',
        envVar
      })
    }
    expect(stub.requests).toHaveLength(0)
  })

  it('本机密文解不开：明确 credential-error，不回落环境变量，也不发请求', async () => {
    const stub = await stubWith({ body: '{"data":[]}' })
    const providerId = createStoredRelay()
    database
      .prepare(`UPDATE model_provider SET secret_ciphertext = 'not-decryptable' WHERE id = ?`)
      .run(providerId)

    const result = await fetchProviderModels(
      database,
      secrets,
      { DEEPSEEK_API_KEY: 'sk-env-fallback' },
      requestOf({ providerId, baseUrl: stub.baseUrl, authMode: 'stored', apiKey: '' })
    )

    expect(result).toEqual({
      status: 'rejected',
      reason: 'credential-error',
      problem: 'stored-decrypt-failed'
    })
    expect(stub.requests).toHaveLength(0)
  })

  it('新建未保存的自定义 API 缺少密钥时明确报缺失，不匿名请求', async () => {
    const stub = await stubWith({ body: JSON.stringify({ data: [{ id: 'local-model' }] }) })
    createStoredRelay()

    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      baseUrl: stub.baseUrl,
      authMode: 'stored',
      apiKey: '   '
    }))

    expect(result).toEqual({
      status: 'rejected',
      reason: 'missing-credential',
      problem: 'stored-missing'
    })
    expect(stub.requests).toHaveLength(0)
  })

  it('编辑一套没有密文的自定义 provider 时也报缺失，不借用任何密钥', async () => {
    const stub = await stubWith({ body: JSON.stringify({ data: [{ id: 'relay-model' }] }) })
    const providerId = createStoredRelay()
    database
      .prepare('UPDATE model_provider SET secret_ciphertext = NULL WHERE id = ?')
      .run(providerId)

    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      providerId,
      baseUrl: stub.baseUrl,
      authMode: 'stored',
      apiKey: ''
    }))

    expect(result).toEqual({
      status: 'rejected',
      reason: 'missing-credential',
      problem: 'stored-missing'
    })
    expect(stub.requests).toHaveLength(0)
  })

  it('providerId 指向内置 provider 时拒绝跨 provider 借密钥，不发请求', async () => {
    const stub = await stubWith({ body: '{"data":[]}' })
    const added = addBuiltinProvider(database, secrets, {
      catalogProviderId: 'deepseek',
      apiKey: 'sk-builtin-synthetic'
    })
    if (added.status !== 'saved') throw new Error('seed failed')

    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      providerId: added.providerId,
      baseUrl: stub.baseUrl,
      authMode: 'stored',
      apiKey: ''
    }))

    expect(result).toEqual({ status: 'rejected', reason: 'provider-mismatch' })
    expect(stub.requests).toHaveLength(0)
  })

  it('providerId 不存在时报 unknown-provider，不静默当无密钥请求', async () => {
    const stub = await stubWith({ body: '{"data":[]}' })

    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      providerId: 'no-such-provider',
      baseUrl: stub.baseUrl,
      authMode: 'stored',
      apiKey: ''
    }))

    expect(result).toEqual({ status: 'rejected', reason: 'unknown-provider' })
    expect(stub.requests).toHaveLength(0)
  })
})

describe('获取结果交给保存路径', () => {
  it('列表没给思考能力时，保存已知模型仍沿用本地目录的思考能力与 compat', async () => {
    const stub = await stubWith({
      body: JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }] })
    })
    const fetched = await fetchProviderModels(database, secrets, {}, requestOf({
      baseUrl: stub.baseUrl,
      authMode: 'stored',
      apiKey: 'sk-synthetic-0010'
    }))
    if (fetched.status !== 'fetched') throw new Error('unreachable')
    expect(fetched.candidates[0]).toMatchObject({
      modelId: 'deepseek-v4-pro',
      reasoning: null
    })

    // 界面在 reasoning 为 null 时不把 false 塞进草稿；保存时由目录/兜底补上。
    const created = createCustomProvider(database, secrets, {
      providerKey: 'fetched-known',
      displayName: 'Fetched Known',
      protocol: 'openai-completions',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-save-synthetic',
      model: {
        modelId: 'deepseek-v4-pro',
        displayName: 'DeepSeek V4 Pro',
        source: 'fetched'
      }
    })
    if (created.status !== 'saved') throw new Error(JSON.stringify(created))

    expect(readProviderModels(database, created.providerId)[0]).toMatchObject({
      modelId: 'deepseek-v4-pro',
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      compat: { thinkingFormat: 'deepseek' }
    })
  })
})

describe('请求与解析失败', () => {
  it('协议不认识 / 地址不合法都不发请求', async () => {
    const stub = await stubWith({ body: '{"data":[]}' })

    await expect(
      fetchProviderModels(database, secrets, {}, requestOf({
        protocol: null,
        baseUrl: stub.baseUrl
      }))
    ).resolves.toEqual({ status: 'rejected', reason: 'unsupported-protocol' })

    await expect(
      fetchProviderModels(database, secrets, {}, requestOf({ baseUrl: 'not a url' }))
    ).resolves.toEqual({ status: 'rejected', reason: 'invalid-base-url' })
    expect(stub.requests).toHaveLength(0)
  })

  it('HTTP 失败只回状态码，不回传上游正文（正文可能回显密钥）', async () => {
    const stub = await stubWith({
      status: 401,
      body: JSON.stringify({ error: { message: 'SECRET-ECHO-sk-synthetic-0009' } })
    })

    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      baseUrl: stub.baseUrl,
      apiKey: 'sk-synthetic-0009'
    }))

    expect(result).toEqual({
      status: 'rejected',
      reason: 'http-error',
      httpStatus: 401
    })
    expect(JSON.stringify(result)).not.toContain('SECRET-ECHO')
    expect(JSON.stringify(result)).not.toContain('sk-synthetic-0009')
  })

  it('JSON 坏了或结构不对都报 invalid-format，且不改任何表', async () => {
    const stub = await stubWith({ body: '{"data": [broken' })
    const providerId = createStoredRelay()
    const before = snapshot()

    await expect(
      fetchProviderModels(database, secrets, {}, requestOf({
        providerId,
        baseUrl: stub.baseUrl,
        authMode: 'stored'
      }))
    ).resolves.toEqual({ status: 'rejected', reason: 'invalid-format' })

    stub.setScript({ body: '{"data": {}}' })
    await expect(
      fetchProviderModels(database, secrets, {}, requestOf({
        providerId,
        baseUrl: stub.baseUrl,
        authMode: 'stored'
      }))
    ).resolves.toEqual({ status: 'rejected', reason: 'invalid-format' })

    expect(snapshot()).toEqual(before)
  })

  it('候选按 id 去重，并排除已知（已在目录或草稿）的 id', async () => {
    const stub = await stubWith({
      body: JSON.stringify({
        data: [{ id: 'alpha' }, { id: 'alpha' }, { id: 'beta' }, { id: 'beta' }]
      })
    })

    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      baseUrl: stub.baseUrl,
      apiKey: 'sk-synthetic-0010',
      knownModelIds: ['beta', ' beta ']
    }))

    expect(result).toEqual({
      status: 'fetched',
      candidates: [
        {
          modelId: 'alpha',
          displayName: 'alpha',
          contextWindow: null,
          maxTokens: null,
          reasoning: null,
          origin: 'remote'
        }
      ]
    })
  })

  it('连不上服务端报 transport；地址被转发到别处时不自动跟随', async () => {
    const closed = await unusedBaseUrl()

    await expect(
      fetchProviderModels(database, secrets, {}, requestOf({
        baseUrl: closed,
        apiKey: 'sk-synthetic-0011'
      }))
    ).resolves.toEqual({ status: 'rejected', reason: 'transport' })

    const redirect = await stubWith({
      status: 302,
      headers: { location: 'http://127.0.0.1:1/elsewhere' },
      body: ''
    })
    await expect(
      fetchProviderModels(database, secrets, {}, requestOf({
        baseUrl: redirect.baseUrl,
        apiKey: 'sk-synthetic-0011'
      }))
    ).resolves.toEqual({
      status: 'rejected',
      reason: 'http-error',
      httpStatus: 302
    })
    expect(redirect.requests).toHaveLength(1)
  })
})

describe('4 MiB 实际字节边界', () => {
  const LIMIT = 4 * 1024 * 1024
  const baseJson = '{"data":[{"id":"big-model"}]}'

  function bodySized(bytes: number): string {
    return baseJson + ' '.repeat(bytes - baseJson.length)
  }

  it('正好 4 MiB 的合法 JSON 接受', async () => {
    const stub = await stubWith({ body: bodySized(LIMIT), contentLength: LIMIT })

    const result = await fetchProviderModels(database, secrets, {}, requestOf({
      baseUrl: stub.baseUrl,
      apiKey: 'sk-synthetic-0012'
    }))

    expect(result).toEqual({
      status: 'fetched',
      candidates: [
        {
          modelId: 'big-model',
          displayName: 'big-model',
          contextWindow: null,
          maxTokens: null,
          reasoning: null,
          origin: 'remote'
        }
      ]
    })
  })

  it('多 1 字节即使没有 Content-Length（chunked）也拒绝', async () => {
    const stub = await stubWith({ body: bodySized(LIMIT + 1), contentLength: null })

    await expect(
      fetchProviderModels(database, secrets, {}, requestOf({
        baseUrl: stub.baseUrl,
        apiKey: 'sk-synthetic-0013'
      }))
    ).resolves.toEqual({ status: 'rejected', reason: 'too-large' })
  })

  it('超限时取消正文读取，不等整个响应结束', async () => {
    const cancel = vi.fn()
    const oversized = new Uint8Array(LIMIT + 1)
    const fetchImpl = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(oversized)
            // 故意不 close：只有取消读取才能结束这个响应。
          },
          cancel
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )

    const result = await fetchProviderModels(
      database,
      secrets,
      {},
      requestOf({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-synthetic-0013b' }),
      { fetchImpl }
    )

    expect(result).toEqual({ status: 'rejected', reason: 'too-large' })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('Content-Length 故意写小也不信任：实际流出的字节超限仍拒绝', async () => {
    // 原生 fetch 会按 Content-Length 截断正文并报 framing 错；这里直接替换
    // HTTP 边界，验证服务自己按流式字节数判断，而不是相信这个头。
    const oversized = new Uint8Array(LIMIT + 1)
    const fetchImpl = async (): Promise<Response> =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(oversized)
            controller.close()
          }
        }),
        { status: 200, headers: { 'content-length': '100' } }
      )

    const result = await fetchProviderModels(
      database,
      secrets,
      {},
      requestOf({ baseUrl: 'https://relay.example.com/v1', apiKey: 'sk-synthetic-0014' }),
      { fetchImpl }
    )

    expect(result).toEqual({ status: 'rejected', reason: 'too-large' })
  })

  it('Content-Length 声明超限时提前拒绝，不读正文', async () => {
    const stub = await stubWith({
      body: '{"data":[]}',
      contentLength: LIMIT + 1,
      bodyDelayMs: 5_000
    })

    const started = Date.now()
    await expect(
      fetchProviderModels(database, secrets, {}, requestOf({
        baseUrl: stub.baseUrl,
        apiKey: 'sk-synthetic-0015'
      }))
    ).resolves.toEqual({ status: 'rejected', reason: 'too-large' })
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

describe('超时覆盖响应头与正文', () => {
  it('响应头迟迟不来：超时并取消连接', async () => {
    const stub = await stubWith({ body: '{"data":[]}', headersDelayMs: 5_000 })

    const result = await fetchProviderModels(
      database,
      secrets,
      {},
      requestOf({ baseUrl: stub.baseUrl, apiKey: 'sk-synthetic-0016' }),
      { timeoutMs: 100 }
    )

    expect(result).toEqual({ status: 'rejected', reason: 'timeout' })
    await waitFor(() => stub.abortedConnections === 1)
  })

  it('正文读到一半挂起：超时、取消读取并清掉计时器', async () => {
    const stub = await stubWith({
      body: '{"data":[{"id":"slow"}]}',
      contentLength: null,
      hangAfterBytes: 5
    })

    const result = await fetchProviderModels(
      database,
      secrets,
      {},
      requestOf({ baseUrl: stub.baseUrl, apiKey: 'sk-synthetic-0017' }),
      { timeoutMs: 100 }
    )

    expect(result).toEqual({ status: 'rejected', reason: 'timeout' })
    await waitFor(() => stub.abortedConnections === 1)
  })
})
