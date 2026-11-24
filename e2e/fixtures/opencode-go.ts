import { openDatabase } from '../../src/main/db/database'
import { migrate } from '../../src/main/db/migrations'
import { addBuiltinProvider } from '../../src/main/settings/provider-writes'
import type { SecretStore } from '../../src/main/settings/secret-store'
import type { ModelProtocol } from '../../src/shared/model-catalog'

export type OpenCodeGoSeed = {
  /** 环境变量模式：E2E 不用碰 safeStorage，也能让聊天拿到请求级密钥。 */
  envVar?: string
  /** 只在本机模式用；默认造一个合成密钥。 */
  apiKey?: string
  displayName?: string
  /** 请求里真正发送的默认模型名；不传用目录第一条。 */
  defaultModelName?: string
  /**
   * 只改测试资料库里模型行的地址：OpenCode GO 的 32 个模型各自带地址，
   * 按协议分别指到本地 stub。生产代码不读这里，也没有测试旁路。
   */
  baseUrls?: Partial<Record<ModelProtocol, string>>
  active?: boolean
}

/**
 * 通过真实添加路径造一套 OpenCode GO：32 个模型、协议、容量与思考元数据全部
 * 来自生成目录；只把地址换成 127.0.0.1 的本地 stub，并把密钥来源改成环境变量。
 */
export function seedOpenCodeGoProvider(
  databaseFile: string,
  seed: OpenCodeGoSeed = {}
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
      {
        catalogProviderId: 'opencode-go',
        ...(seed.envVar === undefined
          ? { apiKey: seed.apiKey ?? 'e2e-go-seed-key' }
          : { authMode: 'env' as const, envVar: seed.envVar })
      },
      { now: '2026-11-21T00:00:00.000Z' }
    )
    if (added.status !== 'saved') {
      throw new Error(`OpenCode GO 没造出来：${JSON.stringify(added)}`)
    }

    database
      .prepare(
        `UPDATE model_provider
            SET base_url = NULL, auth_mode = 'env', env_var = ?, secret_ciphertext = NULL,
                display_name = ?
          WHERE id = ?`
      )
      .run(
        seed.envVar ?? 'E2E_GO_KEY',
        seed.displayName ?? 'OpenCode GO',
        added.providerId
      )

    const updateModels = database.prepare(
      `UPDATE model_provider_model SET base_url = ? WHERE provider_id = ? AND api = ?`
    )
    for (const [api, baseUrl] of Object.entries(seed.baseUrls ?? {})) {
      if (baseUrl !== undefined) {
        updateModels.run(baseUrl, added.providerId, api)
      }
    }

    if (seed.defaultModelName !== undefined) {
      const model = database
        .prepare(
          'SELECT id FROM model_provider_model WHERE provider_id = ? AND model_id = ?'
        )
        .get(added.providerId, seed.defaultModelName) as { id: string } | undefined
      if (model === undefined) {
        throw new Error(`GO 目录里没有模型 ${seed.defaultModelName}`)
      }
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
      database
        .prepare("DELETE FROM setting WHERE key = 'chat.providerSelectionCleared'")
        .run()
    } else {
      // 新提供商保存会自动接上「使用中」；夹具保留「存在但未启用」的语义。
      database
        .prepare("DELETE FROM setting WHERE key = 'chat.activeProviderId' AND value = ?")
        .run(added.providerId)
    }
    database.pragma('journal_mode = DELETE')
    return added.providerId
  } finally {
    database.close()
  }
}
