import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateCustomProviderRequest,
  UpdateProviderRequest
} from '../../shared/model-providers'
import { resolveChatConfig } from '../chat/config'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import {
  addProviderModel,
  createCustomProvider,
  deleteProviderModel,
  reorderProviderModels,
  updateModelProvider,
  updateProviderModel
} from './provider-editing'
import {
  addBuiltinProvider,
  activateModelProvider,
  setDefaultProviderModel
} from './provider-writes'
import {
  listModelProviders,
  readActiveChatProvider,
  readModelProvider,
  readProviderModels
} from './providers'
import type { SecretStore } from './secret-store'

let directory: string
let database: AppDatabase

const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (sealed) =>
    sealed.startsWith('sealed:')
      ? Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')
      : null
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-provider-editing-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function summaries() {
  return listModelProviders(database, { secrets, env: {} })
}

function addDeepSeek(apiKey = 'sk-deepseek-0001'): string {
  const result = addBuiltinProvider(database, secrets, {
    catalogProviderId: 'deepseek',
    apiKey
  })
  if (result.status !== 'saved') {
    throw new Error(`DeepSeek 没存上：${JSON.stringify(result)}`)
  }
  return result.providerId
}

function relayRequest(
  patch: Partial<CreateCustomProviderRequest> = {}
): CreateCustomProviderRequest {
  return {
    providerKey: 'my-relay',
    displayName: '我的中转',
    protocol: 'openai-completions',
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-relay-0001',
    model: { modelId: 'relay-model' },
    ...patch
  }
}

function createRelay(patch: Partial<CreateCustomProviderRequest> = {}): string {
  const result = createCustomProvider(database, secrets, relayRequest(patch))
  if (result.status !== 'saved') {
    throw new Error(`自定义 provider 没存上：${JSON.stringify(result)}`)
  }
  return result.providerId
}

describe('createCustomProvider', () => {
  it('按表单保存自定义 provider 与首个模型：密钥只落密文，未知模型走通用容量兜底', () => {
    const result = createCustomProvider(database, secrets, relayRequest())

    expect(result).toEqual({
      status: 'saved',
      providerId: expect.any(String),
      providerKey: 'my-relay'
    })
    if (result.status !== 'saved') return

    const provider = readModelProvider(database, result.providerId)
    expect(provider).toMatchObject({
      providerKey: 'my-relay',
      displayName: '我的中转',
      protocol: 'openai-completions',
      baseUrl: 'https://relay.example.com/v1',
      authMode: 'stored',
      envVar: null,
      retryPolicy: { mode: 'normal' },
      verification: 'unverified',
      lastError: null,
      lastCheckedAt: null,
      lastVerifiedAt: null,
      source: 'custom',
      catalogProviderId: null
    })
    expect(provider?.secretCiphertext).toBe(secrets.encrypt('sk-relay-0001'))

    const models = readProviderModels(database, result.providerId)
    expect(models).toHaveLength(1)
    expect(models[0]).toMatchObject({
      modelId: 'relay-model',
      displayName: 'relay-model',
      api: 'openai-completions',
      baseUrl: null,
      contextWindow: null,
      maxTokens: null,
      input: 'text',
      reasoning: false,
      source: 'manual',
      sort: 0
    })
    expect(provider?.defaultModelRowId).toBe(models[0]?.id)

    const summary = summaries()[0]
    expect(summary).toMatchObject({
      providerKey: 'my-relay',
      source: 'custom',
      apiKeyMask: 'sk-·············0001',
      keyState: 'stored',
      defaultModelRowId: models[0]?.id
    })
    // 摘要里只有掩码，没有明文密钥。
    expect(JSON.stringify(summary)).not.toContain('sk-relay-0001')

    expect(activateModelProvider(database, result.providerId)).toMatchObject({
      status: 'activated'
    })
    expect(readActiveChatProvider(database, { secrets, env: {} })?.apiKey).toBe(
      'sk-relay-0001'
    )

    // 未知模型 ID 照常可发送：缺元数据时按 1,000,000 / 128,000 / text 兜底。
    const config = resolveChatConfig(database, secrets, {})
    expect(config).toMatchObject({
      apiKey: 'sk-relay-0001',
      baseUrl: 'https://relay.example.com/v1',
      model: 'relay-model',
      descriptor: {
        provider: 'my-relay',
        model: 'relay-model',
        api: 'openai-completions',
        baseUrl: 'https://relay.example.com/v1',
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        input: ['text'],
        reasoning: false
      }
    })
    expect(config?.missingCredential).toBeUndefined()
  })

  it('Provider ID 必须精确匹配小写字母开头的连字符单词，且不能与已有 provider 重名', () => {
    const invalidIds = [
      'Bad_Relay',
      '1relay',
      'my_relay',
      'my--relay',
      'my-relay-',
      '-relay',
      ''
    ]
    for (const providerKey of invalidIds) {
      expect(createCustomProvider(database, secrets, relayRequest({ providerKey }))).toEqual({
        status: 'rejected',
        reason: 'invalid-provider-id'
      })
    }
    expect(summaries()).toEqual([])

    addDeepSeek()
    expect(
      createCustomProvider(database, secrets, relayRequest({ providerKey: 'deepseek' }))
    ).toEqual({ status: 'rejected', reason: 'duplicate-provider-id' })
    expect(summaries()).toHaveLength(1)
  })

  it('密钥留空也允许保存（自部署/本地中转），不写空密文、不调用加密', () => {
    const encrypt = vi.fn(secrets.encrypt)
    const result = createCustomProvider(
      database,
      { encrypt, decrypt: secrets.decrypt },
      relayRequest({ apiKey: '   ' })
    )

    expect(result).toMatchObject({ status: 'saved' })
    expect(encrypt).not.toHaveBeenCalled()
    if (result.status !== 'saved') return
    expect(readModelProvider(database, result.providerId)?.secretCiphertext).toBeNull()
    expect(summaries()[0]).toMatchObject({ keyState: 'missing', apiKeyMask: null })
  })

  it('本机加密不可用时整体失败：不写半条 provider 或模型', () => {
    const failing: SecretStore = {
      encrypt: () => {
        throw new Error('safeStorage unavailable')
      },
      decrypt: () => null
    }

    expect(() => createCustomProvider(database, failing, relayRequest())).toThrow(
      'safeStorage unavailable'
    )
    expect(summaries()).toEqual([])
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM model_provider_model').get()
    ).toEqual({ count: 0 })
  })

  it('字段缺一不可，且只接受当前开放的协议；拒绝时一条都不写', () => {
    const rejected: Array<[Partial<CreateCustomProviderRequest>, string]> = [
      [{ displayName: '   ' }, 'missing-display-name'],
      [{ protocol: 'anthropic-messages' }, 'unsupported-protocol'],
      [{ protocol: 'not-a-protocol' as never }, 'unsupported-protocol'],
      [{ baseUrl: '   ' }, 'missing-base-url'],
      [{ baseUrl: 'relay.example.com/v1' }, 'invalid-base-url'],
      [{ baseUrl: 'ftp://relay.example.com' }, 'invalid-base-url'],
      [{ model: { modelId: '   ' } }, 'missing-model']
    ]
    for (const [patch, reason] of rejected) {
      expect(createCustomProvider(database, secrets, relayRequest(patch)), JSON.stringify(patch)).toEqual(
        { status: 'rejected', reason }
      )
    }
    expect(summaries()).toEqual([])
  })

  it('自定义 provider 可直接用环境变量创建：不落密文，模型编辑不改来源', () => {
    const result = createCustomProvider(
      database,
      secrets,
      relayRequest({
        authMode: 'env',
        envVar: ' CUSTOM_RELAY_KEY ',
        apiKey: 'sk-must-be-ignored'
      })
    )
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') return

    expect(readModelProvider(database, result.providerId)).toMatchObject({
      authMode: 'env',
      envVar: 'CUSTOM_RELAY_KEY',
      secretCiphertext: null
    })
    // 环境变量有值就是 env，没有就缺失；都只有变量名，没有掩码。
    expect(
      listModelProviders(database, {
        secrets,
        env: { CUSTOM_RELAY_KEY: 'env-key' }
      })[0]
    ).toMatchObject({ keyState: 'env', apiKeyMask: null, credentialError: null })
    expect(listModelProviders(database, { secrets, env: {} })[0]).toMatchObject({
      keyState: 'missing',
      envVar: 'CUSTOM_RELAY_KEY'
    })

    // 模型目录编辑只碰模型行：凭据来源与密文列保持原样。
    expect(
      addProviderModel(database, {
        providerId: result.providerId,
        model: { modelId: 'second-model' }
      })
    ).toMatchObject({ status: 'saved' })
    expect(readModelProvider(database, result.providerId)).toMatchObject({
      authMode: 'env',
      envVar: 'CUSTOM_RELAY_KEY',
      secretCiphertext: null
    })

    // 直接创建后就能用这套环境变量发请求。
    activateModelProvider(database, result.providerId)
    expect(
      resolveChatConfig(database, secrets, { CUSTOM_RELAY_KEY: 'env-key' })
    ).toMatchObject({
      apiKey: 'env-key',
      baseUrl: 'https://relay.example.com/v1',
      model: 'relay-model',
      providerId: result.providerId
    })
  })

  it('环境模式拒绝空变量名或非法变量名，不写半条配置', () => {
    for (const envVar of ['', '  ', '2-BAD', 'bad name']) {
      expect(
        createCustomProvider(
          database,
          secrets,
          relayRequest({ authMode: 'env', envVar, apiKey: '' })
        ),
        envVar
      ).toEqual({ status: 'rejected', reason: 'invalid-env-var' })
    }
    expect(summaries()).toEqual([])
  })
})

describe('updateModelProvider', () => {
  it('只改显示名与地址；Provider ID 与协议创建后不可改，改地址会重置验证状态', () => {
    const providerId = createRelay()
    const modelId = readProviderModels(database, providerId)[0]!.id
    database
      .prepare(
        `UPDATE model_provider
            SET verification = 'verified', last_error = 'network',
                last_checked_at = '2026-11-20T08:00:00.000Z',
                last_verified_at = '2026-11-20T08:00:00.000Z'
          WHERE id = ?`
      )
      .run(providerId)

    const result = updateModelProvider(database, {
      providerId,
      displayName: '中转二号',
      baseUrl: 'https://relay-2.example.com/v2'
    } as UpdateProviderRequest)

    expect(result).toEqual({ status: 'saved' })
    expect(readModelProvider(database, providerId)).toMatchObject({
      providerKey: 'my-relay',
      protocol: 'openai-completions',
      displayName: '中转二号',
      baseUrl: 'https://relay-2.example.com/v2',
      verification: 'unverified',
      lastError: null,
      lastCheckedAt: null,
      lastVerifiedAt: null,
      defaultModelRowId: modelId
    })
    expect(readProviderModels(database, providerId).map((model) => model.modelId)).toEqual([
      'relay-model'
    ])
  })

  it('改 Provider ID 或协议的请求字段被忽略，只改名字不动验证状态', () => {
    const providerId = createRelay()
    database
      .prepare(`UPDATE model_provider SET verification = 'verified' WHERE id = ?`)
      .run(providerId)

    const result = updateModelProvider(database, {
      providerId,
      displayName: '改个名字',
      baseUrl: 'https://relay.example.com/v1',
      providerKey: 'hacked',
      protocol: 'anthropic-messages'
    } as unknown as UpdateProviderRequest)

    expect(result).toEqual({ status: 'saved' })
    expect(readModelProvider(database, providerId)).toMatchObject({
      providerKey: 'my-relay',
      protocol: 'openai-completions',
      displayName: '改个名字',
      verification: 'verified'
    })
  })

  it('拒绝空名字与非法地址，找不到 provider 时明确返回缺失', () => {
    const providerId = createRelay()

    expect(
      updateModelProvider(database, { providerId, displayName: ' ', baseUrl: 'https://x.test' })
    ).toEqual({ status: 'rejected', reason: 'missing-display-name' })
    expect(
      updateModelProvider(database, {
        providerId,
        displayName: '名字',
        baseUrl: '  '
      })
    ).toEqual({ status: 'rejected', reason: 'missing-base-url' })
    expect(
      updateModelProvider(database, {
        providerId,
        displayName: '名字',
        baseUrl: 'not a url'
      })
    ).toEqual({ status: 'rejected', reason: 'invalid-base-url' })
    expect(
      updateModelProvider(database, {
        providerId: 'missing',
        displayName: '名字',
        baseUrl: 'https://x.test'
      })
    ).toEqual({ status: 'missing' })
  })
})

describe('addProviderModel', () => {
  it('内置 provider 可手加目录外模型：追加在末尾、按未收录保存，默认模型不变', () => {
    const providerId = addDeepSeek()
    const before = readProviderModels(database, providerId)

    expect(
      addProviderModel(database, { providerId, model: { modelId: '  shiny-new-model  ' } })
    ).toEqual({ status: 'saved' })

    const models = readProviderModels(database, providerId)
    expect(models.map((model) => model.modelId)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
      'shiny-new-model'
    ])
    expect(models[2]).toMatchObject({
      displayName: 'shiny-new-model',
      api: 'openai-completions',
      contextWindow: null,
      maxTokens: null,
      input: 'text',
      reasoning: false,
      source: 'manual',
      sort: 2
    })
    expect(readModelProvider(database, providerId)?.defaultModelRowId).toBe(before[0]?.id)
  })

  it('自定义 provider 手加目录里常见的模型 ID 时带出目录元数据，仍记为手填', () => {
    const providerId = createRelay()

    expect(
      addProviderModel(database, { providerId, model: { modelId: 'deepseek-v4-pro' } })
    ).toEqual({ status: 'saved' })

    expect(readProviderModels(database, providerId)[1]).toMatchObject({
      modelId: 'deepseek-v4-pro',
      displayName: 'DeepSeek V4 Pro',
      contextWindow: 1000000,
      maxTokens: 384000,
      reasoning: true,
      input: 'text',
      source: 'manual',
      sort: 1
    })
  })

  it('拒绝空 ID、重复 ID 与不存在的 provider，目录一条不加', () => {
    const providerId = createRelay()
    const before = readProviderModels(database, providerId)

    expect(
      addProviderModel(database, { providerId, model: { modelId: '   ' } })
    ).toEqual({ status: 'rejected', reason: 'missing-model-id' })
    expect(
      addProviderModel(database, { providerId, model: { modelId: 'relay-model' } })
    ).toEqual({ status: 'rejected', reason: 'duplicate-model-id' })
    expect(
      addProviderModel(database, { providerId: 'missing', model: { modelId: 'x' } })
    ).toEqual({ status: 'missing' })
    expect(readProviderModels(database, providerId)).toEqual(before)
  })
})

describe('updateProviderModel', () => {
  it('改模型 ID、显示名与容量，保存后概览立刻按新值显示', () => {
    const providerId = createRelay()
    const row = readProviderModels(database, providerId)[0]!

    expect(
      updateProviderModel(database, {
        providerId,
        modelRowId: row.id,
        model: {
          modelId: 'relay-model-2',
          displayName: 'Relay Model 2',
          contextWindow: 32000,
          maxTokens: 4096,
          reasoning: true
        }
      })
    ).toEqual({ status: 'saved' })

    expect(readProviderModels(database, providerId)[0]).toMatchObject({
      id: row.id,
      modelId: 'relay-model-2',
      displayName: 'Relay Model 2',
      contextWindow: 32000,
      maxTokens: 4096,
      reasoning: true,
      api: 'openai-completions',
      sort: 0
    })
    expect(summaries()[0]?.models[0]).toMatchObject({
      modelId: 'relay-model-2',
      displayName: 'Relay Model 2'
    })
  })

  it('改模型 ID 时按新模型重算隐藏元数据：旧 DeepSeek compat 与思考映射不残留', () => {
    const providerId = createRelay({ model: { modelId: 'deepseek-flash' } })
    const row = readProviderModels(database, providerId)[0]!
    expect(row).toMatchObject({
      modelId: 'deepseek-flash',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      reasoning: true
    })
    expect(row.compat).toMatchObject({ thinkingFormat: 'deepseek' })
    expect(row.thinkingLevelMap).not.toBeNull()

    expect(
      updateProviderModel(database, {
        providerId,
        modelRowId: row.id,
        // 界面上只改 ID：容量与思考能力没有显式填写，按新模型的目录元数据重算。
        model: { modelId: 'glm-4.7' }
      })
    ).toEqual({ status: 'saved' })

    const next = readProviderModels(database, providerId)[0]!
    expect(next).toMatchObject({
      modelId: 'glm-4.7',
      displayName: 'GLM-4.7',
      contextWindow: 204_800,
      maxTokens: 131_072,
      input: 'text',
      reasoning: true
    })
    expect(next.compat).toMatchObject({ thinkingFormat: 'zai', supportsReasoningEffort: false })
    expect(next.thinkingLevelMap).toBeNull()

    // 发请求用的描述符与 pi 模型必须带新 compat，不能再按 DeepSeek 思考格式发。
    expect(activateModelProvider(database, providerId)).toMatchObject({ status: 'activated' })
    const config = resolveChatConfig(database, secrets, {})
    expect(config?.descriptor).toMatchObject({
      model: 'glm-4.7',
      contextWindow: 204_800,
      maxTokens: 131_072,
      reasoning: true,
      compat: { thinkingFormat: 'zai' }
    })
    expect(config?.descriptor.thinkingLevelMap).toBeUndefined()
  })

  it('改到目录外模型时清空旧元数据，缺容量留给发送层兜底', () => {
    const providerId = createRelay({ model: { modelId: 'deepseek-flash' } })
    const row = readProviderModels(database, providerId)[0]!
    // 逐模型地址属于旧身份：换 ID 后不能继续把新模型发到旧模型的地址。
    database
      .prepare('UPDATE model_provider_model SET base_url = ? WHERE id = ?')
      .run('https://old-model.example.com/v1', row.id)

    expect(
      updateProviderModel(database, {
        providerId,
        modelRowId: row.id,
        model: { modelId: 'mystery-model' }
      })
    ).toEqual({ status: 'saved' })

    const next = readProviderModels(database, providerId)[0]!
    expect(next).toMatchObject({
      modelId: 'mystery-model',
      displayName: 'mystery-model',
      baseUrl: null,
      contextWindow: null,
      maxTokens: null,
      input: 'text',
      reasoning: false,
      thinkingLevelMap: null,
      compat: null
    })

    expect(activateModelProvider(database, providerId)).toMatchObject({ status: 'activated' })
    const descriptor = resolveChatConfig(database, secrets, {})?.descriptor
    expect(descriptor).toMatchObject({
      model: 'mystery-model',
      baseUrl: 'https://relay.example.com/v1',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ['text'],
      reasoning: false
    })
    // 没有旧 DeepSeek 的思考格式或思考档位。
    expect(descriptor?.compat).toBeUndefined()
    expect(descriptor?.thinkingLevelMap).toBeUndefined()
  })

  it('改 ID 时用户显式给的容量与思考开关优先于新目录值', () => {
    const providerId = createRelay({ model: { modelId: 'deepseek-flash' } })
    const row = readProviderModels(database, providerId)[0]!

    expect(
      updateProviderModel(database, {
        providerId,
        modelRowId: row.id,
        model: {
          modelId: 'glm-4.7',
          contextWindow: 64_000,
          maxTokens: 4_096,
          reasoning: false
        }
      })
    ).toEqual({ status: 'saved' })

    expect(readProviderModels(database, providerId)[0]).toMatchObject({
      modelId: 'glm-4.7',
      contextWindow: 64_000,
      maxTokens: 4_096,
      reasoning: false,
      // 隐藏元数据仍按新模型重算，不保留旧模型的 compat。
      compat: { thinkingFormat: 'zai' }
    })
  })

  it('同 ID 的普通编辑保留已调好的隐藏元数据与容量，不重算成目录默认值', () => {
    const providerId = createRelay({
      model: { modelId: 'deepseek-flash', contextWindow: 123_456, maxTokens: 7_890 }
    })
    const row = readProviderModels(database, providerId)[0]!
    // 模拟此前按用户环境保存的自定义思考映射/compat：同 ID 编辑时不能被目录值覆盖。
    database
      .prepare(
        `UPDATE model_provider_model
            SET thinking_level_map = ?, compat = ?
          WHERE id = ?`
      )
      .run('{"high":"custom-high"}', '{"thinkingFormat":"custom"}', row.id)

    expect(
      updateProviderModel(database, {
        providerId,
        modelRowId: row.id,
        model: { modelId: 'deepseek-flash', displayName: '我的 Flash' }
      })
    ).toEqual({ status: 'saved' })

    const next = readProviderModels(database, providerId)[0]!
    expect(next).toMatchObject({
      modelId: 'deepseek-flash',
      displayName: '我的 Flash',
      contextWindow: 123_456,
      maxTokens: 7_890,
      reasoning: true,
      thinkingLevelMap: { high: 'custom-high' },
      compat: { thinkingFormat: 'custom' }
    })
  })

  it('拒绝 0、小数与不安全大整数的容量，不把请求限制写坏', () => {
    const providerId = createRelay()
    const before = readProviderModels(database, providerId)

    const invalidCapacities = [
      { contextWindow: 0 },
      { maxTokens: 0 },
      { contextWindow: 1.5 },
      { maxTokens: Number.MAX_SAFE_INTEGER + 1 }
    ]
    for (const capacity of invalidCapacities) {
      expect(
        updateProviderModel(database, {
          providerId,
          modelRowId: before[0]!.id,
          model: { modelId: 'relay-model', ...capacity }
        }),
        JSON.stringify(capacity)
      ).toEqual({ status: 'rejected', reason: 'invalid-capacity' })
    }
    expect(readProviderModels(database, providerId)).toEqual(before)
  })

  it('拒绝空 ID、重复 ID、非法容量与不存在的模型行', () => {
    const providerId = createRelay()
    addProviderModel(database, { providerId, model: { modelId: 'other-model' } })
    const [first] = readProviderModels(database, providerId)

    expect(
      updateProviderModel(database, {
        providerId,
        modelRowId: first!.id,
        model: { modelId: '  ' }
      })
    ).toEqual({ status: 'rejected', reason: 'missing-model-id' })
    expect(
      updateProviderModel(database, {
        providerId,
        modelRowId: first!.id,
        model: { modelId: 'other-model' }
      })
    ).toEqual({ status: 'rejected', reason: 'duplicate-model-id' })
    expect(
      updateProviderModel(database, {
        providerId,
        modelRowId: first!.id,
        model: { modelId: 'ok', contextWindow: -1 }
      })
    ).toEqual({ status: 'rejected', reason: 'invalid-capacity' })
    expect(
      updateProviderModel(database, {
        providerId,
        modelRowId: 'missing-model',
        model: { modelId: 'ok' }
      })
    ).toEqual({ status: 'rejected', reason: 'unknown-model' })
  })
})

describe('deleteProviderModel', () => {
  it('默认模型必须先另选一个才能删；删完重新编号，最后一条永远留着', () => {
    const providerId = createRelay()
    addProviderModel(database, { providerId, model: { modelId: 'b-model' } })
    addProviderModel(database, { providerId, model: { modelId: 'c-model' } })
    const [first, second, third] = readProviderModels(database, providerId)

    expect(
      deleteProviderModel(database, { providerId, modelRowId: first!.id })
    ).toEqual({ status: 'rejected', reason: 'default-model' })

    expect(setDefaultProviderModel(database, providerId, second!.id)).toEqual({
      status: 'saved',
      defaultModelRowId: second!.id
    })
    expect(
      deleteProviderModel(database, { providerId, modelRowId: first!.id })
    ).toEqual({ status: 'deleted' })

    const remaining = readProviderModels(database, providerId)
    expect(remaining.map((model) => model.modelId)).toEqual(['b-model', 'c-model'])
    expect(remaining.map((model) => model.sort)).toEqual([0, 1])
    expect(readModelProvider(database, providerId)?.defaultModelRowId).toBe(second!.id)

    expect(
      deleteProviderModel(database, { providerId, modelRowId: second!.id })
    ).toEqual({ status: 'rejected', reason: 'default-model' })
    expect(setDefaultProviderModel(database, providerId, third!.id)).toMatchObject({
      status: 'saved'
    })
    expect(
      deleteProviderModel(database, { providerId, modelRowId: second!.id })
    ).toEqual({ status: 'deleted' })
    expect(
      deleteProviderModel(database, { providerId, modelRowId: third!.id })
    ).toEqual({ status: 'rejected', reason: 'last-model' })

    expect(
      deleteProviderModel(database, { providerId, modelRowId: 'missing-model' })
    ).toEqual({ status: 'rejected', reason: 'unknown-model' })
    expect(deleteProviderModel(database, { providerId: 'missing', modelRowId: 'x' })).toEqual({
      status: 'missing'
    })
  })
})

describe('OpenCode GO 的模型目录', () => {
  it('首版只读：能选默认模型，但手加、修改、删除与排序都被拒绝', () => {
    const now = '2026-11-21T00:00:00.000Z'
    database
      .prepare(
        `INSERT INTO model_provider (
           id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
           secret_ciphertext, retry_policy, verification, last_error, last_checked_at,
           last_verified_at, source, catalog_provider_id, default_model_id, created_at,
           updated_at
         ) VALUES ('provider-opencode', 'opencode-go', 'OpenCode GO', 'openai-completions',
                   NULL, 'env', 'OPENCODE_GO_API_KEY', NULL, '{"mode":"normal"}',
                   'unverified', NULL, NULL, NULL, 'builtin', 'opencode-go', 'model-a',
                   ?, ?)`
      )
      .run(now, now)
    const insertModel = database.prepare(
      `INSERT INTO model_provider_model (
         id, provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
         input, reasoning, thinking_level_map, compat, source, sort, created_at, updated_at
       ) VALUES (?, 'provider-opencode', ?, ?, 'openai-completions', NULL,
                 1000000, 131072, 'text', 1, NULL, NULL, 'catalog', ?, ?, ?)`
    )
    insertModel.run('model-a', 'model-a', 'Model A', 0, now, now)
    insertModel.run('model-b', 'model-b', 'Model B', 1, now, now)

    expect(
      addProviderModel(database, {
        providerId: 'provider-opencode',
        model: { modelId: 'new-model' }
      })
    ).toEqual({ status: 'rejected', reason: 'read-only' })
    expect(
      updateProviderModel(database, {
        providerId: 'provider-opencode',
        modelRowId: 'model-a',
        model: { modelId: 'renamed' }
      })
    ).toEqual({ status: 'rejected', reason: 'read-only' })
    expect(
      deleteProviderModel(database, { providerId: 'provider-opencode', modelRowId: 'model-a' })
    ).toEqual({ status: 'rejected', reason: 'read-only' })
    expect(
      reorderProviderModels(database, {
        providerId: 'provider-opencode',
        modelRowIds: ['model-b', 'model-a']
      })
    ).toEqual({ status: 'rejected', reason: 'read-only' })

    expect(
      setDefaultProviderModel(database, 'provider-opencode', 'model-b')
    ).toEqual({ status: 'saved', defaultModelRowId: 'model-b' })
    expect(readProviderModels(database, 'provider-opencode').map((model) => model.modelId)).toEqual(
      ['model-a', 'model-b']
    )
  })
})

describe('reorderProviderModels', () => {
  it('按拖拽/键盘给出的完整顺序保存，读回来的顺序与 sort 都跟着变', () => {
    const providerId = createRelay()
    addProviderModel(database, { providerId, model: { modelId: 'b-model' } })
    addProviderModel(database, { providerId, model: { modelId: 'c-model' } })
    const [first, second, third] = readProviderModels(database, providerId)

    expect(
      reorderProviderModels(database, {
        providerId,
        modelRowIds: [third!.id, first!.id, second!.id]
      })
    ).toEqual({ status: 'saved' })

    const models = readProviderModels(database, providerId)
    expect(models.map((model) => model.modelId)).toEqual([
      'c-model',
      'relay-model',
      'b-model'
    ])
    expect(models.map((model) => model.sort)).toEqual([0, 1, 2])
    expect(summaries()[0]?.models.map((model) => model.modelId)).toEqual([
      'c-model',
      'relay-model',
      'b-model'
    ])
  })

  it('顺序缺少、重复或多出行时拒绝，绝不打乱已存的顺序', () => {
    const providerId = createRelay()
    addProviderModel(database, { providerId, model: { modelId: 'b-model' } })
    const [first, second] = readProviderModels(database, providerId)

    for (const modelRowIds of [
      [first!.id],
      [first!.id, first!.id],
      [first!.id, second!.id, 'extra-model'],
      []
    ]) {
      expect(
        reorderProviderModels(database, { providerId, modelRowIds }),
        JSON.stringify(modelRowIds)
      ).toEqual({ status: 'rejected', reason: 'order-mismatch' })
    }
    expect(readProviderModels(database, providerId).map((model) => model.modelId)).toEqual([
      'relay-model',
      'b-model'
    ])
    expect(
      reorderProviderModels(database, { providerId: 'missing', modelRowIds: [] })
    ).toEqual({ status: 'missing' })
  })
})

describe('createCustomProvider 一次事务保存多个候选模型', () => {
  it('首个模型 + 显式选中的候选按顺序一起入库，保留 fetched 来源与目录/表单元数据', () => {
    const result = createCustomProvider(
      database,
      secrets,
      relayRequest({
        model: { modelId: 'relay-first', source: 'fetched' },
        additionalModels: [
          { modelId: 'deepseek-v4-pro', source: 'fetched' },
          {
            modelId: 'relay-third',
            displayName: 'Relay Third',
            contextWindow: 500_000,
            maxTokens: 100_000,
            reasoning: true
          }
        ]
      })
    )
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') return

    const provider = readModelProvider(database, result.providerId)
    const models = readProviderModels(database, result.providerId)
    expect(models.map((model) => model.modelId)).toEqual([
      'relay-first',
      'deepseek-v4-pro',
      'relay-third'
    ])
    expect(models.map((model) => model.sort)).toEqual([0, 1, 2])
    expect(models.map((model) => model.source)).toEqual(['fetched', 'fetched', 'manual'])
    expect(models[0]).toMatchObject({ displayName: 'relay-first', sort: 0 })
    // 候选里常见的目录 ID 仍带出目录元数据，但来源保持 fetched。
    expect(models[1]).toMatchObject({
      displayName: 'DeepSeek V4 Pro',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      reasoning: true,
      input: 'text',
      source: 'fetched',
      sort: 1
    })
    expect(models[2]).toMatchObject({
      displayName: 'Relay Third',
      contextWindow: 500_000,
      maxTokens: 100_000,
      reasoning: true,
      source: 'manual',
      sort: 2
    })
    // 默认模型仍是第一条；其它模型不抢默认。
    expect(provider?.defaultModelRowId).toBe(models[0]?.id)
  })

  it('环境模式也能一次保存多个候选：不落密文，模型来源与顺序保持', () => {
    const encrypt = vi.fn(secrets.encrypt)
    const result = createCustomProvider(
      database,
      { encrypt, decrypt: secrets.decrypt },
      relayRequest({
        authMode: 'env',
        envVar: 'CUSTOM_DISCOVERY_KEY',
        apiKey: 'sk-must-be-ignored',
        model: { modelId: 'env-first', source: 'fetched' },
        additionalModels: [{ modelId: 'env-second', source: 'fetched' }]
      })
    )
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') return

    expect(encrypt).not.toHaveBeenCalled()
    expect(readModelProvider(database, result.providerId)).toMatchObject({
      authMode: 'env',
      envVar: 'CUSTOM_DISCOVERY_KEY',
      secretCiphertext: null
    })
    expect(readProviderModels(database, result.providerId).map((model) => model.modelId)).toEqual([
      'env-first',
      'env-second'
    ])
    expect(readProviderModels(database, result.providerId).map((model) => model.source)).toEqual([
      'fetched',
      'fetched'
    ])
    expect(
      listModelProviders(database, {
        secrets,
        env: { CUSTOM_DISCOVERY_KEY: 'env-key' }
      })[0]
    ).toMatchObject({ keyState: 'env', apiKeyMask: null, credentialError: null })
  })

  it('重复 / 空 / 非法容量的额外模型整笔拒绝，不留下半条 provider 或模型', () => {
    const beforeProviders = database.prepare('SELECT COUNT(*) AS count FROM model_provider').get()
    const cases: Array<[CreateCustomProviderRequest['additionalModels'], string]> = [
      [[{ modelId: 'relay-model' }], 'duplicate-model-id'],
      [[{ modelId: 'relay-a' }, { modelId: 'relay-a' }], 'duplicate-model-id'],
      [[{ modelId: '   ' }], 'missing-model'],
      [[{ modelId: 'bad-capacity', contextWindow: -1 }], 'invalid-capacity'],
      [[{ modelId: 'zero-capacity', maxTokens: 0 }], 'invalid-capacity'],
      [[{ modelId: 'fraction-capacity', contextWindow: 1.5 }], 'invalid-capacity']
    ]

    for (const [additionalModels, reason] of cases) {
      expect(
        createCustomProvider(database, secrets, relayRequest({ additionalModels })),
        JSON.stringify(additionalModels)
      ).toEqual({ status: 'rejected', reason })
    }
    expect(database.prepare('SELECT COUNT(*) AS count FROM model_provider').get()).toEqual(
      beforeProviders
    )
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM model_provider_model').get()
    ).toEqual({ count: 0 })
  })
})

describe('addProviderModel 批量加入（获取可用模型后显式应用）', () => {
  it('一次事务追加所有候选：顺序接在末尾、来源保留 fetched、默认模型与已有行不动', () => {
    const providerId = createRelay()
    const before = readProviderModels(database, providerId)

    expect(
      addProviderModel(database, {
        providerId,
        model: { modelId: 'fetched-a', source: 'fetched' },
        additionalModels: [
          { modelId: 'deepseek-v4-pro', source: 'fetched' },
          { modelId: 'manual-b' }
        ]
      })
    ).toEqual({ status: 'saved' })

    const after = readProviderModels(database, providerId)
    expect(after.map((model) => model.modelId)).toEqual([
      'relay-model',
      'fetched-a',
      'deepseek-v4-pro',
      'manual-b'
    ])
    expect(after.map((model) => model.sort)).toEqual([0, 1, 2, 3])
    expect(after.slice(1).map((model) => model.source)).toEqual([
      'fetched',
      'fetched',
      'manual'
    ])
    expect(after[2]).toMatchObject({
      displayName: 'DeepSeek V4 Pro',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      reasoning: true
    })
    expect(readModelProvider(database, providerId)?.defaultModelRowId).toBe(before[0]?.id)
    expect(after[0]).toEqual(before[0])
  })

  it('批量里任一重复或容量非法就整批拒绝，不写部分行', () => {
    const providerId = createRelay()
    const before = readProviderModels(database, providerId)

    for (const request of [
      {
        model: { modelId: 'ok-a', source: 'fetched' as const },
        additionalModels: [{ modelId: 'relay-model' }]
      },
      {
        model: { modelId: 'ok-a', source: 'fetched' as const },
        additionalModels: [{ modelId: 'ok-b' }, { modelId: 'ok-b' }]
      },
      {
        model: { modelId: 'ok-a', source: 'fetched' as const },
        additionalModels: [{ modelId: 'ok-b', maxTokens: -5 }]
      }
    ]) {
      expect(
        addProviderModel(database, { providerId, ...request }),
        JSON.stringify(request)
      ).toEqual({ status: 'rejected', reason: expect.stringMatching(/duplicate-model-id|invalid-capacity/) })
    }
    expect(readProviderModels(database, providerId)).toEqual(before)
  })
})
