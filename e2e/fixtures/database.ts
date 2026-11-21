import Database from 'better-sqlite3'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/database'
import { migrate, migrations } from '../../src/main/db/migrations'
import { addBuiltinProvider } from '../../src/main/settings/provider-writes'
import type { SecretStore } from '../../src/main/settings/secret-store'
import { readBuiltinProviderSetup } from '../../src/shared/model-builtin'

/**
 * 应用把本机资料库写进 userData 目录，文件名与主进程里的常量一致。
 */
export function databasePath(userDataDirectory: string): string {
  return join(userDataDirectory, 'english-learning.db')
}

export function readSchemaVersion(databaseFile: string): number {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true })
  try {
    return database.pragma('user_version', { simple: true }) as number
  } finally {
    database.close()
  }
}

/**
 * 直接写一条 setting，用于在两次启动之间留下可以观察的状态。
 */
export function writeSetting(databaseFile: string, key: string, value: string): void {
  const database = new Database(databaseFile)
  try {
    database
      .prepare(
        `INSERT INTO setting (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
      )
      .run(key, value)
  } finally {
    database.close()
  }
}

export type LegacyModelProfileSeed = {
  id: string
  name: string
  baseUrl: string
  model: string
  apiKeySecret: string | null
  verification?: 'verified' | 'unverified'
}

/**
 * 造一份升级前的 v13 资料库：模型配置还是扁平的 model_profile。
 * 应用下一次启动会就地迁到最新 schema，E2E 用它验证只读卡片与备份。
 */
export function seedLegacyModelProfiles(
  databaseFile: string,
  profiles: readonly LegacyModelProfileSeed[],
  activeId?: string
): void {
  const database = openDatabase(databaseFile)
  try {
    migrate(database, {
      migrations: migrations.filter((migration) => migration.version <= 13)
    })
    const insert = database.prepare(
      `INSERT INTO model_profile (
         id, name, base_url, model, api_key_secret, verification, last_error,
         last_checked_at, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
    )
    profiles.forEach((profile, index) => {
      const createdAt = `2026-11-18T09:0${index}:00.000Z`
      insert.run(
        profile.id,
        profile.name,
        profile.baseUrl,
        profile.model,
        profile.apiKeySecret,
        profile.verification ?? 'unverified',
        createdAt,
        createdAt
      )
    })
    if (activeId !== undefined) {
      database
        .prepare(`INSERT INTO setting (key, value) VALUES ('chat.activeProfileId', ?)`)
        .run(activeId)
    }
    // 应用下次启动会改成 WAL；夹具先收成单文件，避免 -wal 残留干扰。
    database.pragma('journal_mode = DELETE')
  } finally {
    database.close()
  }
}

export type BuiltinProviderSeed = {
  /** 目录入口；E2E 只造本票开放的三家。 */
  catalogProviderId: 'deepseek' | 'kimi' | 'glm'
  /** 指到本地 SSE stub（含 /v1 等路径前缀）。 */
  baseUrl: string
  /** 环境变量模式的密钥变量名；聊天直接从 E2E 启动环境里读。 */
  envVar?: string
  /** 请求里真正发送的默认模型名；不传用目录第一条。 */
  defaultModelName?: string
  active?: boolean
  displayName?: string
}

/**
 * 造一份当前 schema 的内置 provider：目录身份、模型元数据与配置行都来自
 * 真实添加路径，只把地址改到本地 stub、把密钥来源改成环境变量，
 * 这样 E2E 不必依赖 safeStorage，也能测聊天链路。
 */
export function seedBuiltinProvider(
  databaseFile: string,
  seed: BuiltinProviderSeed
): string {
  const database = openDatabase(databaseFile)
  try {
    migrate(database)
    const secrets: SecretStore = {
      encrypt: (plain) => `e2e-seed:${plain}`,
      decrypt: () => null
    }
    const added = addBuiltinProvider(
      database,
      secrets,
      { catalogProviderId: seed.catalogProviderId, apiKey: 'e2e-seed-key' },
      { now: '2026-11-21T00:00:00.000Z' }
    )
    if (added.status !== 'saved') throw new Error('内置 provider 没造出来')
    database
      .prepare(
        `UPDATE model_provider
            SET base_url = ?, auth_mode = 'env', env_var = ?, secret_ciphertext = NULL,
                display_name = ?
          WHERE id = ?`
      )
      .run(
        seed.baseUrl,
        seed.envVar ?? 'E2E_PROVIDER_KEY',
        seed.displayName ?? builtinDisplayName(seed.catalogProviderId),
        added.providerId
      )
    if (seed.defaultModelName !== undefined) {
      const model = database
        .prepare(
          'SELECT id FROM model_provider_model WHERE provider_id = ? AND model_id = ?'
        )
        .get(added.providerId, seed.defaultModelName) as { id: string } | undefined
      if (model === undefined) throw new Error(`目录里没有模型 ${seed.defaultModelName}`)
      database
        .prepare('UPDATE model_provider SET default_model_id = ? WHERE id = ?')
        .run(model.id, added.providerId)
    }
    if (seed.active !== false) {
      database
        .prepare(
          `INSERT INTO setting (key, value) VALUES ('chat.activeProviderId', ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value`
        )
        .run(added.providerId)
      database.prepare("DELETE FROM setting WHERE key = 'chat.providerSelectionCleared'").run()
    }
    database.pragma('journal_mode = DELETE')
    return added.providerId
  } finally {
    database.close()
  }
}

/** 显示名取共享目录的 setup，不在这里再抄一份厂商名。 */
function builtinDisplayName(id: BuiltinProviderSeed['catalogProviderId']): string {
  return readBuiltinProviderSetup(id)?.displayName ?? id
}

export type ModelProviderSeed = {
  id: string
  providerKey: string
  displayName: string
  protocol?: string
  baseUrl: string
  modelId: string
  /** 环境变量模式：E2E 不用碰 safeStorage，也能让聊天拿到密钥。 */
  authMode?: 'stored' | 'env'
  envVar?: string
  verification?: 'verified' | 'unverified'
}

/** 直接造一份当前 schema 的 provider + 默认模型；用于只需要聊天链路的用例。 */
export function seedModelProvider(
  databaseFile: string,
  provider: ModelProviderSeed,
  active = true
): void {
  const database = openDatabase(databaseFile)
  try {
    migrate(database)
    const createdAt = '2026-11-18T09:00:00.000Z'
    const modelId = 'model-1'
    database
      .prepare(
        `INSERT INTO model_provider (
           id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
           secret_ciphertext, retry_policy, verification, last_error, last_checked_at,
           last_verified_at, source, default_model_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, '{"mode":"normal"}', ?, NULL, NULL, NULL,
                   'custom', ?, ?, ?)`
      )
      .run(
        provider.id,
        provider.providerKey,
        provider.displayName,
        provider.protocol ?? 'openai-completions',
        provider.baseUrl,
        provider.authMode ?? 'env',
        provider.envVar ?? null,
        provider.verification ?? 'unverified',
        modelId,
        createdAt,
        createdAt
      )
    database
      .prepare(
        `INSERT INTO model_provider_model (
           id, provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
           input, reasoning, source, sort, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, 'text', 0, 'manual', 0, ?, ?)`
      )
      .run(
        modelId,
        provider.id,
        provider.modelId,
        provider.modelId,
        provider.protocol ?? 'openai-completions',
        createdAt,
        createdAt
      )
    if (active) {
      database
        .prepare(`INSERT INTO setting (key, value) VALUES ('chat.activeProviderId', ?)`)
        .run(provider.id)
    }
    database.pragma('journal_mode = DELETE')
  } finally {
    database.close()
  }
}
