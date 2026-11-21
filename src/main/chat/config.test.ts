import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UNKNOWN_CONTEXT_WINDOW, UNKNOWN_MAX_TOKENS } from './model-descriptor'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate, migrations } from '../db/migrations'
import { deleteModelProvider } from '../settings/provider-writes'
import type { SecretStore } from '../settings/secret-store'
import { DEFAULT_BASE_URL, DEFAULT_MODEL, readChatConfig, resolveChatConfig } from './config'

const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (sealed) =>
    sealed.startsWith('sealed:')
      ? Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')
      : null
}

describe('readChatConfig', () => {
  it('缺密钥时没有可用配置', () => {
    expect(readChatConfig({})).toBeNull()
    expect(readChatConfig({ DEEPSEEK_API_KEY: '   ' })).toBeNull()
  })

  it('只填密钥时用默认接口地址与模型名，并带上真实目录描述符', () => {
    expect(readChatConfig({ DEEPSEEK_API_KEY: 'test-key' })).toMatchObject({
      apiKey: 'test-key',
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      descriptor: {
        provider: 'deepseek',
        model: DEFAULT_MODEL,
        api: 'openai-completions',
        baseUrl: DEFAULT_BASE_URL,
        contextWindow: 1000000,
        maxTokens: 384000,
        reasoning: true
      }
    })
  })

  it('环境变量可以覆盖地址与模型名，并去掉首尾空白', () => {
    expect(
      readChatConfig({
        DEEPSEEK_API_KEY: ' test-key ',
        DEEPSEEK_BASE_URL: ' http://127.0.0.1:1234 ',
        DEEPSEEK_MODEL: ' deepseek-v4-pro '
      })
    ).toMatchObject({
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:1234',
      model: 'deepseek-v4-pro',
      descriptor: { model: 'deepseek-v4-pro', baseUrl: 'http://127.0.0.1:1234' }
    })
  })
})

describe('resolveChatConfig', () => {
  let directory: string
  let database: AppDatabase

  type Profile = {
    id: string
    name: string
    model: string
    apiKey: string
    baseUrl?: string
    createdAt?: string
  }

  function seedProfiles(profiles: readonly Profile[]): void {
    migrate(database, { migrations: migrations.filter((migration) => migration.version <= 13) })
    const insert = database.prepare(
      `INSERT INTO model_profile (
         id, name, base_url, model, api_key_secret, verification, last_error,
         last_checked_at, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'unverified', NULL, NULL, NULL, ?, ?)`
    )
    profiles.forEach((profile, index) => {
      const createdAt = profile.createdAt ?? `2026-11-18T09:0${index}:00.000Z`
      insert.run(
        profile.id,
        profile.name,
        profile.baseUrl ?? 'https://profile.example.com',
        profile.model,
        profile.apiKey === '' ? null : secrets.encrypt(profile.apiKey),
        createdAt,
        createdAt
      )
    })
  }

  function activate(id: string): void {
    database
      .prepare(
        `INSERT INTO setting (key, value) VALUES ('chat.activeProviderId', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`
      )
      .run(id)
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'english-learning-chat-config-'))
    database = openDatabase(join(directory, 'test.db'))
  })

  afterEach(() => {
    database.close()
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('没有本机配置时沿用环境变量', () => {
    migrate(database)

    expect(
      resolveChatConfig(database, secrets, {
        DEEPSEEK_API_KEY: 'env-key',
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:1234',
        DEEPSEEK_MODEL: 'env-model'
      })
    ).toMatchObject({
      apiKey: 'env-key',
      baseUrl: 'http://127.0.0.1:1234',
      model: 'env-model',
      descriptor: { model: 'env-model', reasoning: false }
    })
  })

  it('使用中的 provider 与默认模型优先于环境变量，并带上两个 id 供回写', () => {
    seedProfiles([
      {
        id: 'provider-deepseek',
        name: 'DeepSeek 官方',
        model: 'deepseek-v4-pro',
        apiKey: 'sk-profile-key'
      }
    ])
    migrate(database)
    activate('provider-deepseek')

    const resolved = resolveChatConfig(database, secrets, {
      DEEPSEEK_API_KEY: 'env-key',
      DEEPSEEK_MODEL: 'env-model'
    })

    expect(resolved).toMatchObject({
      apiKey: 'sk-profile-key',
      baseUrl: 'https://profile.example.com',
      model: 'deepseek-v4-pro',
      providerId: 'provider-deepseek',
      modelId: expect.any(String),
      descriptor: {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        api: 'openai-completions',
        baseUrl: 'https://profile.example.com',
        contextWindow: UNKNOWN_CONTEXT_WINDOW,
        maxTokens: UNKNOWN_MAX_TOKENS,
        input: ['text'],
        reasoning: false
      }
    })
    expect(resolved?.descriptor.thinkingLevelMap).toBeUndefined()
  })

  it('切换之后的下一次调用用新的一套，未使用中的配置不参与', () => {
    seedProfiles([
      { id: 'provider-one', name: '第一套', model: 'model-one', apiKey: 'sk-one' },
      { id: 'provider-two', name: '第二套', model: 'model-two', apiKey: 'sk-two' }
    ])
    migrate(database)
    activate('provider-one')

    expect(resolveChatConfig(database, secrets, {})).toMatchObject({ model: 'model-one' })
    activate('provider-two')
    expect(resolveChatConfig(database, secrets, {})).toMatchObject({
      model: 'model-two',
      apiKey: 'sk-two',
      providerId: 'provider-two'
    })
  })

  it('本地配置没有密钥时也照常解析，交给服务端决定要不要密钥', () => {
    seedProfiles([
      {
        id: 'provider-local',
        name: '本地 Ollama',
        model: 'qwen2.5:7b',
        apiKey: '',
        baseUrl: 'http://127.0.0.1:11434/v1'
      }
    ])
    migrate(database)
    activate('provider-local')

    expect(resolveChatConfig(database, secrets, {})).toMatchObject({
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      providerId: 'provider-local',
      modelId: expect.any(String)
    })
    // 从来没存过密钥的本机配置（本地 Ollama）允许不带密钥发送。
    expect(resolveChatConfig(database, secrets, {})?.missingCredential).toBeUndefined()
  })

  it('本机密文解不开或环境变量缺失时明确标缺凭据，不换源', () => {
    seedProfiles([
      { id: 'provider-broken', name: '坏密文', model: 'model-one', apiKey: 'sk-one' }
    ])
    migrate(database)
    activate('provider-broken')
    database
      .prepare(`UPDATE model_provider SET secret_ciphertext = 'not-decryptable' WHERE id = ?`)
      .run('provider-broken')

    expect(resolveChatConfig(database, secrets, {})).toMatchObject({
      apiKey: '',
      providerId: 'provider-broken',
      missingCredential: true
    })

    database
      .prepare(
        `UPDATE model_provider
            SET auth_mode = 'env', env_var = 'MISSING_PROVIDER_KEY', secret_ciphertext = NULL
          WHERE id = ?`
      )
      .run('provider-broken')
    expect(resolveChatConfig(database, secrets, {})?.missingCredential).toBe(true)
    expect(
      resolveChatConfig(database, secrets, { MISSING_PROVIDER_KEY: 'env-key' })
    ).toMatchObject({ apiKey: 'env-key' })
    expect(
      resolveChatConfig(database, secrets, { MISSING_PROVIDER_KEY: 'env-key' })
        ?.missingCredential
    ).toBeUndefined()
  })

  it('环境变量缺失时报错并点名变量，环境退路里的另一套密钥也不顶上', () => {
    seedProfiles([
      { id: 'provider-env', name: '环境配置', model: 'model-one', apiKey: 'sk-stored' }
    ])
    migrate(database)
    activate('provider-env')
    database
      .prepare(
        `UPDATE model_provider
            SET auth_mode = 'env', env_var = 'MISSING_PROVIDER_KEY',
                secret_ciphertext = 'sealed:stale-ciphertext'
          WHERE id = 'provider-env'`
      )
      .run()

    const resolved = resolveChatConfig(database, secrets, {
      MISSING_PROVIDER_KEY: '',
      DEEPSEEK_API_KEY: 'sk-fallback-must-not-be-used'
    })

    expect(resolved).toMatchObject({
      apiKey: '',
      providerId: 'provider-env',
      missingCredential: true,
      credentialProblem: { kind: 'env-missing', envVar: 'MISSING_PROVIDER_KEY' }
    })
  })

  it('本机密文解不开时报解不开，环境变量即使可用也不换源', () => {
    seedProfiles([
      { id: 'provider-broken', name: '坏密文', model: 'model-one', apiKey: 'sk-one' }
    ])
    migrate(database)
    activate('provider-broken')
    database
      .prepare(`UPDATE model_provider SET secret_ciphertext = 'not-decryptable' WHERE id = ?`)
      .run('provider-broken')

    const resolved = resolveChatConfig(database, secrets, {
      DEEPSEEK_API_KEY: 'sk-env-must-not-be-used'
    })

    expect(resolved).toMatchObject({
      apiKey: '',
      missingCredential: true,
      credentialProblem: { kind: 'stored-decrypt-failed' }
    })
  })

  it('本机密钥可用时没有任何凭据问题', () => {
    seedProfiles([
      { id: 'provider-ok', name: '正常配置', model: 'model-one', apiKey: 'sk-ok' }
    ])
    migrate(database)
    activate('provider-ok')

    const resolved = resolveChatConfig(database, secrets, {})

    expect(resolved).toMatchObject({ apiKey: 'sk-ok' })
    expect(resolved?.missingCredential).toBeUndefined()
    expect(resolved?.credentialProblem).toBeUndefined()
  })

  it('解析使用中的配置时不再写旧 model_profile 表', () => {
    seedProfiles([
      { id: 'provider-one', name: '第一套', model: 'model-one', apiKey: 'sk-one' }
    ])
    migrate(database)
    activate('provider-one')
    database.exec(`
      CREATE TRIGGER model_profile_read_only
      BEFORE UPDATE ON model_profile
      BEGIN
        SELECT RAISE(ABORT, 'model_profile is read-only after migration');
      END
    `)

    expect(() => resolveChatConfig(database, secrets, {})).not.toThrow()
  })

  it('既没有本机配置也没有环境变量时没有可用配置', () => {
    migrate(database)

    expect(resolveChatConfig(database, secrets, {})).toBeNull()
  })

  it('有 provider 但一套都没启用时不回落到环境变量，明确没有可用配置', () => {
    seedProfiles([
      { id: 'provider-one', name: '第一套', model: 'model-one', apiKey: 'sk-one' }
    ])
    migrate(database)

    // 只保存、没点「使用这个」：设置页明说没有使用中的提供商，聊天不能再静默
    // 拿环境变量里的另一套密钥顶上。
    expect(
      resolveChatConfig(database, secrets, {
        DEEPSEEK_API_KEY: 'env-key',
        DEEPSEEK_MODEL: 'env-model'
      })
    ).toBeNull()
  })

  it('使用中的模型协议本版不认识时明确没有可用配置，不拿别的协议发请求', () => {
    seedProfiles([
      { id: 'provider-unknown', name: '未知协议', model: 'model-one', apiKey: 'sk-one' }
    ])
    migrate(database)
    activate('provider-unknown')
    database
      .prepare(`UPDATE model_provider_model SET api = 'mistral-conversations'`)
      .run()

    expect(resolveChatConfig(database, secrets, {})).toBeNull()
  })

  it('删掉使用中的 provider 后不静默回落到环境变量里的另一套凭据', () => {
    seedProfiles([
      { id: 'provider-one', name: '第一套', model: 'model-one', apiKey: 'sk-one' }
    ])
    migrate(database)
    activate('provider-one')
    deleteModelProvider(database, 'provider-one')

    expect(
      resolveChatConfig(database, secrets, {
        DEEPSEEK_API_KEY: 'env-key',
        DEEPSEEK_MODEL: 'env-model'
      })
    ).toBeNull()
  })
})
