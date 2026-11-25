import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addBuiltinProvider,
  activateModelProvider,
  deleteModelProvider,
  setDefaultProviderModel
} from './provider-writes'
import { createCustomProvider } from './provider-editing'
import {
  isProviderSelectionCleared,
  listModelProviders,
  readActiveChatProvider,
  readActiveProviderId,
  readDefaultModel,
  readModelProvider,
  readProviderModels
} from './providers'
import type { SecretStore } from './secret-store'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate, migrations } from '../db/migrations'
import { AGGREGATE_PROTOCOL_STORAGE } from '../../shared/model-builtin'
import { askQuestion, createThread, readThreadView, saveAnswer } from '../chat/threads'

let directory: string
let databaseFile: string
let database: AppDatabase

/** 可逆的假加密：只用来观察明文有没有进入任何列。 */
const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (sealed) =>
    sealed.startsWith('sealed:')
      ? Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')
      : null
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-provider-writes-'))
  databaseFile = join(directory, 'test.db')
  database = openDatabase(databaseFile)
  migrate(database)
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

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

describe('addBuiltinProvider', () => {
  it('保存时零网络：端点、环境变量与整个模型目录来自内置目录，状态是未验证', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const providerId = addDeepSeek()

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()

    const provider = readModelProvider(database, providerId)
    expect(provider).toMatchObject({
      providerKey: 'deepseek',
      displayName: 'DeepSeek',
      protocol: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
      authMode: 'stored',
      envVar: 'DEEPSEEK_API_KEY',
      verification: 'unverified',
      lastError: null,
      lastCheckedAt: null,
      lastVerifiedAt: null,
      source: 'builtin',
      catalogProviderId: 'deepseek',
      retryPolicy: { mode: 'normal' }
    })
    expect(provider?.secretCiphertext).toBe(secrets.encrypt('sk-deepseek-0001'))

    const models = readProviderModels(database, providerId)
    expect(models.map((model) => model.modelId)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro'
    ])
    expect(models[0]).toMatchObject({
      api: 'openai-completions',
      contextWindow: 1000000,
      maxTokens: 384000,
      input: 'text',
      reasoning: true,
      source: 'catalog',
      thinkingLevelMap: {
        minimal: null,
        low: 'low',
        medium: null,
        high: 'high',
        max: 'max'
      },
      compat: {
        thinkingFormat: 'deepseek',
        requiresReasoningContentOnAssistantMessages: true
      }
    })
    expect(readDefaultModel(database, provider!)?.modelId).toBe('deepseek-flash')

    const summary = listModelProviders(database, { secrets, env: {} })[0]
    expect(summary).toMatchObject({
      providerKey: 'deepseek',
      catalogProviderId: 'deepseek',
      apiKeyMask: 'sk-·············0001',
      keyState: 'stored',
      defaultModelRowId: summary?.models[0]?.id,
      verification: 'unverified'
    })
    expect(summary?.models[0]?.modelId).toBe('deepseek-flash')
    // 摘要与数据库里都没有明文密钥。
    expect(JSON.stringify(summary)).not.toContain('sk-deepseek-0001')
    database.pragma('wal_checkpoint(TRUNCATE)')
    expect(readFileSync(databaseFile, 'utf8')).not.toContain('sk-deepseek-0001')
  })

  it('内置目录可以只用环境变量添加：不加密、不落密文，变量名可改且默认带出目录值', () => {
    const encrypt = vi.fn(secrets.encrypt)
    const result = addBuiltinProvider(
      database,
      { encrypt, decrypt: secrets.decrypt },
      {
        catalogProviderId: 'deepseek',
        authMode: 'env',
        envVar: ' MY_DEEPSEEK_KEY ',
        apiKey: 'sk-must-be-ignored'
      }
    )
    if (result.status !== 'saved') throw new Error('环境模式没存上')

    expect(encrypt).not.toHaveBeenCalled()
    const provider = readModelProvider(database, result.providerId)
    expect(provider).toMatchObject({
      authMode: 'env',
      envVar: 'MY_DEEPSEEK_KEY',
      secretCiphertext: null,
      source: 'builtin'
    })
    expect(listModelProviders(database, { secrets, env: {} })[0]).toMatchObject({
      keyState: 'missing',
      apiKeyMask: null,
      hasStoredCiphertext: false,
      credentialError: null
    })
    expect(
      listModelProviders(database, { secrets, env: { MY_DEEPSEEK_KEY: 'env-key-1' } })[0]
    ).toMatchObject({ keyState: 'env', apiKeyMask: null })

    // 不传变量名时用目录里的默认值。
    const defaulted = addBuiltinProvider(database, secrets, {
      catalogProviderId: 'kimi',
      authMode: 'env'
    })
    if (defaulted.status !== 'saved') throw new Error('Kimi 环境模式没存上')
    expect(readModelProvider(database, defaulted.providerId)).toMatchObject({
      authMode: 'env',
      envVar: 'MOONSHOT_API_KEY',
      secretCiphertext: null
    })
  })

  it('环境模式拒绝非法变量名；本机模式仍要求密钥', () => {
    expect(
      addBuiltinProvider(database, secrets, {
        catalogProviderId: 'deepseek',
        authMode: 'env',
        envVar: '2-bad-name'
      })
    ).toEqual({ status: 'rejected', reason: 'invalid-env-var' })
    expect(
      addBuiltinProvider(database, secrets, {
        catalogProviderId: 'deepseek',
        authMode: 'stored',
        envVar: 'OK_NAME',
        apiKey: '   '
      })
    ).toEqual({ status: 'rejected', reason: 'missing-key' })
    expect(listModelProviders(database, { secrets, env: {} })).toEqual([])
  })

  it('同一厂商可以保存多套：Provider ID 唯一且合法，目录身份仍是同一个', () => {
    const first = addDeepSeek('sk-one-1111')
    const second = addDeepSeek('sk-two-2222')

    const providers = listModelProviders(database, { secrets, env: {} })
    expect(providers.map((provider) => provider.providerKey)).toEqual([
      'deepseek',
      'deepseek-2'
    ])
    expect(providers.map((provider) => provider.catalogProviderId)).toEqual([
      'deepseek',
      'deepseek'
    ])
    expect(providers.map((provider) => provider.displayName)).toEqual([
      'DeepSeek',
      'DeepSeek 2'
    ])
    expect(providers.every((provider) => /^[a-z][a-z0-9-]*$/.test(provider.providerKey))).toBe(
      true
    )
    expect(first).not.toBe(second)
    // 第一套保存时库里还没有使用中的提供商，按本票要求直接接上；第二套不抢。
    expect(readActiveChatProvider(database, { secrets, env: {} })).toMatchObject({
      provider: { id: first },
      apiKey: 'sk-one-1111'
    })

    activateModelProvider(database, first)
    expect(readActiveChatProvider(database, { secrets, env: {} })?.apiKey).toBe('sk-one-1111')
    activateModelProvider(database, second)
    expect(readActiveChatProvider(database, { secrets, env: {} })?.apiKey).toBe('sk-two-2222')
  })

  it('Kimi 与 GLM 各自带出目录端点与模型，不从 DeepSeek 目录克隆', () => {
    expect(
      addBuiltinProvider(database, secrets, { catalogProviderId: 'kimi', apiKey: 'sk-kimi' })
    ).toMatchObject({ status: 'saved' })
    expect(
      addBuiltinProvider(database, secrets, { catalogProviderId: 'glm', apiKey: 'sk-glm' })
    ).toMatchObject({ status: 'saved' })

    const providers = listModelProviders(database, { secrets, env: {} })
    const kimi = providers.find((provider) => provider.providerKey === 'kimi')
    const glm = providers.find((provider) => provider.providerKey === 'glm')
    expect(kimi).toMatchObject({
      baseUrl: 'https://api.moonshot.cn/v1',
      envVar: 'MOONSHOT_API_KEY'
    })
    expect(kimi?.models[0]?.modelId).toBe('kimi-k2.6')
    expect(kimi?.models).toHaveLength(6)
    expect(kimi?.models[0]).toMatchObject({ contextWindow: 262144, maxTokens: 262144 })
    expect(glm).toMatchObject({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      envVar: 'ZAI_API_KEY'
    })
    expect(glm?.models[0]?.modelId).toBe('glm-4.7')
    expect(glm?.models).toHaveLength(7)
    expect(glm?.models[0]).toMatchObject({ contextWindow: 204800, maxTokens: 131072 })
  })

  it('OpenCode GO 作为聚合入口可添加：32 个模型各自带协议与地址，库内协议不冒充任何单一协议', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const added = addBuiltinProvider(database, secrets, {
      catalogProviderId: 'opencode-go',
      apiKey: 'sk-opencode-synthetic-0001'
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    expect(added).toMatchObject({ status: 'saved', providerKey: 'opencode-go' })
    if (added.status !== 'saved') return

    const provider = readModelProvider(database, added.providerId)
    expect(provider).toMatchObject({
      providerKey: 'opencode-go',
      displayName: 'OpenCode GO',
      // 读取层仍把「混合」协议按未知协议保护，不冒充 completions。
      protocol: null,
      baseUrl: null,
      envVar: 'OPENCODE_GO_API_KEY',
      source: 'builtin',
      catalogProviderId: 'opencode-go'
    })
    const stored = database
      .prepare('SELECT protocol, base_url FROM model_provider WHERE id = ?')
      .get(added.providerId) as { protocol: string; base_url: string | null }
    expect(stored.protocol).toBe(AGGREGATE_PROTOCOL_STORAGE)
    expect(stored.protocol).not.toBe('openai-completions')
    expect(stored.base_url).toBeNull()

    const models = readProviderModels(database, added.providerId)
    expect(models).toHaveLength(32)
    expect(new Set(models.map((model) => model.api))).toEqual(
      new Set([
        'openai-completions',
        'openai-responses',
        'anthropic-messages',
        'google-generative-ai'
      ])
    )
    expect(models.every((model) => model.baseUrl !== null)).toBe(true)
    expect(models.every((model) => model.source === 'catalog')).toBe(true)
    expect(models.find((model) => model.modelId === 'gemini-4-argon')).toMatchObject({
      api: 'google-generative-ai',
      baseUrl: 'https://opencode.ai/inference/go/google/v1beta'
    })

    const summary = listModelProviders(database, { secrets, env: {} })[0]
    expect(summary).toMatchObject({
      protocol: null,
      baseUrl: null,
      keyState: 'stored',
      catalogProviderId: 'opencode-go',
      apiKeyMask: 'sk-·············0001'
    })
    expect(summary?.models).toHaveLength(32)
    expect(JSON.stringify(summary)).not.toContain('sk-opencode-synthetic-0001')
  })

  it('OpenCode GO 可以保存第二套：Provider ID 唯一，目录身份仍是同一个聚合入口', () => {
    addBuiltinProvider(database, secrets, {
      catalogProviderId: 'opencode-go',
      apiKey: 'sk-go-one'
    })
    expect(
      addBuiltinProvider(database, secrets, {
        catalogProviderId: 'opencode-go',
        apiKey: 'sk-go-two'
      })
    ).toMatchObject({ status: 'saved', providerKey: 'opencode-go-2' })

    const providers = listModelProviders(database, { secrets, env: {} })
    expect(providers.map((provider) => provider.providerKey)).toEqual([
      'opencode-go',
      'opencode-go-2'
    ])
    expect(providers.map((provider) => provider.catalogProviderId)).toEqual([
      'opencode-go',
      'opencode-go'
    ])
    expect(providers.every((provider) => provider.models.length === 32)).toBe(true)
    expect(
      providers.every((provider) => provider.models.every((model) => model.api !== null))
    ).toBe(true)
  })

  it('拒绝目录之外的入口与空密钥，不写半条配置', () => {
    expect(
      addBuiltinProvider(database, secrets, {
        catalogProviderId: 'not-in-catalog',
        apiKey: 'sk-x'
      })
    ).toEqual({ status: 'rejected', reason: 'unknown-provider' })
    expect(
      addBuiltinProvider(database, secrets, {
        catalogProviderId: 'deepseek',
        apiKey: '   '
      })
    ).toEqual({ status: 'rejected', reason: 'missing-key' })
    expect(listModelProviders(database, { secrets, env: {} })).toEqual([])
  })

  it('迁移后的 custom provider 仍可按 provider 记录选择默认模型与删除，不写旧表', () => {
    database.close()
    const legacyFile = join(directory, 'legacy.db')
    const legacy = openDatabase(legacyFile)
    try {
      migrate(legacy, {
        migrations: migrations.filter((migration) => migration.version <= 13)
      })
      legacy
        .prepare(
          `INSERT INTO model_profile (
             id, name, base_url, model, api_key_secret, verification, last_error,
             last_checked_at, last_verified_at, created_at, updated_at
           ) VALUES ('profile-old', 'Old Backup', 'https://old.example.com/v1', 'old-model',
                     ?, 'unverified', NULL, NULL, NULL, '2026-11-18T09:00:00.000Z',
                     '2026-11-18T09:00:00.000Z')`
        )
        .run(secrets.encrypt('sk-old-key'))
    } finally {
      legacy.close()
    }
    database = openDatabase(legacyFile)
    migrate(database)

    expect(activateModelProvider(database, 'profile-old')).toMatchObject({
      status: 'activated'
    })
    expect(readActiveChatProvider(database, { secrets, env: {} })).toMatchObject({
      provider: { id: 'profile-old', source: 'custom', catalogProviderId: null },
      model: { modelId: 'old-model' },
      apiKey: 'sk-old-key'
    })

    const modelId = readProviderModels(database, 'profile-old')[0]!.id
    expect(setDefaultProviderModel(database, 'profile-old', modelId)).toEqual({
      status: 'saved',
      defaultModelRowId: modelId
    })

    // 旧表迁移后只读：任何运行时写它都会撞上这个哨兵。
    database.exec(`
      CREATE TRIGGER model_profile_read_only
      BEFORE UPDATE ON model_profile
      BEGIN
        SELECT RAISE(ABORT, 'model_profile is read-only after migration');
      END
    `)
    expect(deleteModelProvider(database, 'profile-old')).toEqual({
      status: 'deleted',
      activeCleared: true
    })
    expect(readActiveProviderId(database)).toBeNull()
  })
})

describe('保存新提供商后的使用中状态', () => {
  function addKimi(): string {
    const result = addBuiltinProvider(database, secrets, {
      catalogProviderId: 'kimi',
      apiKey: 'sk-kimi-first'
    })
    if (result.status !== 'saved') throw new Error('Kimi 没存上')
    return result.providerId
  }

  function customProvider(providerKey: string): string {
    const result = createCustomProvider(database, secrets, {
      providerKey,
      displayName: providerKey,
      protocol: 'openai-completions',
      baseUrl: 'https://custom.example.com/v1',
      authMode: 'stored',
      apiKey: 'sk-custom-first',
      model: { modelId: `${providerKey}-model` }
    })
    if (result.status !== 'saved') throw new Error('自定义提供商没存上')
    return result.providerId
  }

  it('库里还没有任何提供商：第一套保存后直接是使用中', () => {
    const providerId = addDeepSeek()

    expect(readActiveProviderId(database)).toBe(providerId)
    expect(listModelProviders(database, { secrets, env: {} })[0]).toMatchObject({
      id: providerId,
      active: true
    })
    expect(isProviderSelectionCleared(database)).toBe(false)
    expect(readActiveChatProvider(database, { secrets, env: {} })?.apiKey).toBe(
      'sk-deepseek-0001'
    )
  })

  it('已有提供商但一套都没使用：新保存的那套自动使用中，不只认第一条记录', () => {
    const existing = addDeepSeek()
    // 老资料库或恢复的备份可能只有 provider 行，没有使用中的选择。
    database.prepare(`DELETE FROM setting WHERE key = 'chat.activeProviderId'`).run()
    expect(readActiveProviderId(database)).toBeNull()

    const saved = addKimi()

    expect(readActiveProviderId(database)).toBe(saved)
    const providers = listModelProviders(database, { secrets, env: {} })
    expect(providers.find((provider) => provider.id === saved)?.active).toBe(true)
    expect(providers.find((provider) => provider.id === existing)?.active).toBe(false)
  })

  it('已有使用中的提供商：新保存的那套不抢当前选择', () => {
    const first = addDeepSeek()
    const second = addKimi()

    expect(first).not.toBe(second)
    expect(readActiveProviderId(database)).toBe(first)
    expect(
      listModelProviders(database, { secrets, env: {} }).find(
        (provider) => provider.id === second
      )?.active
    ).toBe(false)
  })

  it('用户明确删掉使用中的提供商后，新保存一套会重新成为使用中并清掉「已清空」标记', () => {
    const deleted = addDeepSeek()
    expect(deleteModelProvider(database, deleted)).toEqual({
      status: 'deleted',
      activeCleared: true
    })
    expect(isProviderSelectionCleared(database)).toBe(true)

    const saved = addKimi()

    expect(readActiveProviderId(database)).toBe(saved)
    expect(isProviderSelectionCleared(database)).toBe(false)
    expect(readActiveChatProvider(database, { secrets, env: {} })?.provider.id).toBe(saved)
  })

  it('自定义 API 同样适用：第一套保存后自动使用中，已有使用中时不覆盖', () => {
    const first = customProvider('first-relay')
    expect(readActiveProviderId(database)).toBe(first)

    const second = customProvider('second-relay')
    expect(readActiveProviderId(database)).toBe(first)
    expect(readActiveProviderId(database)).not.toBe(second)
  })
})

describe('setDefaultProviderModel', () => {
  it('只接受属于这个 provider 的模型行，选中后默认模型真正换掉', () => {
    const providerId = addDeepSeek()
    const [flash, pro] = readProviderModels(database, providerId)

    expect(
      setDefaultProviderModel(database, providerId, pro!.id)
    ).toEqual({ status: 'saved', defaultModelRowId: pro!.id })
    expect(readDefaultModel(database, readModelProvider(database, providerId)!)?.modelId).toBe(
      'deepseek-v4-pro'
    )

    const kimiId = addBuiltinProvider(database, secrets, {
      catalogProviderId: 'kimi',
      apiKey: 'sk-kimi'
    })
    if (kimiId.status !== 'saved') throw new Error('Kimi 没存上')
    const kimiModel = readProviderModels(database, kimiId.providerId)[0]!
    expect(setDefaultProviderModel(database, providerId, kimiModel.id)).toEqual({
      status: 'rejected',
      reason: 'unknown-model'
    })
    expect(setDefaultProviderModel(database, 'missing', flash!.id)).toEqual({
      status: 'missing'
    })
  })
})

describe('activateModelProvider', () => {
  it('切换使用中只写一个设置键，并清掉「已清空」标记；历史消息一条不动', () => {
    const providerId = addDeepSeek()
    const thread = createThread(database, { main: { kind: 'none' } })
    if (thread.status !== 'created') throw new Error('线程没建起来')
    const asked = askQuestion(database, { threadId: thread.thread.id, text: '你好' })
    if (asked.status !== 'asked') throw new Error('问题没写进去')
    const saved = saveAnswer(database, {
      threadId: thread.thread.id,
      questionId: asked.questionId,
      text: '旧回答',
      thinking: '',
      phase: 'done'
    })
    expect(saved.status).toBe('saved')
    const before = readThreadView(database, thread.thread.id)

    expect(activateModelProvider(database, providerId)).toEqual({
      status: 'activated',
      activeProviderId: providerId
    })
    expect(readActiveProviderId(database)).toBe(providerId)
    expect(isProviderSelectionCleared(database)).toBe(false)
    expect(readThreadView(database, thread.thread.id)).toEqual(before)
    expect(activateModelProvider(database, 'missing')).toEqual({ status: 'missing' })
  })
})

describe('deleteModelProvider', () => {
  it('删除使用中的 provider：清空选择并留明确标记，历史线程与钉住都不受影响', () => {
    const providerId = addDeepSeek()
    activateModelProvider(database, providerId)

    const thread = createThread(database, { main: { kind: 'none' } })
    if (thread.status !== 'created') throw new Error('线程没建起来')
    const asked = askQuestion(database, { threadId: thread.thread.id, text: '问题' })
    if (asked.status !== 'asked') throw new Error('问题没写进去')
    const saved = saveAnswer(database, {
      threadId: thread.thread.id,
      questionId: asked.questionId,
      text: '回答',
      thinking: '',
      phase: 'done'
    })
    if (saved.status !== 'saved') throw new Error('回答没存上')
    database
      .prepare(
        `INSERT INTO pin (
           id, thread_id, thread_title, answer_id, turn_index, model, captured_text,
           char_start, char_end, target_kind, created_at
         ) VALUES ('pin-1', ?, '新的学习', ?, 0, 'deepseek-flash', '回答', 0, 2,
                   'unfiled', '2026-11-21T00:00:00.000Z')`
      )
      .run(thread.thread.id, saved.thread.turns[0]?.answer?.id ?? '')

    expect(deleteModelProvider(database, providerId)).toEqual({
      status: 'deleted',
      activeCleared: true
    })
    expect(readActiveProviderId(database)).toBeNull()
    expect(isProviderSelectionCleared(database)).toBe(true)
    expect(readModelProvider(database, providerId)).toBeNull()
    expect(readProviderModels(database, providerId)).toEqual([])
    expect(readThreadView(database, thread.thread.id)).not.toBeNull()
    expect(database.prepare('SELECT COUNT(*) AS count FROM pin').get()).toEqual({ count: 1 })
    expect(deleteModelProvider(database, providerId)).toEqual({ status: 'missing' })
  })

  it('删除没用中的 provider 不清空当前选择', () => {
    const first = addDeepSeek('sk-first')
    const second = addDeepSeek('sk-second')
    activateModelProvider(database, first)

    expect(deleteModelProvider(database, second)).toEqual({
      status: 'deleted',
      activeCleared: false
    })
    expect(readActiveProviderId(database)).toBe(first)
    expect(isProviderSelectionCleared(database)).toBe(false)
  })
})
