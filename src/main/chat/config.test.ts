import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate, migrations } from '../db/migrations'
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

  it('只填密钥时用默认接口地址与模型名', () => {
    expect(readChatConfig({ DEEPSEEK_API_KEY: 'test-key' })).toEqual({
      apiKey: 'test-key',
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL
    })
  })

  it('环境变量可以覆盖地址与模型名，并去掉首尾空白', () => {
    expect(
      readChatConfig({
        DEEPSEEK_API_KEY: ' test-key ',
        DEEPSEEK_BASE_URL: ' http://127.0.0.1:1234 ',
        DEEPSEEK_MODEL: ' deepseek-v4-pro '
      })
    ).toEqual({
      apiKey: 'test-key',
      baseUrl: 'http://127.0.0.1:1234',
      model: 'deepseek-v4-pro'
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
    ).toEqual({
      apiKey: 'env-key',
      baseUrl: 'http://127.0.0.1:1234',
      model: 'env-model'
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

    expect(resolved).toEqual({
      apiKey: 'sk-profile-key',
      baseUrl: 'https://profile.example.com',
      model: 'deepseek-v4-pro',
      providerId: 'provider-deepseek',
      modelId: expect.any(String)
    })
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

    expect(resolveChatConfig(database, secrets, {})).toEqual({
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5:7b',
      providerId: 'provider-local',
      modelId: expect.any(String)
    })
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
})
