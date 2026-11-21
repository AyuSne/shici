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
    providerId: 'my-relay',
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
    for (const providerId of invalidIds) {
      expect(createCustomProvider(database, secrets, relayRequest({ providerId }))).toEqual({
        status: 'rejected',
        reason: 'invalid-provider-id'
      })
    }
    expect(summaries()).toEqual([])

    addDeepSeek()
    expect(createCustomProvider(database, secrets, relayRequest({ providerId: 'deepseek' }))).toEqual(
      { status: 'rejected', reason: 'duplicate-provider-id' }
    )
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

  it('字段缺一不可，且本票只开放 OpenAI Chat Completions；拒绝时一条都不写', () => {
    const rejected: Array<[Partial<CreateCustomProviderRequest>, string]> = [
      [{ displayName: '   ' }, 'missing-display-name'],
      [{ protocol: 'anthropic-messages' }, 'unsupported-protocol'],
      [{ protocol: 'openai-responses' }, 'unsupported-protocol'],
      [{ protocol: 'google-generative-ai' }, 'unsupported-protocol'],
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
