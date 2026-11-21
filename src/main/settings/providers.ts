import type {
  ModelInput,
  ModelProviderModelSummary,
  ModelProviderSummary,
  ModelSource,
  ProviderAuthMode,
  ProviderCheckError,
  ProviderKeyState,
  ProviderProtocol,
  ProviderRetryPolicy,
  ProviderSource,
  ProviderVerification
} from '../../shared/model-providers'
import type { ModelThinkingLevel } from '../../shared/model-catalog'
import { isModelProtocol } from '../../shared/model-protocols'
import { DEFAULT_RETRY_POLICY } from '../../shared/model-providers'
import type { AppDatabase } from '../db/database'
import { readSetting, writeSetting } from '../db/settings'
import type { SecretStore } from './secret-store'

/** 使用中的 provider 存在 setting 表里；切换只写这一个键，不改历史。 */
export const ACTIVE_PROVIDER_KEY = 'chat.activeProviderId'

/**
 * 用户明确删掉「使用中」的 provider 之后留的标记：这时不能静默拿环境变量里
 * 另一套凭据顶上，下一次对话要明确提示没有使用中的提供商。
 */
export const PROVIDER_SELECTION_CLEARED_KEY = 'chat.providerSelectionCleared'

/** thinkingLevelMap / compat 这种目录描述符存成 JSON；坏值按没有处理，不让一行配置打不开设置页。 */
export type ModelThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>

const MASK_DOTS = '·············'

/** 库里的一行 provider；`secretCiphertext` 是 safeStorage 密文，不是明文。 */
export type ModelProviderRecord = {
  id: string
  providerKey: string
  displayName: string
  /** null 表示库里存了本版不认识的协议：不静默换成别的。 */
  protocol: ProviderProtocol | null
  baseUrl: string | null
  authMode: ProviderAuthMode
  envVar: string | null
  secretCiphertext: string | null
  retryPolicy: ProviderRetryPolicy
  verification: ProviderVerification
  lastError: ProviderCheckError | null
  lastCheckedAt: string | null
  lastVerifiedAt: string | null
  source: ProviderSource
  /** 内置目录身份（deepseek / kimi / glm）；迁移来的 custom 为 null。 */
  catalogProviderId: string | null
  /** 默认模型**行 id**（库内 id，不是请求里发送的模型名）。 */
  defaultModelRowId: string | null
  createdAt: string
  updatedAt: string
}

export type ModelProviderModelRecord = {
  id: string
  providerId: string
  modelId: string
  displayName: string
  /** null 表示库里存了本版不认识的协议：不发请求，也不猜成别的协议。 */
  api: ProviderProtocol | null
  baseUrl: string | null
  contextWindow: number | null
  maxTokens: number | null
  input: ModelInput
  reasoning: boolean
  thinkingLevelMap: ModelThinkingLevelMap | null
  compat: Record<string, unknown> | null
  source: ModelSource
  sort: number
  createdAt: string
  updatedAt: string
}

/** 主进程内部真正发一次请求需要的三项；渲染层永远拿不到 `apiKey`。 */
export type ActiveProviderConfig = {
  provider: ModelProviderRecord
  model: ModelProviderModelRecord
  apiKey: string
}

export type ProviderReadOptions = {
  secrets: SecretStore
  env?: NodeJS.ProcessEnv
}

type ProviderRow = {
  id: string
  provider_key: string
  display_name: string
  protocol: string
  base_url: string | null
  auth_mode: string
  env_var: string | null
  secret_ciphertext: string | null
  retry_policy: string
  verification: string
  last_error: string | null
  last_checked_at: string | null
  last_verified_at: string | null
  source: string
  catalog_provider_id: string | null
  default_model_id: string | null
  created_at: string
  updated_at: string
}

type ModelRow = {
  id: string
  provider_id: string
  model_id: string
  display_name: string
  api: string
  base_url: string | null
  context_window: number | null
  max_tokens: number | null
  input: string
  reasoning: number
  thinking_level_map: string | null
  compat: string | null
  source: string
  sort: number
  created_at: string
  updated_at: string
}

const PROVIDER_COLUMNS = `id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
  secret_ciphertext, retry_policy, verification, last_error, last_checked_at, last_verified_at,
  source, catalog_provider_id, default_model_id, created_at, updated_at`

const MODEL_COLUMNS = `id, provider_id, model_id, display_name, api, base_url, context_window,
  max_tokens, input, reasoning, thinking_level_map, compat, source, sort, created_at, updated_at`

/**
 * 库里读出的协议：只认共享清单里的四个值。
 *
 * 旧实现保留了一份本地 `PROTOCOLS` 数组，数组可以短于类型（给类型加协议却忘了
 * 加进数组时 TypeScript 不报错），未知值会被静默换成 openai-completions，等于拿
 * 错误的协议发请求。这里改用共享守卫；不认识的持久化值返回 null，由调用方明确
 * 拒绝（聊天不发请求、卡片显示未识别），绝不冒充另一个协议。
 */
function protocolOf(value: string): ProviderProtocol | null {
  return isModelProtocol(value) ? value : null
}

function checkErrorOf(value: string | null): ProviderCheckError | null {
  return value === 'invalid-key' || value === 'invalid-config' || value === 'network'
    ? value
    : null
}

function retryPolicyOf(value: string): ProviderRetryPolicy {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed === 'object' && parsed !== null) {
      const mode = (parsed as Record<string, unknown>).mode
      if (mode === 'always') {
        return { mode: 'always' }
      }
    }
  } catch {
    // 坏 JSON 按默认策略跑，不让一行配置把设置页打不开。
  }
  return { ...DEFAULT_RETRY_POLICY }
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null || value.trim() === '') {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function parseThinkingLevelMap(value: string | null): ModelThinkingLevelMap | null {
  const parsed = parseJsonObject(value)
  if (parsed === null) {
    return null
  }
  const map: ModelThinkingLevelMap = {}
  for (const [level, mapped] of Object.entries(parsed)) {
    if (typeof mapped === 'string' || mapped === null) {
      map[level as ModelThinkingLevel] = mapped
    }
  }
  return map
}

function toProviderRecord(row: ProviderRow): ModelProviderRecord {
  return {
    id: row.id,
    providerKey: row.provider_key,
    displayName: row.display_name,
    protocol: protocolOf(row.protocol),
    baseUrl: row.base_url,
    authMode: row.auth_mode === 'env' ? 'env' : 'stored',
    envVar: row.env_var,
    secretCiphertext: row.secret_ciphertext,
    retryPolicy: retryPolicyOf(row.retry_policy),
    verification: row.verification === 'verified' ? 'verified' : 'unverified',
    lastError: checkErrorOf(row.last_error),
    lastCheckedAt: row.last_checked_at,
    lastVerifiedAt: row.last_verified_at,
    source: row.source === 'builtin' ? 'builtin' : 'custom',
    catalogProviderId: row.catalog_provider_id,
    defaultModelRowId: row.default_model_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toModelRecord(row: ModelRow): ModelProviderModelRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelId: row.model_id,
    displayName: row.display_name,
    api: protocolOf(row.api),
    baseUrl: row.base_url,
    contextWindow: row.context_window,
    maxTokens: row.max_tokens,
    input: row.input === 'image' ? 'image' : 'text',
    reasoning: row.reasoning === 1,
    thinkingLevelMap: parseThinkingLevelMap(row.thinking_level_map),
    compat: parseJsonObject(row.compat),
    source: row.source === 'catalog' || row.source === 'fetched' ? row.source : 'manual',
    sort: row.sort,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toModelSummary(record: ModelProviderModelRecord): ModelProviderModelSummary {
  return {
    id: record.id,
    modelId: record.modelId,
    displayName: record.displayName,
    api: record.api,
    baseUrl: record.baseUrl,
    contextWindow: record.contextWindow,
    maxTokens: record.maxTokens,
    input: record.input,
    reasoning: record.reasoning,
    source: record.source,
    sort: record.sort
  }
}

/**
 * 密钥掩码：只留 `sk-` 前缀与末四位，中间固定一串点。
 * 短于五位的密钥连末四位也不留，避免掩码本身泄露全部内容。
 */
export function maskApiKey(key: string): string {
  const trimmed = key.trim()
  if (trimmed === '') {
    return ''
  }
  const visible = trimmed.length > 4 ? trimmed.slice(-4) : ''
  const prefix = trimmed.startsWith('sk-') ? 'sk-' : ''
  return `${prefix}${MASK_DOTS}${visible}`
}

/** 主进程内部用：按密钥来源解析出明文。解密失败不静默退回环境变量。 */
export function readProviderApiKey(
  provider: ModelProviderRecord,
  options: ProviderReadOptions
): string {
  if (provider.authMode === 'env') {
    const name = provider.envVar?.trim() ?? ''
    return name === '' ? '' : (options.env?.[name]?.trim() ?? '')
  }
  if (provider.secretCiphertext === null) {
    return ''
  }
  try {
    return options.secrets.decrypt(provider.secretCiphertext) ?? ''
  } catch {
    return ''
  }
}

function keyStateOf(
  provider: ModelProviderRecord,
  options: ProviderReadOptions
): ProviderKeyState {
  if (provider.authMode === 'env') {
    return readProviderApiKey(provider, options) === '' ? 'missing' : 'env'
  }
  if (provider.secretCiphertext === null) {
    return 'missing'
  }
  return readProviderApiKey(provider, options) === '' ? 'missing' : 'stored'
}

export function readModelProvider(
  database: AppDatabase,
  id: string
): ModelProviderRecord | null {
  const row = database
    .prepare(`SELECT ${PROVIDER_COLUMNS} FROM model_provider WHERE id = ?`)
    .get(id) as ProviderRow | undefined
  return row ? toProviderRecord(row) : null
}

/** 按创建顺序列出 provider。 */
export function readModelProviderRecords(database: AppDatabase): ModelProviderRecord[] {
  const rows = database
    .prepare(`SELECT ${PROVIDER_COLUMNS} FROM model_provider ORDER BY created_at, rowid`)
    .all() as ProviderRow[]
  return rows.map(toProviderRecord)
}

export function readProviderModels(
  database: AppDatabase,
  providerId: string
): ModelProviderModelRecord[] {
  const rows = database
    .prepare(
      `SELECT ${MODEL_COLUMNS} FROM model_provider_model
        WHERE provider_id = ? ORDER BY sort, rowid`
    )
    .all(providerId) as ModelRow[]
  return rows.map(toModelRecord)
}

/** 使用中的 provider id。指向已经不存在的配置时当作没有，
 * 不把用户留在一个不存在的选择上。 */
export function readActiveProviderId(database: AppDatabase): string | null {
  const stored = readSetting(database, ACTIVE_PROVIDER_KEY)?.trim()
  if (!stored) {
    return null
  }
  return readModelProvider(database, stored) === null ? null : stored
}

/** 删掉使用中的 provider 之后，明确进入「没有使用中」的状态。 */
export function isProviderSelectionCleared(database: AppDatabase): boolean {
  return readSetting(database, PROVIDER_SELECTION_CLEARED_KEY) === '1'
}

export function clearProviderSelection(database: AppDatabase): void {
  database.prepare('DELETE FROM setting WHERE key = ?').run(PROVIDER_SELECTION_CLEARED_KEY)
}

export function markProviderSelectionCleared(database: AppDatabase): void {
  writeSetting(database, PROVIDER_SELECTION_CLEARED_KEY, '1')
}

/** provider 的默认模型：优先选中的那条，没有就退回目录里的第一条。 */
export function readDefaultModel(
  database: AppDatabase,
  provider: ModelProviderRecord
): ModelProviderModelRecord | null {
  const models = readProviderModels(database, provider.id)
  if (models.length === 0) {
    return null
  }
  if (provider.defaultModelRowId !== null) {
    const chosen = models.find((model) => model.id === provider.defaultModelRowId)
    if (chosen !== undefined) {
      return chosen
    }
  }
  return models[0] ?? null
}

/** 设置页一次性读到的只读 provider 列表，含「使用中」标记与三态密钥。 */
export function listModelProviders(
  database: AppDatabase,
  options: ProviderReadOptions
): ModelProviderSummary[] {
  const activeId = readActiveProviderId(database)
  return readModelProviderRecords(database).map((provider) => {
    const models = readProviderModels(database, provider.id)
    const defaultModel =
      provider.defaultModelRowId === null
        ? (models[0] ?? null)
        : (models.find((model) => model.id === provider.defaultModelRowId) ?? models[0] ?? null)
    const apiKey = readProviderApiKey(provider, options)
    return {
      id: provider.id,
      providerKey: provider.providerKey,
      displayName: provider.displayName,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      authMode: provider.authMode,
      envVar: provider.envVar,
      apiKeyMask:
        provider.authMode === 'env' || apiKey === '' ? null : maskApiKey(apiKey),
      keyState: keyStateOf(provider, options),
      retryPolicy: provider.retryPolicy,
      verification: provider.verification,
      lastError: provider.lastError,
      lastCheckedAt: provider.lastCheckedAt,
      lastVerifiedAt: provider.lastVerifiedAt,
      source: provider.source,
      catalogProviderId: provider.catalogProviderId,
      active: provider.id === activeId,
      defaultModelRowId: defaultModel?.id ?? null,
      models: models.map(toModelSummary)
    }
  })
}

/** 一次调用真正该用的 provider + 默认模型 + 明文密钥；没有可用配置时返回 null。 */
export function readActiveChatProvider(
  database: AppDatabase,
  options: ProviderReadOptions
): ActiveProviderConfig | null {
  const activeId = readActiveProviderId(database)
  if (activeId === null) {
    return null
  }
  const provider = readModelProvider(database, activeId)
  if (provider === null) {
    return null
  }
  const model = readDefaultModel(database, provider)
  if (model === null) {
    return null
  }
  return { provider, model, apiKey: readProviderApiKey(provider, options) }
}

/**
 * 一次成功调用之后自动转「已验证」。这里不写上次校验时间：
 * 那是对「测试连接」这类显式校验的记时，成功调用只证明配置此刻可用。
 * 迁移后只写 provider 表，旧 model_profile 不再接受运行时写入。
 */
export function markProviderVerified(
  database: AppDatabase,
  providerId: string,
  now = new Date().toISOString()
): void {
  database
    .prepare(
      `UPDATE model_provider SET verification = 'verified', last_error = NULL,
         last_verified_at = ?, updated_at = ? WHERE id = ?`
    )
    .run(now, now, providerId)
}
