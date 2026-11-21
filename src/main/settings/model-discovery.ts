import {
  findModelProvider,
  type CatalogModel
} from '../../shared/model-catalog'
import {
  MODEL_DISCOVERY_MAX_BYTES,
  MODEL_DISCOVERY_TIMEOUT_MS,
  type FetchedModelCandidate,
  type FetchProviderModelsFailure,
  type FetchProviderModelsRequest,
  type FetchProviderModelsResult,
  type ModelDiscoveryCredentialProblem,
  type ModelDiscoveryFailureReason
} from '../../shared/model-discovery'
import type { ProviderProtocol } from '../../shared/model-providers'
import { isModelProtocol } from '../../shared/model-protocols'
import { classifyFailure, type FetchLike } from '../chat/http-capture'
import type { AppDatabase } from '../db/database'
import { parseHttpUrl } from './base-url'
import { resolveProviderCredential } from './credentials'
import { readModelProvider } from './providers'
import type { SecretStore } from './secret-store'

/**
 * 「获取可用模型」的主进程实现。
 *
 * 只读：不写 provider / 模型行 / 设置，失败也不会改任何已有配置。内置目录身份
 * 永远直接返回本地目录（零 HTTP，含 OpenCode GO）；自定义 API 才按请求里当前
 * 未保存的地址、协议与密钥来源问一次服务商。
 *
 * 凭据规则与聊天一致：环境模式只读当前环境变量名、忽略请求里的密钥；本机模式
 * 新密钥优先，只有明确编辑同一套自定义 provider 时才复用它已存的密文，解不开
 * 就明确报错，绝不改读环境变量。响应正文只用于解析模型列表，不进入用户报错。
 */

export type ModelDiscoveryOptions = {
  /** 测试注入较短超时；生产用默认值。 */
  timeoutMs?: number
  /** 测试可注入；生产用全局 fetch。 */
  fetchImpl?: FetchLike
}

export async function fetchProviderModels(
  database: AppDatabase,
  secrets: SecretStore,
  env: NodeJS.ProcessEnv,
  request: FetchProviderModelsRequest,
  options: ModelDiscoveryOptions = {}
): Promise<FetchProviderModelsResult> {
  if (request.source === 'builtin') {
    return fetchBuiltinCatalog(request)
  }

  if (!isModelProtocol(request.protocol)) {
    return rejected('unsupported-protocol')
  }
  const endpoint = modelsListEndpoint(request.protocol, request.baseUrl)
  if (endpoint === null) {
    return rejected('invalid-base-url')
  }

  const credential = resolveDiscoveryCredential(database, secrets, env, request)
  if (!credential.ok) {
    return credential.failure
  }

  return requestModels(endpoint, request.protocol, credential.apiKey, request, options)
}

/** 内置身份只查打包进产物的目录；地址、密钥、协议都不参与，绝不联网。 */
function fetchBuiltinCatalog(
  request: FetchProviderModelsRequest
): FetchProviderModelsResult {
  const catalogProviderId = request.catalogProviderId?.trim() ?? ''
  if (catalogProviderId === '') {
    return rejected('unknown-catalog')
  }
  const provider = findModelProvider(catalogProviderId)
  if (provider === undefined) {
    return rejected('unknown-catalog')
  }
  const known = knownModelIdsOf(request)
  const seen = new Set<string>()
  const candidates: FetchedModelCandidate[] = []
  for (const model of provider.models) {
    const candidate = catalogCandidate(model)
    if (seen.has(candidate.modelId) || known.has(candidate.modelId)) {
      continue
    }
    seen.add(candidate.modelId)
    candidates.push(candidate)
  }
  return { status: 'fetched', candidates }
}

function catalogCandidate(model: CatalogModel): FetchedModelCandidate {
  return {
    modelId: model.id,
    displayName: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    origin: 'catalog'
  }
}

type ResolvedDiscoveryCredential =
  | { ok: true; apiKey: string }
  | { ok: false; failure: FetchProviderModelsResult }

/**
 * 表单当前凭据 → 这次请求能用的密钥。
 *
 * 环境模式只看请求里的 envVar；本机模式先看请求里的新密钥，再看明确指定的同一套
 * 自定义 provider 的已存密文。内置 provider / 其它 provider 的密钥一律不借用。
 */
function resolveDiscoveryCredential(
  database: AppDatabase,
  secrets: SecretStore,
  env: NodeJS.ProcessEnv,
  request: FetchProviderModelsRequest
): ResolvedDiscoveryCredential {
  if (request.authMode === 'env') {
    const envVar = request.envVar?.trim() ?? ''
    if (envVar === '') {
      return credentialFailure('missing-credential', 'env-var-unset')
    }
    const value = env[envVar]?.trim() ?? ''
    if (value === '') {
      return credentialFailure('missing-credential', 'env-missing', envVar)
    }
    return { ok: true, apiKey: value }
  }

  const newKey = request.apiKey?.trim() ?? ''
  if (newKey !== '') {
    return { ok: true, apiKey: newKey }
  }

  const providerId = request.providerId?.trim() ?? ''
  if (providerId === '') {
    // 新建的未保存自定义 API：保持「本地 / 自部署可以没有密钥」的既有行为，
    // 但不能从任何已有 provider 借密钥。
    return { ok: true, apiKey: '' }
  }

  const provider = readModelProvider(database, providerId)
  if (provider === null) {
    return { ok: false, failure: rejected('unknown-provider') }
  }
  if (provider.source !== 'custom') {
    // 明确在编辑自定义 API，却把内置 provider 的 id 传进来：不跨 provider 借密钥。
    return { ok: false, failure: rejected('provider-mismatch') }
  }
  if (request.protocol !== null && provider.protocol !== null) {
    // 同一套自定义 provider 的协议创建后不可改；不一致说明请求和行不是同一套。
    if (request.protocol !== provider.protocol) {
      return { ok: false, failure: rejected('provider-mismatch') }
    }
  }
  if (provider.authMode === 'env') {
    // 这套现在用环境变量；用户在本机模式下没填新密钥，不能把旧密文当有效密钥。
    return credentialFailure('missing-credential', 'stored-missing')
  }
  if (provider.secretCiphertext === null) {
    // 这套本来就是无密钥的本地端点：与聊天保持同样的无密钥行为。
    return { ok: true, apiKey: '' }
  }
  const resolved = resolveProviderCredential(provider, { secrets, env })
  if (resolved.state === 'missing') {
    return credentialFailure('credential-error', resolved.problem.kind)
  }
  return { ok: true, apiKey: resolved.apiKey }
}

function credentialFailure(
  reason: 'missing-credential' | 'credential-error',
  problem: ModelDiscoveryCredentialProblem,
  envVar?: string
): ResolvedDiscoveryCredential {
  return {
    ok: false,
    failure: rejected(reason, {
      problem,
      ...(envVar === undefined ? {} : { envVar })
    })
  }
}

/**
 * 各协议的模型列表地址；与聊天路径共用同一套 URL 解析，保留用户写的路径前缀。
 *
 * - OpenAI Chat Completions / Responses：`{base}/models`
 * - Anthropic：`{root}/v1/models?limit=1000`（已带 /v1 时不重复）
 * - Gemini：`{base}/models?pageSize=1000`
 */
export function modelsListEndpoint(
  protocol: ProviderProtocol,
  baseUrl: string
): string | null {
  const url = parseHttpUrl(baseUrl)
  if (url === null) {
    return null
  }

  let path = url.pathname.replace(/\/+$/, '')
  if (!/\/models$/.test(path)) {
    if (protocol === 'anthropic-messages') {
      path = /\/v1$/.test(path) ? `${path}/models` : `${path}/v1/models`
    } else {
      path = `${path}/models`
    }
  }
  url.pathname = path === '' ? '/models' : path
  url.hash = ''

  if (protocol === 'anthropic-messages') {
    url.search = 'limit=1000'
  } else if (protocol === 'google-generative-ai') {
    url.search = 'pageSize=1000'
  } else {
    url.search = ''
  }
  return url.toString()
}

async function requestModels(
  endpoint: string,
  protocol: ProviderProtocol,
  apiKey: string,
  request: FetchProviderModelsRequest,
  options: ModelDiscoveryOptions
): Promise<FetchProviderModelsResult> {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? MODEL_DISCOVERY_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike)

  try {
    let response: Response
    try {
      response = await fetchImpl(endpoint, {
        method: 'GET',
        headers: discoveryHeaders(protocol, apiKey),
        signal: controller.signal,
        // 不自动跟随跳转：跨来源重定向不转发密钥，也避免把登录页当模型列表。
        redirect: 'manual'
      })
    } catch (error) {
      return transportFailure(error, controller.signal.aborted)
    }

    if (!response.ok) {
      await cancelBody(response)
      return rejected('http-error', { httpStatus: response.status })
    }

    const declared = readDeclaredLength(response)
    if (declared !== null && declared > MODEL_DISCOVERY_MAX_BYTES) {
      // 头部已经说超了：不必再读正文；实际字节数仍在流式读取时复核。
      await cancelBody(response)
      return rejected('too-large')
    }

    const body = await readBoundedBody(response, controller)
    if (body.status !== 'ok') {
      return body.failure
    }

    const parsed = parseModelList(protocol, body.text)
    if (parsed === null) {
      return rejected('invalid-format')
    }

    const known = knownModelIdsOf(request)
    const seen = new Set<string>()
    const candidates: FetchedModelCandidate[] = []
    for (const model of parsed) {
      if (seen.has(model.modelId) || known.has(model.modelId)) {
        continue
      }
      seen.add(model.modelId)
      candidates.push({ ...model, origin: 'remote' })
    }
    return { status: 'fetched', candidates }
  } finally {
    clearTimeout(timer)
  }
}

function discoveryHeaders(
  protocol: ProviderProtocol,
  apiKey: string
): Record<string, string> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const key = apiKey.trim()
  if (protocol === 'anthropic-messages') {
    // Anthropic 要求显式版本头，与密钥是否存在无关。
    headers['anthropic-version'] = '2023-06-01'
    if (key !== '') {
      headers['x-api-key'] = key
    }
    return headers
  }
  if (key === '') {
    return headers
  }
  if (protocol === 'google-generative-ai') {
    headers['x-goog-api-key'] = key
  } else {
    headers.authorization = `Bearer ${key}`
  }
  return headers
}

function readDeclaredLength(response: Response): number | null {
  const raw = response.headers.get('content-length')
  if (raw === null) {
    return null
  }
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    return null
  }
  const value = Number(trimmed)
  return Number.isSafeInteger(value) ? value : null
}

type BoundedBody =
  | { status: 'ok'; text: string }
  | { status: 'failed'; failure: FetchProviderModelsFailure }

async function readBoundedBody(
  response: Response,
  controller: AbortController
): Promise<BoundedBody> {
  const body = response.body
  if (body === null) {
    return { status: 'failed', failure: rejected('invalid-format') }
  }
  const reader = body.getReader()
  let total = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value === undefined) {
        continue
      }
      total += value.byteLength
      if (total > MODEL_DISCOVERY_MAX_BYTES) {
        await reader.cancel().catch(() => undefined)
        return { status: 'failed', failure: rejected('too-large') }
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    return transportBodyFailure(error, controller.signal.aborted)
  }

  if (chunks.length === 0) {
    return { status: 'failed', failure: rejected('invalid-format') }
  }
  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))
  ).toString('utf8')
  return { status: 'ok', text }
}

function transportBodyFailure(error: unknown, aborted: boolean): BoundedBody {
  if (aborted || classifyFailure(error) === 'TIMEOUT') {
    return { status: 'failed', failure: rejected('timeout') }
  }
  return { status: 'failed', failure: rejected('transport') }
}

function transportFailure(error: unknown, aborted: boolean): FetchProviderModelsResult {
  if (aborted || classifyFailure(error) === 'TIMEOUT') {
    return rejected('timeout')
  }
  return rejected('transport')
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

function knownModelIdsOf(request: FetchProviderModelsRequest): Set<string> {
  const known = new Set<string>()
  for (const value of request.knownModelIds ?? []) {
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed !== '') {
      known.add(trimmed)
    }
  }
  return known
}

type ParsedModel = Omit<FetchedModelCandidate, 'origin'>

/**
 * 按协议解析候选。结构不对返回 null（明确「格式无法识别」）；单条坏数据
 * 跳过而不是让整页崩掉，容量缺失保留 null。
 */
export function parseModelList(
  protocol: ProviderProtocol,
  raw: string
): ParsedModel[] | null {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(payload)) {
    return null
  }

  if (protocol === 'google-generative-ai') {
    const models = payload.models
    if (!Array.isArray(models)) {
      return null
    }
    const parsed: ParsedModel[] = []
    for (const item of models) {
      if (!isRecord(item) || typeof item.name !== 'string') {
        continue
      }
      const id = modelIdOf(item.name)
      if (id === '') {
        continue
      }
      if (!hasGenerationMethod(item.supportedGenerationMethods)) {
        continue
      }
      parsed.push({
        modelId: id,
        displayName: firstString(item.displayName) ?? id,
        contextWindow: firstNumber(item.inputTokenLimit),
        maxTokens: firstNumber(item.outputTokenLimit),
        reasoning: item.thinking === true
      })
    }
    return parsed
  }

  const items = Array.isArray(payload.data)
    ? payload.data
    : Array.isArray(payload.models)
      ? payload.models
      : null
  if (items === null) {
    return null
  }

  const parsed: ParsedModel[] = []
  for (const item of items) {
    if (typeof item === 'string') {
      const id = item.trim()
      if (id !== '') {
        parsed.push({
          modelId: id,
          displayName: id,
          contextWindow: null,
          maxTokens: null,
          reasoning: false
        })
      }
      continue
    }
    if (!isRecord(item) || typeof item.id !== 'string') {
      continue
    }
    const id = item.id.trim()
    if (id === '') {
      continue
    }
    parsed.push({
      modelId: id,
      displayName: firstString(item.display_name, item.name) ?? id,
      contextWindow: firstNumber(
        item.context_length,
        item.context_window,
        item.input_token_limit,
        item.inputTokenLimit
      ),
      maxTokens: firstNumber(
        item.max_tokens,
        item.max_output_tokens,
        item.output_token_limit,
        item.outputTokenLimit
      ),
      reasoning: item.reasoning === true || item.supports_reasoning === true
    })
  }
  return parsed
}

function hasGenerationMethod(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false
  }
  return value.some(
    (method) => method === 'generateContent' || method === 'streamGenerateContent'
  )
}

/** Gemini 的 name 形如 `models/gemini-2.5-pro`；请求里发送时不带前缀。 */
function modelIdOf(name: string): string {
  const trimmed = name.trim()
  return trimmed.startsWith('models/') ? trimmed.slice('models/'.length) : trimmed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim()
    }
  }
  return null
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value
    }
  }
  return null
}

function rejected(
  reason: ModelDiscoveryFailureReason,
  extra: Omit<FetchProviderModelsFailure, 'status' | 'reason'> = {}
): FetchProviderModelsFailure {
  return { status: 'rejected', reason, ...extra }
}
