import type { ChatError } from '../../shared/chat'
import type { ProviderCheckError } from '../../shared/model-providers'
import { chatErrorFrom } from '../chat/errors'
import { chatCompletionsEndpoint } from './base-url'

/**
 * 保存密钥前的最小请求。只问「这套地址、模型名和密钥现在能不能用」，
 * 不生成内容；一次 HTTP 往返就够。
 */
export type VerifyOutcome =
  | { status: 'verified' }
  | { status: 'invalid-key'; error: ChatError }
  | { status: 'invalid-config'; error: ChatError }
  | { status: 'unverified'; error: ChatError }

export type VerifyModelProfileInput = {
  baseUrl: string
  model: string
  /** 本地模型可以没有密钥；空字符串时不发 Authorization。 */
  apiKey: string
}

export type VerifyModelProfileOptions = {
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

const DEFAULT_TIMEOUT_MS = 8_000
const PROBE_MESSAGE = 'ping'

export async function verifyModelProfile(
  input: VerifyModelProfileInput,
  options: VerifyModelProfileOptions = {}
): Promise<VerifyOutcome> {
  const endpoint = chatCompletionsEndpoint(input.baseUrl)
  if (endpoint === null) {
    return invalidConfig('接口地址必须是 http(s) 地址')
  }

  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const fetchImpl = options.fetch ?? globalThis.fetch

  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: requestHeaders(input.apiKey),
      body: JSON.stringify({
        model: input.model.trim(),
        messages: [{ role: 'user', content: PROBE_MESSAGE }],
        max_tokens: 1,
        stream: false
      }),
      signal: controller.signal,
      // 不跟着跳转：跳到登录页再回 200 会把错的地址当成功。
      redirect: 'manual'
    })

    return await classifyResponse(response)
  } catch (error) {
    return {
      status: 'unverified',
      error: {
        code: 'network',
        detail: controller.signal.aborted ? '校验请求超时' : describeError(error)
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

function requestHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const trimmed = apiKey.trim()
  if (trimmed !== '') {
    headers.authorization = `Bearer ${trimmed}`
  }
  return headers
}

async function classifyResponse(response: Response): Promise<VerifyOutcome> {
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { status: 'verified' }
  }

  const detail = await readDetail(response)
  const error = chatErrorFrom(response.status, detail)
  const status = response.status

  if (status === 401 || status === 403) {
    return { status: 'invalid-key', error }
  }
  if (status === 402) {
    // 余额不足说明密钥已经被服务端认出来了，密钥本身有效。
    return { status: 'verified' }
  }
  if (status >= 300 && status < 400) {
    return { status: 'invalid-config', error }
  }
  if (status >= 400 && status < 500 && status !== 429) {
    return { status: 'invalid-config', error }
  }
  // 429 与 5xx：服务暂时不给验，密钥对错还不知道。
  return { status: 'unverified', error }
}

async function readDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  const trimmed = text.trim()
  return trimmed === '' ? response.statusText : trimmed.slice(0, 500)
}

function invalidConfig(detail: string): VerifyOutcome {
  return { status: 'invalid-config', error: { code: 'unknown', detail } }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

/** 校验没通过时落到配置状态上的错误类别；通过时不该调用。 */
export function failedCheckError(
  outcome: Exclude<VerifyOutcome, { status: 'verified' }>
): ProviderCheckError {
  if (outcome.status === 'invalid-key') {
    return 'invalid-key'
  }
  if (outcome.status === 'invalid-config') {
    return 'invalid-config'
  }
  return 'network'
}
