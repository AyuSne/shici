import { randomUUID } from 'node:crypto'
import type { CatalogModel } from '../../shared/model-catalog'
import {
  findProviderCatalogModel,
  isModelDirectoryReadOnly
} from '../../shared/model-directory'
import {
  isCustomProviderProtocol,
  isModelProtocol
} from '../../shared/model-protocols'
import type {
  AddProviderModelRequest,
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

/**
 * 容量入参只接受正的安全整数。0 不是「未知」——未知用 undefined/null；把 0
 * 写进请求限制会让上下文或输出上限直接失效，负数、小数与超出安全整数的值
 * 同样不能用。校验失败整笔拒绝。
 */
function capacitiesValid(draft: ProviderModelDraft): boolean {
  return [draft.contextWindow, draft.maxTokens].every(
    (value) =>
      value === undefined ||
      value === null ||
      (Number.isSafeInteger(value) && value > 0)
  )
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

function inputOf(catalog: CatalogModel | null): ModelInput {
  if (catalog === null) {
    return 'text'
  }
  return catalog.input.includes('text') ? 'text' : 'image'
}

type ModelMetadata = {
  displayName: string
  contextWindow: number | null
  maxTokens: number | null
  input: ModelInput
  reasoning: boolean
  thinkingLevelMap: string | null
  compat: string | null
}

/**
 * 手填模型行的目录元数据：条目在目录里就带出容量、思考映射与兼容开关；
 * 不在目录就留空，发送时由描述符按 1,000,000 / 128,000 / text 兜底。
 * 用户显式填的容量优先于目录值。
 */
function metadataOf(
  provider: ModelProviderRecord,
  draft: ProviderModelDraft
): ModelMetadata {
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

/**
 * 编辑模型行时的元数据：
 *
 * - 模型 ID 没变：这是普通编辑，保留已保存的隐藏元数据（用户此前调好的
 *   thinking_level_map / compat / input）与未显式改动的容量；
 * - 模型 ID 变了：身份换了，旧模型的兼容开关与思考映射不再成立。按新 ID 的
 *   目录条目重算；目录里没有就清空，发送时走通用兜底。用户显式填的容量与
 *   思考开关仍优先。
 */
function updatedMetadataOf(
  provider: ModelProviderRecord,
  existing: ModelProviderModelRecord,
  draft: ProviderModelDraft
): ModelMetadata & { baseUrl: string | null } {
  const modelId = draft.modelId.trim()
  if (modelId === existing.modelId) {
    return {
      displayName: draft.displayName?.trim() || existing.displayName,
      contextWindow:
        draft.contextWindow === undefined ? existing.contextWindow : draft.contextWindow,
      maxTokens: draft.maxTokens === undefined ? existing.maxTokens : draft.maxTokens,
      input: existing.input,
      reasoning: draft.reasoning ?? existing.reasoning,
      thinkingLevelMap: jsonOrNull(existing.thinkingLevelMap),
      compat: jsonOrNull(existing.compat),
      baseUrl: existing.baseUrl
    }
  }

  const catalog = findProviderCatalogModel(
    {
      source: provider.source,
      catalogProviderId: provider.catalogProviderId,
      protocol: provider.protocol
    },
    modelId
  )
  return {
    displayName: draft.displayName?.trim() || catalog?.name || modelId,
    contextWindow:
      draft.contextWindow === undefined
        ? (catalog?.contextWindow ?? null)
        : draft.contextWindow,
    maxTokens:
      draft.maxTokens === undefined ? (catalog?.maxTokens ?? null) : draft.maxTokens,
    input: inputOf(catalog),
    // 未知模型没有可借用的思考能力；用户显式勾选/取消优先。
    reasoning: draft.reasoning ?? catalog?.reasoning ?? false,
    thinkingLevelMap: jsonOrNull(catalog?.thinkingLevelMap),
    compat: jsonOrNull(catalog?.compat),
    // 逐模型地址属于旧身份；换模型后回落到 provider 的地址。
    baseUrl: null
  }
}

/**
 * 模型行的唯一 INSERT：创建自定义 provider 时批量写入与后来「加入模型」
 * 都走这里。列序、目录元数据与来源只写一份，避免加列时改漏一处。
 */
function insertModelRow(
  database: AppDatabase,
  provider: ModelProviderRecord,
  draft: ProviderModelDraft,
  sort: number,
  now: string,
  source: 'manual' | 'fetched',
  rowId = randomUUID()
): string {
  if (provider.protocol === null) {
    throw new Error(`provider ${provider.id} 没有可用的协议`)
  }
  const metadata = metadataOf(provider, draft)
  database
    .prepare(
      `INSERT INTO model_provider_model (
         id, provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
         input, reasoning, thinking_level_map, compat, source, sort, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      rowId,
      provider.id,
      draft.modelId.trim(),
      metadata.displayName,
      provider.protocol,
      metadata.contextWindow,
      metadata.maxTokens,
      metadata.input,
      metadata.reasoning ? 1 : 0,
      metadata.thinkingLevelMap,
      metadata.compat,
      source,
      sort,
      now,
      now
    )
  return rowId
}

/** 请求里的模型行来源只认两种；其余一律按手填，不冒充目录行。 */
function sourceOf(draft: Pick<ProviderModelDraft, 'source'>): 'manual' | 'fetched' {
  return draft.source === 'fetched' ? 'fetched' : 'manual'
}

/**
 * 把「首个模型 + 勾选的候选」收成一次事务的完整草稿。
 * 任何一行非法都整笔拒绝；重复 ID 用精确字符串比较（请求里两侧都 trim）。
 */
function customModelDraftsOf(
  request: CreateCustomProviderRequest
):
  | { ok: true; drafts: Array<ProviderModelDraft & { source: 'manual' | 'fetched' }> }
  | {
      ok: false
      reason: 'missing-model' | 'duplicate-model-id' | 'invalid-capacity'
    } {
  const raw = [request.model, ...(request.additionalModels ?? [])]
  if (raw.length === 0) {
    return { ok: false, reason: 'missing-model' }
  }

  const seen = new Set<string>()
  const drafts: Array<ProviderModelDraft & { source: 'manual' | 'fetched' }> = []
  for (const draft of raw) {
    if (typeof draft !== 'object' || draft === null) {
      return { ok: false, reason: 'missing-model' }
    }
    const modelId = typeof draft.modelId === 'string' ? draft.modelId.trim() : ''
    if (modelId === '') {
      return { ok: false, reason: 'missing-model' }
    }
    if (!capacitiesValid(draft)) {
      return { ok: false, reason: 'invalid-capacity' }
    }
    if (seen.has(modelId)) {
      return { ok: false, reason: 'duplicate-model-id' }
    }
    seen.add(modelId)
    drafts.push({ ...draft, modelId, source: sourceOf(draft) })
  }
  return { ok: true, drafts }
}

/** 从「自定义 API」入口创建一套 provider；至少要有一个模型，密钥只写密文。 */
export function createCustomProvider(
  database: AppDatabase,
  secrets: SecretStore,
  request: CreateCustomProviderRequest,
  options?: ProviderEditingOptions
): CreateCustomProviderResult {
  const providerKey = request.providerKey.trim()
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
  // 首个模型与「获取可用模型」勾选的候选在同一次事务里一起判定：任一行非法
  // 就整笔拒绝，不会出现 provider 已建、模型只写了一半的状态。
  const modelDrafts = customModelDraftsOf(request)
  if (!modelDrafts.ok) {
    return { status: 'rejected', reason: modelDrafts.reason }
  }
  const drafts = modelDrafts.drafts

  // 先校验/加密凭据再开事务：加密不可用时连 provider 行都不写。
  const credential = prepareProviderCredential(secrets, {
    authMode: request.authMode,
    envVar: request.envVar,
    apiKey: request.apiKey,
    // 自定义 API 可以先存成「缺失」草稿；发送前仍必须补密钥，不匿名请求。
    allowMissingStoredKey: true
  })
  if (!credential.ok) {
    return { status: 'rejected', reason: credential.reason }
  }

  const now = nowOf(options)
  const providerId = randomUUID()
  const modelRowIds = drafts.map(() => randomUUID())

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
        modelRowIds[0] ?? null,
        now,
        now
      )

    const provider = readModelProvider(database, providerId)
    if (provider === null) {
      throw new Error('provider 写入后读不回来')
    }

    drafts.forEach((draft, index) => {
      const rowId = modelRowIds[index]
      if (rowId === undefined) {
        throw new Error('模型行 id 缺失')
      }
      insertModelRow(database, provider, draft, index, now, draft.source, rowId)
    })
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

/**
 * 手加一条或多条模型行；目录外的 ID 也允许，缺元数据时留给发送层兜底。
 * 批量（获取可用模型后「加入所选模型」）在同一事务里完成：任一行非法或重复
 * 就整批拒绝，不会出现只加进去一半的目录。
 */
export function addProviderModel(
  database: AppDatabase,
  request: AddProviderModelRequest,
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

  const raw = [request.model, ...(request.additionalModels ?? [])]
  if (raw.length === 0) {
    return { status: 'rejected', reason: 'missing-model-id' }
  }

  const existingIds = new Set(
    readProviderModels(database, provider.id).map((model) => model.modelId)
  )
  const drafts: Array<ProviderModelDraft & { modelId: string }> = []
  for (const draft of raw) {
    if (typeof draft !== 'object' || draft === null) {
      return { status: 'rejected', reason: 'missing-model-id' }
    }
    const modelId = typeof draft.modelId === 'string' ? draft.modelId.trim() : ''
    if (modelId === '') {
      return { status: 'rejected', reason: 'missing-model-id' }
    }
    if (!capacitiesValid(draft)) {
      return { status: 'rejected', reason: 'invalid-capacity' }
    }
    if (existingIds.has(modelId)) {
      return { status: 'rejected', reason: 'duplicate-model-id' }
    }
    existingIds.add(modelId)
    drafts.push({ ...draft, modelId })
  }

  const now = nowOf(options)
  const models = readProviderModels(database, provider.id)
  const baseSort = (models.at(-1)?.sort ?? -1) + 1
  const insert = database.transaction(() => {
    const rowIds = drafts.map((draft, index) =>
      insertModelRow(
        database,
        provider,
        draft,
        baseSort + index,
        now,
        sourceOf(draft)
      )
    )
    if (models.length === 0) {
      database
        .prepare('UPDATE model_provider SET default_model_id = ?, updated_at = ? WHERE id = ?')
        .run(rowIds[0] ?? null, now, provider.id)
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
  const metadata = updatedMetadataOf(provider, existing, request.model)
  database
    .prepare(
      `UPDATE model_provider_model
          SET model_id = ?, display_name = ?, base_url = ?, context_window = ?,
              max_tokens = ?, input = ?, reasoning = ?, thinking_level_map = ?,
              compat = ?, updated_at = ?
        WHERE id = ? AND provider_id = ?`
    )
    .run(
      modelId,
      metadata.displayName,
      metadata.baseUrl,
      metadata.contextWindow,
      metadata.maxTokens,
      metadata.input,
      metadata.reasoning ? 1 : 0,
      metadata.thinkingLevelMap,
      metadata.compat,
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
