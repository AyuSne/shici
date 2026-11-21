import type {
  UpdateProviderCredentialRequest,
  UpdateProviderCredentialResult
} from '../../shared/provider-credentials'
import type { AppDatabase } from '../db/database'
import { planCredentialUpdate } from './credentials'
import { readModelProvider } from './providers'
import type { SecretStore } from './secret-store'

export type CredentialWriteOptions = {
  now?: string
}

/**
 * 编辑一套 provider 的密钥来源。
 *
 * - 环境模式：只写 `auth_mode` / `env_var`，密文列一律清空；请求里带的 key 不加密、不落库。
 * - 本机模式：留空表示保持已存密文；显式 clearStoredKey 才清除。
 * - 从本机切到环境：没有 `confirmClearStored` 时拒绝，原配置原样不动。
 *
 * 一次事务只改 provider 行：线程、钉住与历史消息没有任何指向凭据的外键，
 * 换 key / 清 key 都不影响它们。
 */
export function updateProviderCredential(
  database: AppDatabase,
  secrets: SecretStore,
  request: UpdateProviderCredentialRequest,
  options?: CredentialWriteOptions
): UpdateProviderCredentialResult {
  const provider = readModelProvider(database, request.providerId)
  if (provider === null) {
    return { status: 'missing' }
  }

  const plan = planCredentialUpdate(provider, secrets, request)
  if (!plan.ok) {
    return { status: 'rejected', reason: plan.reason }
  }

  const now = options?.now ?? new Date().toISOString()
  const update = database.transaction(() => {
    if (plan.credentialChanged) {
      // 换 key、清 key 或换来源后，旧的「已验证」不再代表这次配置。
      database
        .prepare(
          `UPDATE model_provider
              SET auth_mode = ?, env_var = ?, secret_ciphertext = ?,
                  verification = 'unverified', last_error = NULL,
                  last_checked_at = NULL, last_verified_at = NULL, updated_at = ?
            WHERE id = ?`
        )
        .run(plan.authMode, plan.envVar, plan.secretCiphertext, now, provider.id)
      return
    }
    database
      .prepare(
        `UPDATE model_provider
            SET auth_mode = ?, env_var = ?, secret_ciphertext = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(plan.authMode, plan.envVar, plan.secretCiphertext, now, provider.id)
  })
  update()

  return { status: 'saved', authMode: plan.authMode, clearedStored: plan.clearedStored }
}
