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
import type { ChatError, ProviderErrorCode } from '../../shared/chat'
import type { ModelThinkingLevel } from '../../shared/model-catalog'
import { isModelProtocol } from '../../shared/model-protocols'
import { DEFAULT_RETRY_POLICY } from '../../shared/model-providers'
import type { AppDatabase } from '../db/database'
import { readSetting, writeSetting } from '../db/settings'
import {
  resolveProviderCredential,
  type CredentialReadOptions,
  type ResolvedCredential
} from './credentials'

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
  /** 上次失败时服务端给的 request id；旧数据没有。 */
  lastErrorRequestId: string | null
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
  /** 三态解析结果；缺失原因单独留着，发送时据此点名变量或报解不开。 */
  credential: ResolvedCredential
}

export type ProviderReadOptions = CredentialReadOptions

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

const CHECK_ERRORS: ReadonlySet<string> = new Set<ProviderCheckError>([
  'invalid-key',
  'invalid-config',
  'network',
  'quota',
  'rate-limit',
  'server',
  'timeout',
  'empty-response',
  'missing-credential',
  'unsupported-protocol',
  'no-model',
  'unknown'
])

function checkErrorOf(value: string): ProviderCheckError | null {
  return CHECK_ERRORS.has(value) ? (value as ProviderCheckError) : null
}

/**
 * `last_error` 列兼容两种写法：
 * - 旧数据与迁移数据是裸的分类字符串（invalid-key / network / …）；
 * - 本批开始把「原因 + request id」写成 JSON，排障时能和上游日志对上。
 *
 * 坏 JSON 或被删掉的旧分类按「没有记录」处理，不让一行配置打不开设置页。
 */
export function parseProviderLastError(value: string | null): {
  reason: ProviderCheckError | null
  requestId: string | null
} {
  if (value === null) {
    return { reason: null, requestId: null }
  }
  const trimmed = value.trim()
  if (trimmed === '') {
    return { reason: null, requestId: null }
  }
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>
        const reason =
          typeof record.reason === 'string' ? checkErrorOf(record.reason) : null
        const rawRequestId = record.requestId
        const requestId =
          typeof rawRequestId === 'string' && rawRequestId.trim() !== ''
            ? rawRequestId.trim()
            : null
        return { reason, requestId }
      }
    } catch {
      // 坏 JSON 按没有记录处理。
    }
    return { reason: null, requestId: null }
  }
  return { reason: checkErrorOf(trimmed), requestId: null }
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
  const lastError = parseProviderLastError(row.last_error)
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
    lastError: lastError.reason,
    lastErrorRequestId: lastError.requestId,
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
    const credential = resolveProviderCredential(provider, options)
    // 来源仍是三态：本机存着密文但解不开时，来源还是「本机」，另用
    // credentialError 说明它不可用——不能把损坏的密文静默说成「缺失」。
    const keyState: ProviderKeyState =
      provider.authMode === 'env'
        ? credential.state === 'env'
          ? 'env'
          : 'missing'
        : provider.secretCiphertext === null
          ? 'missing'
          : 'stored'
    const credentialError =
      credential.state === 'missing' && credential.problem.kind === 'stored-decrypt-failed'
        ? ('stored-decrypt-failed' as const)
        : null
    return {
      id: provider.id,
      providerKey: provider.providerKey,
      displayName: provider.displayName,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      authMode: provider.authMode,
      envVar: provider.envVar,
      apiKeyMask: credential.state === 'stored' ? maskApiKey(credential.apiKey) : null,
      keyState,
      hasStoredCiphertext: provider.secretCiphertext !== null,
      credentialError,
      retryPolicy: provider.retryPolicy,
      verification: provider.verification,
      lastError: provider.lastError,
      lastErrorRequestId: provider.lastErrorRequestId,
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
  const credential = resolveProviderCredential(provider, options)
  return {
    provider,
    model,
    apiKey: credential.state === 'missing' ? '' : credential.apiKey,
    credential
  }
}

/**
 * 状态回写的结果：`stale` 表示测试 / 调用期间配置被改过（地址、密钥、默认模型
 * 或目录行），这次结果不再代表当前配置，所以什么都没写。
 */
export type ProviderStatusWrite = 'recorded' | 'stale' | 'missing'

export type ProviderCheckFailure = {
  reason: ProviderCheckError
  /** 服务端给的 request id；没有响应（超时 / 连不上）时为空。 */
  requestId?: string
}

function statusWriteOf(
  database: AppDatabase,
  providerId: string,
  changes: number
): ProviderStatusWrite {
  if (changes > 0) {
    return 'recorded'
  }
  return readModelProvider(database, providerId) === null ? 'missing' : 'stale'
}

/**
 * 三个状态回写共用的条件 UPDATE。列名只来自固定白名单，值一律绑定参数；
 * 带 `expectedUpdatedAt` 时再加版本条件。不要把它扩成任意 SQL 构造器。
 */
type ProviderStatusPatch = {
  verification?: 'verified' | 'unverified'
  lastError?: string | null
  lastCheckedAt?: string | null
  lastVerifiedAt?: string | null
}

const STATUS_COLUMN: Record<keyof ProviderStatusPatch, string> = {
  verification: 'verification',
  lastError: 'last_error',
  lastCheckedAt: 'last_checked_at',
  lastVerifiedAt: 'last_verified_at'
}

function writeProviderStatus(
  database: AppDatabase,
  providerId: string,
  patch: ProviderStatusPatch,
  expectedUpdatedAt?: string
): ProviderStatusWrite {
  const keys = Object.keys(patch) as Array<keyof ProviderStatusPatch>
  const assignments = keys.map((key) => `${STATUS_COLUMN[key]} = ?`)
  const args: Array<string | null> = keys.map((key) => {
    const value = patch[key]
    return value === undefined ? null : value
  })
  args.push(providerId)
  const where = ['id = ?']
  if (expectedUpdatedAt !== undefined) {
    where.push('updated_at = ?')
    args.push(expectedUpdatedAt)
  }
  const result = database
    .prepare(
      `UPDATE model_provider SET ${assignments.join(', ')} WHERE ${where.join(' AND ')}`
    )
    .run(...args)
  return statusWriteOf(database, providerId, result.changes)
}

/**
 * 一次**真实调用**成功之后自动转「已验证」。
 *
 * 只写 provider 表；不写 `last_checked_at` —— 那是对「测试连接」这类显式校验
 * 的记时，成功调用只证明配置此刻可用。传入 `expectedUpdatedAt` 时做条件更新：
 * 调用期间换地址 / 换密钥 / 换默认模型会让旧结果落空，绝不把新配置误标已验证。
 */
export function markProviderVerified(
  database: AppDatabase,
  providerId: string,
  now = new Date().toISOString(),
  expectedUpdatedAt?: string
): ProviderStatusWrite {
  return writeProviderStatus(
    database,
    providerId,
    { verification: 'verified', lastError: null, lastVerifiedAt: now },
    expectedUpdatedAt
  )
}

/** 显式「测试连接」通过：同时记下校验时刻，与真实调用成功区分开。 */
export function markProviderCheckPassed(
  database: AppDatabase,
  providerId: string,
  checkedAt: string,
  expectedUpdatedAt?: string
): ProviderStatusWrite {
  return writeProviderStatus(
    database,
    providerId,
    {
      verification: 'verified',
      lastError: null,
      lastCheckedAt: checkedAt,
      lastVerifiedAt: checkedAt
    },
    expectedUpdatedAt
  )
}

/**
 * 记录一次失败：原因（以及可得的 request id）写进 `last_error`，时间写进
 * `last_checked_at`。`revokeVerified` 只给显式「测试连接」用：它没通过，
 * 就把「已验证」收回；真实对话失败只记录最后错误，不降级已验证状态。
 *
 * 与成功路径一样支持 `expectedUpdatedAt` 条件更新，避免运行中改配置后旧失败
 * 覆盖新配置的状态。
 */
export function recordProviderFailure(
  database: AppDatabase,
  providerId: string,
  failure: ProviderCheckFailure,
  options: {
    now?: string
    expectedUpdatedAt?: string
    revokeVerified?: boolean
  } = {}
): ProviderStatusWrite {
  const now = options.now ?? new Date().toISOString()
  const encoded = JSON.stringify({
    reason: failure.reason,
    ...(failure.requestId === undefined || failure.requestId.trim() === ''
      ? {}
      : { requestId: failure.requestId.trim() })
  })
  return writeProviderStatus(
    database,
    providerId,
    {
      lastError: encoded,
      lastCheckedAt: now,
      ...(options.revokeVerified === true
        ? { verification: 'unverified' as const, lastVerifiedAt: null }
        : {})
    },
    options.expectedUpdatedAt
  )
}

const CHECK_ERROR_OF_KIND: Record<ProviderErrorCode, ProviderCheckError> = {
  AUTH: 'invalid-key',
  INVALID_REQUEST: 'invalid-config',
  CONTEXT_WINDOW: 'invalid-config',
  QUOTA: 'quota',
  RATE_LIMIT: 'rate-limit',
  SERVER: 'server',
  TIMEOUT: 'timeout',
  TRANSPORT: 'network',
  EMPTY_RESPONSE: 'empty-response',
  UNKNOWN: 'unknown'
}

/**
 * 真实对话失败 → 落库的失败原因。优先用请求层捕获的稳定分类；
 * 没有分类的旧形状再退回渲染层错误码。`not-configured` 是发送前的本地配置
 * 错误（没有发出请求），由调用方跳过，不覆盖上一次真实失败。
 */
export function checkReasonOfChatError(error: ChatError): ProviderCheckError {
  if (error.kind !== undefined) {
    return CHECK_ERROR_OF_KIND[error.kind]
  }
  switch (error.code) {
    case 'invalid-key':
      return 'invalid-key'
    case 'context-too-long':
      return 'invalid-config'
    case 'insufficient-balance':
      return 'quota'
    case 'rate-limited':
      return 'rate-limit'
    case 'server-busy':
      return 'server'
    case 'network':
      return 'network'
    case 'empty-response':
      return 'empty-response'
    case 'not-configured':
      return 'missing-credential'
    case 'unknown':
      return 'unknown'
  }
}
