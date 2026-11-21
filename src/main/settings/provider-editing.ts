import { randomUUID } from 'node:crypto'
import type { CatalogModel } from '../../shared/model-catalog'
import { findProviderCatalogModel } from '../../shared/model-directory'
import {
  isCustomProviderProtocol,
  isModelProtocol
} from '../../shared/model-protocols'
import type {
  CreateCustomProviderRequest,
  CreateCustomProviderResult,
  ModelInput,
  ProviderModelDraft,
  ProviderModelWriteResult,
  UpdateProviderRequest,
  UpdateProviderResult
} from '../../shared/model-providers'
import { isValidProviderId } from '../../shared/model-providers'
import type { AppDatabase } from '../db/database'
import { prepareProviderCredential } from './credentials'
import type { SecretStore } from './secret-store'
import { parseHttpUrl } from './base-url'
import {
  readDefaultModel,
  readModelProvider,
  readProviderModels,
  type ModelProviderModelRecord,
  type ModelProviderRecord
} from './providers'

/**
 * #63 的 provider / 模型目录写入。
 *
 * 这里只做三件事：自定义 provider 的创建、provider 显示名与地址的编辑、
 * 单协议 provider 的模型行增删改与排序。凭据来源（本机 / 环境变量）统一交给
 * `credentials.ts` 的 `prepareProviderCredential`，模型目录逻辑不需要知道密钥来源。
 *
 * 所有写入都是纯本地动作，不发网络请求；校验失败不写半条配置。
 */

export type ProviderEditingOptions = {
  /** 测试注入固定时间；生产不传。 */
  now?: string
}

function nowOf(options: ProviderEditingOptions | undefined): string {
  return options?.now ?? new Date().toISOString()
}

function providerKeyExists(database: AppDatabase, providerKey: string): boolean {
  return (
    database
      .prepare('SELECT 1 FROM model_provider WHERE provider_key = ?')
      .get(providerKey) !== undefined
  )
}

function modelIdExists(
  database: AppDatabase,
  providerId: string,
  modelId: string,
  exceptRowId?: string
): boolean {
  const row =
    exceptRowId === undefined
      ? database
          .prepare(
            'SELECT 1 FROM model_provider_model WHERE provider_id = ? AND model_id = ?'
          )
          .get(providerId, modelId)
      : database
          .prepare(
            `SELECT 1 FROM model_provider_model
              WHERE provider_id = ? AND model_id = ? AND id <> ?`
          )
          .get(providerId, modelId, exceptRowId)
  return row !== undefined
}

function capacitiesValid(draft: ProviderModelDraft): boolean {
  return [draft.contextWindow, draft.maxTokens].every(
    (value) =>
      value === undefined ||
      value === null ||
      (Number.isInteger(value) && value >= 0)
  )
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

/**
 * #59 的聚合入口 OpenCode GO 首版只读：能选默认模型，不能在这个版本手加、
 * 改、删或重排模型行。其它内置入口与自定义 provider 都可编辑。
 */
export function isModelDirectoryReadOnly(
  provider: Pick<ModelProviderRecord, 'catalogProviderId'>
): boolean {
  return provider.catalogProviderId === 'opencode-go'
}

function inputOf(catalog: CatalogModel | null): ModelInput {
  if (catalog === null) {
    return 'text'
  }
  return catalog.input.includes('text') ? 'text' : 'image'
}

/**
 * 手填模型行的目录元数据：条目在目录里就带出容量、思考映射与兼容开关；
 * 不在目录就留空，发送时由描述符按 1,000,000 / 128,000 / text 兜底。
 * 用户显式填的容量优先于目录值。
 */
function metadataOf(
  provider: ModelProviderRecord,
  draft: ProviderModelDraft
): {
  displayName: string
  contextWindow: number | null
  maxTokens: number | null
  input: ModelInput
  reasoning: boolean
  thinkingLevelMap: string | null
  compat: string | null
} {
  const catalog = findProviderCatalogModel(
    {
      source: provider.source,
      catalogProviderId: provider.catalogProviderId,
      protocol: provider.protocol
    },
    draft.modelId
  )
  return {
    displayName:
      draft.displayName?.trim() || catalog?.name || draft.modelId.trim(),
    contextWindow:
      draft.contextWindow === undefined
        ? (catalog?.contextWindow ?? null)
        : draft.contextWindow,
    maxTokens:
      draft.maxTokens === undefined ? (catalog?.maxTokens ?? null) : draft.maxTokens,
    input: inputOf(catalog),
    reasoning: draft.reasoning ?? catalog?.reasoning ?? false,
    thinkingLevelMap: jsonOrNull(catalog?.thinkingLevelMap),
    compat: jsonOrNull(catalog?.compat)
  }
}

function insertModelRow(
  database: AppDatabase,
  providerId: string,
  draft: ProviderModelDraft,
  sort: number,
  now: string
): string {
  const provider = readModelProvider(database, providerId)
  if (provider === null || provider.protocol === null) {
    throw new Error(`provider ${providerId} 没有可用的协议`)
  }
  const metadata = metadataOf(provider, draft)
  const rowId = randomUUID()
  database
    .prepare(
      `INSERT INTO model_provider_model (
         id, provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
         input, reasoning, thinking_level_map, compat, source, sort, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`
    )
    .run(
      rowId,
      providerId,
      draft.modelId.trim(),
      metadata.displayName,
      provider.protocol,
      metadata.contextWindow,
      metadata.maxTokens,
      metadata.input,
      metadata.reasoning ? 1 : 0,
      metadata.thinkingLevelMap,
      metadata.compat,
      sort,
      now,
      now
    )
  return rowId
}

/** 从「自定义 API」入口创建一套 provider；至少要有一个模型，密钥只写密文。 */
export function createCustomProvider(
  database: AppDatabase,
  secrets: SecretStore,
  request: CreateCustomProviderRequest,
  options?: ProviderEditingOptions
): CreateCustomProviderResult {
  const providerKey = request.providerId.trim()
  if (!isValidProviderId(providerKey)) {
    return { status: 'rejected', reason: 'invalid-provider-id' }
  }
  if (providerKeyExists(database, providerKey)) {
    return { status: 'rejected', reason: 'duplicate-provider-id' }
  }
  const displayName = request.displayName.trim()
  if (displayName === '') {
    return { status: 'rejected', reason: 'missing-display-name' }
  }
  if (!isModelProtocol(request.protocol) || !isCustomProviderProtocol(request.protocol)) {
    return { status: 'rejected', reason: 'unsupported-protocol' }
  }
  const baseUrl = request.baseUrl.trim()
  if (baseUrl === '') {
    return { status: 'rejected', reason: 'missing-base-url' }
  }
  if (parseHttpUrl(baseUrl) === null) {
    return { status: 'rejected', reason: 'invalid-base-url' }
  }
  const modelDraft: ProviderModelDraft = { modelId: request.model.modelId }
  if (modelDraft.modelId.trim() === '') {
    return { status: 'rejected', reason: 'missing-model' }
  }

  // 先校验/加密凭据再开事务：加密不可用时连 provider 行都不写。
  const credential = prepareProviderCredential(secrets, {
    authMode: request.authMode,
    envVar: request.envVar,
    apiKey: request.apiKey,
    // 自定义 API 可以是无需密钥的本地服务；内置目录添加仍必须填 key。
    allowEmptyStoredKey: true
  })
  if (!credential.ok) {
    return { status: 'rejected', reason: credential.reason }
  }

  const now = nowOf(options)
  const providerId = randomUUID()
  const modelRowId = randomUUID()

  const insert = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO model_provider (
           id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
           secret_ciphertext, retry_policy, verification, last_error, last_checked_at,
           last_verified_at, source, catalog_provider_id, default_model_id, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{"mode":"normal"}', 'unverified', NULL, NULL,
                   NULL, 'custom', NULL, ?, ?, ?)`
      )
      .run(
        providerId,
        providerKey,
        displayName,
        request.protocol,
        baseUrl,
        credential.authMode,
        credential.envVar,
        credential.secretCiphertext,
        modelRowId,
        now,
        now
      )

    // 首个模型与 provider 同一笔事务写入；目录里查不到时保留未知 ID。
    const provider = readModelProvider(database, providerId)
    if (provider === null) {
      throw new Error('provider 写入后读不回来')
    }
    const metadata = metadataOf(provider, modelDraft)
    database
      .prepare(
        `INSERT INTO model_provider_model (
           id, provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
           input, reasoning, thinking_level_map, compat, source, sort, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'manual', 0, ?, ?)`
      )
      .run(
        modelRowId,
        providerId,
        modelDraft.modelId.trim(),
        metadata.displayName,
        request.protocol,
        metadata.contextWindow,
        metadata.maxTokens,
        metadata.input,
        metadata.reasoning ? 1 : 0,
        metadata.thinkingLevelMap,
        metadata.compat,
        now,
        now
      )
  })
  insert()

  return { status: 'saved', providerId, providerKey }
}

/** 只改显示名与地址；Provider ID 与协议没有入参，创建后不可改。 */
export function updateModelProvider(
  database: AppDatabase,
  request: UpdateProviderRequest,
  options?: ProviderEditingOptions
): UpdateProviderResult {
  const provider = readModelProvider(database, request.providerId)
  if (provider === null) {
    return { status: 'missing' }
  }
  const displayName = request.displayName.trim()
  if (displayName === '') {
    return { status: 'rejected', reason: 'missing-display-name' }
  }
  const baseUrl = request.baseUrl.trim()
  if (baseUrl === '') {
    return { status: 'rejected', reason: 'missing-base-url' }
  }
  if (parseHttpUrl(baseUrl) === null) {
    return { status: 'rejected', reason: 'invalid-base-url' }
  }

  const now = nowOf(options)
  const addressChanged = baseUrl !== (provider.baseUrl ?? '').trim()
  const update = database.transaction(() => {
    database
      .prepare(
        `UPDATE model_provider
            SET display_name = ?, base_url = ?, updated_at = ?
          WHERE id = ?`
      )
      .run(displayName, baseUrl, now, provider.id)
    if (addressChanged) {
      // 地址变了，此前的「已验证」不再代表这套配置；下次真实调用/测试连接再转回来。
      database
        .prepare(
          `UPDATE model_provider
              SET verification = 'unverified', last_error = NULL,
                  last_checked_at = NULL, last_verified_at = NULL
            WHERE id = ?`
        )
        .run(provider.id)
    }
  })
  update()

  return { status: 'saved' }
}

/** 手加一条模型行；目录外的 ID 也允许，缺元数据时留给发送层兜底。 */
export function addProviderModel(
  database: AppDatabase,
  request: { providerId: string; model: ProviderModelDraft },
  options?: ProviderEditingOptions
): ProviderModelWriteResult {
  const provider = readModelProvider(database, request.providerId)
  if (provider === null) {
    return { status: 'missing' }
  }
  if (isModelDirectoryReadOnly(provider)) {
    return { status: 'rejected', reason: 'read-only' }
  }
  if (provider.protocol === null) {
    return { status: 'rejected', reason: 'unknown-protocol' }
  }
  const modelId = request.model.modelId.trim()
  if (modelId === '') {
    return { status: 'rejected', reason: 'missing-model-id' }
  }
  if (!capacitiesValid(request.model)) {
    return { status: 'rejected', reason: 'invalid-capacity' }
  }
  if (modelIdExists(database, provider.id, modelId)) {
    return { status: 'rejected', reason: 'duplicate-model-id' }
  }

  const now = nowOf(options)
  const models = readProviderModels(database, provider.id)
  const sort = (models.at(-1)?.sort ?? -1) + 1
  const insert = database.transaction(() => {
    const modelRowId = insertModelRow(
      database,
      provider.id,
      { ...request.model, modelId },
      sort,
      now
    )
    if (models.length === 0) {
      database
        .prepare('UPDATE model_provider SET default_model_id = ?, updated_at = ? WHERE id = ?')
        .run(modelRowId, now, provider.id)
    } else {
      database
        .prepare('UPDATE model_provider SET updated_at = ? WHERE id = ?')
        .run(now, provider.id)
    }
  })
  insert()

  return { status: 'saved' }
}

/** 改模型行：ID、显示名与容量；没给的容量字段保持原值。 */
export function updateProviderModel(
  database: AppDatabase,
  request: {
    providerId: string
    modelRowId: string
    model: ProviderModelDraft
  },
  options?: ProviderEditingOptions
): ProviderModelWriteResult {
  const provider = readModelProvider(database, request.providerId)
  if (provider === null) {
    return { status: 'missing' }
  }
  if (isModelDirectoryReadOnly(provider)) {
    return { status: 'rejected', reason: 'read-only' }
  }
  const existing = readProviderModels(database, provider.id).find(
    (model) => model.id === request.modelRowId
  )
  if (existing === undefined) {
    return { status: 'rejected', reason: 'unknown-model' }
  }
  const modelId = request.model.modelId.trim()
  if (modelId === '') {
    return { status: 'rejected', reason: 'missing-model-id' }
  }
  if (!capacitiesValid(request.model)) {
    return { status: 'rejected', reason: 'invalid-capacity' }
  }
  if (modelIdExists(database, provider.id, modelId, existing.id)) {
    return { status: 'rejected', reason: 'duplicate-model-id' }
  }

  const now = nowOf(options)
  database
    .prepare(
      `UPDATE model_provider_model
          SET model_id = ?, display_name = ?, context_window = ?, max_tokens = ?,
              reasoning = ?, updated_at = ?
        WHERE id = ? AND provider_id = ?`
    )
    .run(
      modelId,
      request.model.displayName?.trim() || modelId,
      request.model.contextWindow === undefined
        ? existing.contextWindow
        : request.model.contextWindow,
      request.model.maxTokens === undefined ? existing.maxTokens : request.model.maxTokens,
      (request.model.reasoning ?? existing.reasoning) ? 1 : 0,
      now,
      existing.id,
      provider.id
    )
  database
    .prepare('UPDATE model_provider SET updated_at = ? WHERE id = ?')
    .run(now, provider.id)

  return { status: 'saved' }
}

/** 删模型：默认模型必须另选一个才能删，最后一条永远不能被删空。 */
export function deleteProviderModel(
  database: AppDatabase,
  request: { providerId: string; modelRowId: string },
  options?: ProviderEditingOptions
): ProviderModelWriteResult {
  const provider = readModelProvider(database, request.providerId)
  if (provider === null) {
    return { status: 'missing' }
  }
  if (isModelDirectoryReadOnly(provider)) {
    return { status: 'rejected', reason: 'read-only' }
  }
  const models = readProviderModels(database, provider.id)
  const target = models.find((model) => model.id === request.modelRowId)
  if (target === undefined) {
    return { status: 'rejected', reason: 'unknown-model' }
  }
  if (models.length === 1) {
    return { status: 'rejected', reason: 'last-model' }
  }
  const defaultModel = readDefaultModel(database, provider)
  if (defaultModel?.id === target.id) {
    return { status: 'rejected', reason: 'default-model' }
  }

  const now = nowOf(options)
  const remaining = models.filter((model) => model.id !== target.id)
  const remove = database.transaction(() => {
    database
      .prepare('DELETE FROM model_provider_model WHERE id = ? AND provider_id = ?')
      .run(target.id, provider.id)
    const renumber = database.prepare(
      'UPDATE model_provider_model SET sort = ?, updated_at = ? WHERE id = ?'
    )
    remaining.forEach((model, index) => renumber.run(index, now, model.id))
    database
      .prepare('UPDATE model_provider SET updated_at = ? WHERE id = ?')
      .run(now, provider.id)
  })
  remove()

  return { status: 'deleted' }
}

/**
 * 保存模型顺序：请求必须带完整的当前目录；缺行、重复、多行都拒绝，
 * 避免用过期的顺序覆盖掉别处刚加的模型。排序即保存顺序。
 */
export function reorderProviderModels(
  database: AppDatabase,
  request: { providerId: string; modelRowIds: string[] },
  options?: ProviderEditingOptions
): ProviderModelWriteResult {
  const provider = readModelProvider(database, request.providerId)
  if (provider === null) {
    return { status: 'missing' }
  }
  if (isModelDirectoryReadOnly(provider)) {
    return { status: 'rejected', reason: 'read-only' }
  }
  const models = readProviderModels(database, provider.id)
  const requested = new Set(request.modelRowIds)
  const exactOrder =
    request.modelRowIds.length === models.length &&
    requested.size === models.length &&
    models.every((model) => requested.has(model.id))
  if (!exactOrder) {
    return { status: 'rejected', reason: 'order-mismatch' }
  }

  const now = nowOf(options)
  const byId = new Map(models.map((model) => [model.id, model]))
  const save = database.transaction(() => {
    const update = database.prepare(
      'UPDATE model_provider_model SET sort = ?, updated_at = ? WHERE id = ?'
    )
    request.modelRowIds.forEach((modelRowId, index) => {
      const model: ModelProviderModelRecord | undefined = byId.get(modelRowId)
      if (model === undefined) {
        throw new Error(`模型行 ${modelRowId} 不在这个 provider 里`)
      }
      update.run(index, now, model.id)
    })
    database
      .prepare('UPDATE model_provider SET updated_at = ? WHERE id = ?')
      .run(now, provider.id)
  })
  save()

  return { status: 'saved' }
}
