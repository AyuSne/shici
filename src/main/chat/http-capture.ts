import type { ProviderErrorCode } from '../../shared/chat'

/**
 * 请求级 HTTP 观察层。
 *
 * pi-ai 的 SDK 路径会把错误拍平成 `errorMessage` 字符串，HTTP 状态与响应头
 * 经常就此丢失。这里给每次流式请求包一层 fetch：响应一到就先把状态码、
 * request id 与 Retry-After 记在这份闭包里，再把 Response 原样交给 pi；
 * pi 之后无论怎么拍平异常都不影响分类。捕获是请求级的，没有全局可变状态。
 */

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>

/** fetch 层没拿到响应就失败时的分类；用户主动停止不记。 */
export type TransportFailure = 'TIMEOUT' | 'TRANSPORT'

export type CapturedRequest = {
  status?: number
  requestId?: string
  retryAfterMs?: number
  transport?: TransportFailure
}

export type RequestCapture = {
  fetch: FetchLike
  snapshot: () => CapturedRequest
}

export type RequestCaptureOptions = {
  fetchImpl?: FetchLike
  /** 只在把 HTTP 日期换算成毫秒时用；测试可注入固定时间。 */
  now?: () => number
}

const REQUEST_ID_HEADERS = [
  'x-request-id',
  'request-id',
  'x-goog-request-id',
  'anthropic-request-id',
  'x-amzn-requestid'
] as const

export function readRequestId(headers: Headers): string | undefined {
  for (const name of REQUEST_ID_HEADERS) {
    const value = headers.get(name)?.trim()
    if (value) {
      return value
    }
  }
  return undefined
}

/** Retry-After 有秒数与 HTTP 日期两种写法；坏值不假装成等待时间。 */
export function readRetryAfterMs(headers: Headers, now: number): number | undefined {
  const raw = headers.get('retry-after')?.trim()
  if (!raw) {
    return undefined
  }
  if (/^\d+$/.test(raw)) {
    return Number(raw) * 1000
  }
  const at = Date.parse(raw)
  if (Number.isNaN(at)) {
    return undefined
  }
  return Math.max(0, at - now)
}

/** HTTP 状态 → 稳定失败分类；2xx 与未知 3xx 不在这里判失败。 */
export function classifyStatus(status: number | undefined): ProviderErrorCode | null {
  if (status === undefined || (status >= 200 && status < 300)) {
    return null
  }
  if (status === 401 || status === 403) {
    return 'AUTH'
  }
  if (status === 402) {
    return 'QUOTA'
  }
  if (status === 408) {
    return 'TIMEOUT'
  }
  if (status === 413) {
    return 'CONTEXT_WINDOW'
  }
  if (status === 429) {
    return 'RATE_LIMIT'
  }
  if (status >= 500 && status <= 599) {
    return 'SERVER'
  }
  if (status >= 400 && status <= 499) {
    return 'INVALID_REQUEST'
  }
  return 'UNKNOWN'
}

/** fetch 抛出异常 → 超时还是传输失败；不看错误 message 的具体措辞。 */
export function classifyFailure(error: unknown): TransportFailure {
  const name = error instanceof Error ? error.name : ''
  const code = (error as { code?: unknown } | null)?.code
  if (/timeout/i.test(name) || code === 'ETIMEDOUT' || name === 'AbortError') {
    return 'TIMEOUT'
  }
  return 'TRANSPORT'
}

export function createRequestCapture(options: RequestCaptureOptions = {}): RequestCapture {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike)
  const now = options.now ?? Date.now
  let captured: CapturedRequest = {}

  return {
    async fetch(input, init) {
      try {
        const response = await fetchImpl(input, init)
        const requestId = readRequestId(response.headers)
        const retryAfterMs = readRetryAfterMs(response.headers, now())
        captured = {
          status: response.status,
          ...(requestId === undefined ? {} : { requestId }),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs })
        }
        return response
      } catch (error) {
        // 用户按了停止时 abort 不是服务端超时，交给流层按停止处理。
        if (init?.signal?.aborted !== true) {
          captured = { ...captured, transport: classifyFailure(error) }
        }
        throw error
      }
    },
    snapshot() {
      return { ...captured }
    }
  }
}
