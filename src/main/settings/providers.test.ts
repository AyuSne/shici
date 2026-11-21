import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate, migrations } from '../db/migrations'
import {
  listModelProviders,
  maskApiKey,
  markProviderVerified,
  readActiveChatProvider,
  readActiveProviderId
} from './providers'
import type { SecretStore } from './secret-store'

let directory: string
let database: AppDatabase

/** 测试替身：可逆的假加密，只用来观察明文有没有被带进摘要。 */
const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (sealed) =>
    sealed.startsWith('sealed:')
      ? Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')
      : null
}

const sealed = (key: string): string => secrets.encrypt(key)

type LegacyProfile = {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKeySecret: string | null
  verification?: 'verified' | 'unverified'
  lastError?: string | null
  lastCheckedAt?: string | null
  lastVerifiedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

/** 停在 13 版的旧库：模型配置还是那张扁平表。 */
function seedLegacyProfiles(profiles: readonly LegacyProfile[]): void {
  migrate(database, { migrations: migrations.filter((migration) => migration.version <= 13) })
  const insert = database.prepare(
    `INSERT INTO model_profile (
       id, name, base_url, model, api_key_secret, verification, last_error,
       last_checked_at, last_verified_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  profiles.forEach((profile, index) => {
    const createdAt = profile.createdAt ?? `2026-11-18T09:0${index}:00.000Z`
    insert.run(
      profile.id,
      profile.name,
      profile.baseUrl,
      profile.model,
      profile.apiKeySecret,
      profile.verification ?? 'unverified',
      profile.lastError ?? null,
      profile.lastCheckedAt ?? null,
      profile.lastVerifiedAt ?? null,
      createdAt,
      profile.updatedAt ?? createdAt
    )
  })
}

function activateLegacy(id: string): void {
  database
    .prepare(
      `INSERT INTO setting (key, value) VALUES ('chat.activeProfileId', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    )
    .run(id)
}

const twoProfiles: readonly LegacyProfile[] = [
  {
    id: 'profile-deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    apiKeySecret: sealed('sk-abcdefghijklmnop'),
    verification: 'verified',
    lastCheckedAt: '2026-11-18T09:30:00.000Z',
    lastVerifiedAt: '2026-11-18T09:30:00.000Z'
  },
  {
    id: 'profile-backup',
    name: '备用',
    baseUrl: 'https://backup.example.com/v1',
    model: 'backup-model',
    apiKeySecret: sealed('sk-backup-key-0002'),
    lastError: 'network',
    lastCheckedAt: '2026-11-18T09:10:00.000Z'
  }
]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-providers-'))
  database = openDatabase(join(directory, 'test.db'))
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function migratedDatabase(profiles: readonly LegacyProfile[], activeId?: string): void {
  seedLegacyProfiles(profiles)
  if (activeId !== undefined) {
    activateLegacy(activeId)
  }
  migrate(database)
}

describe('listModelProviders', () => {
  it('按新增顺序列出只读 provider：协议、模型、验证状态、使用中与密钥三态', () => {
    migratedDatabase(twoProfiles, 'profile-deepseek')

    const providers = listModelProviders(database, { secrets, env: {} })

    expect(providers).toHaveLength(2)
    expect(providers.map((provider) => provider.providerKey)).toEqual([
      'deepseek',
      'backup-example-com'
    ])
    expect(providers[0]).toMatchObject({
      id: 'profile-deepseek',
      displayName: 'DeepSeek 官方',
      protocol: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
      authMode: 'stored',
      envVar: null,
      apiKeyMask: 'sk-·············mnop',
      keyState: 'stored',
      retryPolicy: { mode: 'normal' },
      verification: 'verified',
      lastError: null,
      lastCheckedAt: '2026-11-18T09:30:00.000Z',
      lastVerifiedAt: '2026-11-18T09:30:00.000Z',
      source: 'custom',
      active: true,
      defaultModelRowId: expect.any(String)
    })
    expect(providers[1]).toMatchObject({
      id: 'profile-backup',
      displayName: '备用',
      verification: 'unverified',
      lastError: 'network',
      lastCheckedAt: '2026-11-18T09:10:00.000Z',
      lastVerifiedAt: null,
      active: false,
      defaultModelRowId: expect.any(String)
    })
    expect(providers[0]?.models).toEqual([
      {
        id: providers[0]?.defaultModelRowId,
        modelId: 'deepseek-flash',
        displayName: 'deepseek-flash',
        api: 'openai-completions',
        baseUrl: null,
        contextWindow: null,
        maxTokens: null,
        input: 'text',
        reasoning: false,
        source: 'manual',
        sort: 0
      }
    ])
    expect(providers[1]?.models[0]?.modelId).toBe('backup-model')
    expect(providers.every((provider) => /^[a-z][a-z0-9-]*$/.test(provider.providerKey))).toBe(
      true
    )
    // 摘要里只有掩码，没有明文密钥。
    expect(JSON.stringify(providers)).not.toContain('abcdefghijkl')
    expect(JSON.stringify(providers)).not.toContain('sealed:')
  })

  it('没有密钥的旧配置显示为缺失，不编造掩码', () => {
    migratedDatabase([
      {
        id: 'profile-local',
        name: '本地 Ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'qwen2.5:7b',
        apiKeySecret: null
      }
    ])

    expect(listModelProviders(database, { secrets, env: {} })[0]).toMatchObject({
      apiKeyMask: null,
      keyState: 'missing'
    })
  })

  it('环境变量模式只看环境变量，不读本机密文', () => {
    migratedDatabase(twoProfiles, 'profile-deepseek')
    database
      .prepare(
        `INSERT INTO model_provider (
           id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
           secret_ciphertext, retry_policy, verification, last_error, last_checked_at,
           last_verified_at, source, default_model_id, created_at, updated_at
         ) VALUES ('provider-env', 'env-provider', '环境变量配置', 'openai-completions',
                   'https://env.example.com', 'env', 'MY_PROVIDER_KEY', 'sealed:ignored',
                   '{"mode":"normal"}', 'unverified', NULL, NULL, NULL, 'custom', NULL,
                   '2026-11-18T09:20:00.000Z', '2026-11-18T09:20:00.000Z')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO model_provider_model (
           id, provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
           input, reasoning, source, sort, created_at, updated_at
         ) VALUES ('model-env', 'provider-env', 'env-model', 'env-model', 'openai-completions',
                   NULL, NULL, NULL, 'text', 0, 'manual', 0,
                   '2026-11-18T09:20:00.000Z', '2026-11-18T09:20:00.000Z')`
      )
      .run()

    const absent = listModelProviders(database, { secrets, env: {} }).find(
      (provider) => provider.id === 'provider-env'
    )
    expect(absent).toMatchObject({
      keyState: 'missing',
      apiKeyMask: null,
      envVar: 'MY_PROVIDER_KEY'
    })

    const present = listModelProviders(database, {
      secrets,
      env: { MY_PROVIDER_KEY: 'env-secret' }
    }).find((provider) => provider.id === 'provider-env')
    expect(present).toMatchObject({ keyState: 'env', apiKeyMask: null })
  })

  it('四个已知协议读库都原样返回，不会被降级成别的协议', () => {
    migratedDatabase([twoProfiles[0]!])

    for (const protocol of [
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
      'google-generative-ai'
    ] as const) {
      database.prepare('UPDATE model_provider SET protocol = ?').run(protocol)
      database.prepare('UPDATE model_provider_model SET api = ?').run(protocol)

      const provider = listModelProviders(database, { secrets, env: {} })[0]
      expect(provider?.protocol, protocol).toBe(protocol)
      expect(provider?.models[0]?.api, protocol).toBe(protocol)
    }
  })

  it('库里存了不认识的协议时读成 null，不静默冒充 openai-completions', () => {
    migratedDatabase([
      {
        id: 'profile-unknown',
        name: '未知协议',
        baseUrl: 'https://unknown.example.com',
        model: 'unknown-model',
        apiKeySecret: sealed('sk-unknown-key')
      }
    ])
    database
      .prepare(`UPDATE model_provider SET protocol = 'mistral-conversations'`)
      .run()
    database
      .prepare(`UPDATE model_provider_model SET api = 'mistral-conversations'`)
      .run()

    const provider = listModelProviders(database, { secrets, env: {} })[0]
    expect(provider?.protocol).toBeNull()
    expect(provider?.models[0]?.api).toBeNull()
  })
})

describe('readActiveProviderId', () => {
  it('指向不存在的 provider 时当作没有使用中', () => {
    migratedDatabase(twoProfiles)
    database
      .prepare(`INSERT INTO setting (key, value) VALUES ('chat.activeProviderId', 'missing')`)
      .run()

    expect(readActiveProviderId(database)).toBeNull()
  })
})

describe('readActiveChatProvider', () => {
  it('使用中的 provider 与默认模型一起解析，密钥只在主进程里解密', () => {
    migratedDatabase(twoProfiles, 'profile-backup')

    const active = readActiveChatProvider(database, { secrets, env: {} })

    expect(active?.provider.id).toBe('profile-backup')
    expect(active?.model.modelId).toBe('backup-model')
    expect(active?.apiKey).toBe('sk-backup-key-0002')
  })

  it('默认模型不存在时退回目录里的第一条', () => {
    migratedDatabase(twoProfiles, 'profile-deepseek')
    database.prepare(`UPDATE model_provider SET default_model_id = 'missing'`).run()

    const active = readActiveChatProvider(database, { secrets, env: {} })

    expect(active?.model.modelId).toBe('deepseek-flash')
  })

  it('没有使用中的 provider 时返回 null', () => {
    migratedDatabase(twoProfiles)

    expect(readActiveChatProvider(database, { secrets, env: {} })).toBeNull()
  })

  it('环境变量模式在缺失时拿不到密钥，也不回退到本机密文', () => {
    migratedDatabase(twoProfiles, 'profile-deepseek')
    database
      .prepare(
        `UPDATE model_provider
            SET auth_mode = 'env', env_var = 'MISSING_KEY', secret_ciphertext = 'sealed:stored'
          WHERE id = 'profile-deepseek'`
      )
      .run()

    expect(readActiveChatProvider(database, { secrets, env: {} })?.apiKey).toBe('')
    expect(
      readActiveChatProvider(database, { secrets, env: { MISSING_KEY: 'env-key' } })?.apiKey
    ).toBe('env-key')
  })
})

describe('markProviderVerified', () => {
  it('成功调用后只更新 provider 表，旧 profile 表原样不动', () => {
    migratedDatabase(twoProfiles, 'profile-deepseek')
    // 旧表迁移后只读：任何运行时写它都会撞上这个哨兵。
    database.exec(`
      CREATE TRIGGER model_profile_read_only
      BEFORE UPDATE ON model_profile
      BEGIN
        SELECT RAISE(ABORT, 'model_profile is read-only after migration');
      END
    `)

    markProviderVerified(database, 'profile-deepseek', '2026-11-18T10:00:00.000Z')

    expect(
      database
        .prepare(
          `SELECT verification, last_error, last_verified_at
             FROM model_provider WHERE id = 'profile-deepseek'`
        )
        .get()
    ).toEqual({
      verification: 'verified',
      last_error: null,
      last_verified_at: '2026-11-18T10:00:00.000Z'
    })
    expect(
      database
        .prepare(
          `SELECT verification, last_verified_at FROM model_profile WHERE id = 'profile-deepseek'`
        )
        .get()
    ).toEqual({ verification: 'verified', last_verified_at: '2026-11-18T09:30:00.000Z' })
  })
})

describe('maskApiKey', () => {
  it('保留 sk- 前缀与末四位，中间全部隐去', () => {
    expect(maskApiKey('sk-abcdefghijklmnop')).toBe('sk-·············mnop')
    expect(maskApiKey('plain-key-value')).toBe('·············alue')
    expect(maskApiKey('abc')).toBe('·············')
    expect(maskApiKey('  ')).toBe('')
  })
})
