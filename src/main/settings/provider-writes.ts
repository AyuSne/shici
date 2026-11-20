import { randomUUID } from 'node:crypto'
import type {
  ActivateProviderResult,
  AddBuiltinProviderRequest,
  AddBuiltinProviderResult,
  DeleteProviderResult,
  SetDefaultProviderModelResult
} from '../../shared/model-providers'
import { readBuiltinProviderSetup } from '../../shared/model-builtin'
import type { CatalogModel } from '../../shared/model-catalog'
import type { AppDatabase } from '../db/database'
import { uniqueProviderKey } from '../db/provider-key'
import { writeSetting } from '../db/settings'
import {
  ACTIVE_PROVIDER_KEY,
  clearProviderSelection,
  markProviderSelectionCleared,
  readActiveProviderId,
  readModelProvider,
  type ModelProviderRecord
} from './providers'
import type { SecretStore } from './secret-store'

/**
 * 提供商写入：#62 只允许「从内置目录添加」这一条创建路径。
 * 保存是纯本地动作——加密写库、状态未验证，不发任何网络请求；测试连接留给后续批次。
 *
 * Provider ID 由目录入口派生且创建后不可改；同厂商多套得到 deepseek、deepseek-2……
 * 目录身份另存 `catalog_provider_id`，这样 Provider ID 带序号也不会丢失「哪家」。
 */

export type ProviderWriteOptions = {
  now?: string
}

function timestampOf(options: ProviderWriteOptions | undefined): string {
  return options?.now ?? new Date().toISOString()
}

function usedProviderKeys(database: AppDatabase): Set<string> {
  const rows = database
    .prepare('SELECT provider_key FROM model_provider')
    .all() as { provider_key: string }[]
  return new Set(rows.map((row) => row.provider_key))
}

function displayNameFor(
  database: AppDatabase,
  catalogProviderId: string,
  baseName: string
): string {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count FROM model_provider WHERE catalog_provider_id = ?`
    )
    .get(catalogProviderId) as { count: number }
  const instance = row.count + 1
  return instance === 1 ? baseName : `${baseName} ${instance}`
}

function inputOf(model: CatalogModel): 'text' | 'image' {
  return model.input.includes('text') ? 'text' : 'image'
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

/**
 * 从内置目录添加一套提供商。返回的 id / key 供界面刷新列表与显示；
 * 密钥只进 safeStorage 密文列，不会出现在任何返回值里。
 */
export function addBuiltinProvider(
  database: AppDatabase,
  secrets: SecretStore,
  request: AddBuiltinProviderRequest,
  options?: ProviderWriteOptions
): AddBuiltinProviderResult {
  const setup = readBuiltinProviderSetup(request.catalogProviderId)
  if (setup === null) {
    return { status: 'rejected', reason: 'unknown-provider' }
  }
  const apiKey = request.apiKey.trim()
  if (apiKey === '') {
    return { status: 'rejected', reason: 'missing-key' }
  }

  const now = timestampOf(options)
  const providerId = randomUUID()
  const providerKey = uniqueProviderKey(setup.id, usedProviderKeys(database))
  const displayName = displayNameFor(database, setup.id, setup.displayName)
  // 先加密再开事务：加密不可用时什么都不写。
  const ciphertext = secrets.encrypt(apiKey)
  const models = setup.models.map((model, index) => ({
    id: randomUUID(),
    model,
    sort: index
  }))
  const defaultModelId = models[0]?.id ?? null

  const insert = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO model_provider (
           id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
           secret_ciphertext, retry_policy, verification, last_error, last_checked_at,
           last_verified_at, source, catalog_provider_id, default_model_id, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, 'stored', ?, ?, '{"mode":"normal"}', 'unverified', NULL,
                   NULL, NULL, 'builtin', ?, ?, ?, ?)`
      )
      .run(
        providerId,
        providerKey,
        displayName,
        setup.protocol,
        setup.baseUrl,
        setup.envVar,
        ciphertext,
        setup.id,
        defaultModelId,
        now,
        now
      )

    const insertModel = database.prepare(
      `INSERT INTO model_provider_model (
         id, provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
         input, reasoning, thinking_level_map, compat, source, sort, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'catalog', ?, ?, ?)`
    )
    for (const row of models) {
      insertModel.run(
        row.id,
        providerId,
        row.model.id,
        row.model.name,
        row.model.api,
        row.model.baseUrl ?? null,
        row.model.contextWindow,
        row.model.maxTokens,
        inputOf(row.model),
        row.model.reasoning ? 1 : 0,
        jsonOrNull(row.model.thinkingLevelMap),
        jsonOrNull(row.model.compat),
        row.sort,
        now,
        now
      )
    }
  })
  insert()

  return { status: 'saved', providerId, providerKey }
}

/** 只接受属于这个 provider 的模型行；目录是只读的，不能借这里偷偷建模型。 */
export function setDefaultProviderModel(
  database: AppDatabase,
  providerId: string,
  modelRowId: string,
  options?: ProviderWriteOptions
): SetDefaultProviderModelResult {
  if (readModelProvider(database, providerId) === null) {
    return { status: 'missing' }
  }
  const row = database
    .prepare(
      'SELECT id FROM model_provider_model WHERE id = ? AND provider_id = ?'
    )
    .get(modelRowId, providerId) as { id: string } | undefined
  if (row === undefined) {
    return { status: 'rejected', reason: 'unknown-model' }
  }
  database
    .prepare('UPDATE model_provider SET default_model_id = ?, updated_at = ? WHERE id = ?')
    .run(row.id, timestampOf(options), providerId)
  return { status: 'saved', defaultModelId: row.id }
}

/**
 * 切换使用中只写一个设置键：正在生成的那一条已经冻结了自己的描述符，
 * 历史消息也只有模型名快照，所以这次切换只影响之后的调用。
 */
export function activateModelProvider(
  database: AppDatabase,
  providerId: string
): ActivateProviderResult {
  if (readModelProvider(database, providerId) === null) {
    return { status: 'missing' }
  }
  writeSetting(database, ACTIVE_PROVIDER_KEY, providerId)
  clearProviderSelection(database)
  return { status: 'activated', activeProviderId: providerId }
}

/**
 * 删除 provider：模型行随外键级联删除；线程与钉住没有指向 provider 的外键，
 * 所以历史不受影响。删的若是使用中的那套，明确清空选择并留下标记，
 * 让下一次对话提示「没有使用中的提供商」，而不是静默改用环境变量里的另一套凭据。
 */
export function deleteModelProvider(
  database: AppDatabase,
  providerId: string
): DeleteProviderResult {
  const provider: ModelProviderRecord | null = readModelProvider(database, providerId)
  if (provider === null) {
    return { status: 'missing' }
  }
  const wasActive = readActiveProviderId(database) === providerId

  const remove = database.transaction(() => {
    database.prepare('DELETE FROM model_provider WHERE id = ?').run(providerId)
    if (wasActive) {
      database.prepare('DELETE FROM setting WHERE key = ?').run(ACTIVE_PROVIDER_KEY)
      markProviderSelectionCleared(database)
    }
  })
  remove()

  return { status: 'deleted', activeCleared: wasActive }
}
