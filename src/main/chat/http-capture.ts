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
  /**
   * 原生 fetch 路径（Gemini SDK 不允许注入 fetch）在响应到达后回写状态与头。
   * 与 `fetch` 包装共用同一个分类/request id/Retry-After 读取，不另写一份。
   */
  recordResponse: (status: number, headers: Headers) => void
  /**
   * 原生 fetch 路径在没拿到响应就失败时回写传输失败分类。
   * 用户主动取消不算服务端故障，直接不记。
   */
  recordFailure: (error: unknown, signal?: AbortSignal) => void
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

/** 各运行时把超时放在 `code` 上的写法；message 的文字不作为分类依据。 */
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT'
])

/** cause 链最多看这么多层；正常异常远到不了，坏数据也不会让分类陷进去。 */
const MAX_CAUSE_DEPTH = 10

/**
 * fetch 抛出异常 → 超时还是传输失败；不看错误 message 的具体措辞。
 *
 * 原生 Node/undici 的 fetch 会把连接/响应头/响应体超时码放在 `error.cause`
 * （有时还嵌一层），顶层只有 `TypeError('fetch failed')`。这里沿 cause 链找
 * `name` 与 `code`，并用 visited 集合挡住打转的链。
 */
export function classifyFailure(error: unknown): TransportFailure {
  const visited = new Set<unknown>()
  let current: unknown = error
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null || visited.has(current)) {
      break
    }
    visited.add(current)
    const name = current instanceof Error ? current.name : ''
    const code = (current as { code?: unknown }).code
    if (
      /timeout/i.test(name) ||
      name === 'AbortError' ||
      (typeof code === 'string' && TIMEOUT_CODES.has(code))
    ) {
      return 'TIMEOUT'
    }
    current = (current as { cause?: unknown }).cause
  }
  return 'TRANSPORT'
}

export function createRequestCapture(options: RequestCaptureOptions = {}): RequestCapture {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike)
  const now = options.now ?? Date.now
  let captured: CapturedRequest = {}

  /** 响应头 → 状态、request id、Retry-After；两条 fetch 路径共用这一处。 */
  function recordResponse(status: number, headers: Headers): void {
    const requestId = readRequestId(headers)
    const retryAfterMs = readRetryAfterMs(headers, now())
    captured = {
      status,
      ...(requestId === undefined ? {} : { requestId }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs })
    }
  }

  function recordFailure(error: unknown, signal?: AbortSignal): void {
    // 用户按了停止时 abort 不是服务端超时，交给流层按停止处理。
    if (signal?.aborted === true) {
      return
    }
    captured = { ...captured, transport: classifyFailure(error) }
  }

  return {
    async fetch(input, init) {
      try {
        const response = await fetchImpl(input, init)
        recordResponse(response.status, response.headers)
        return response
      } catch (error) {
        recordFailure(error, init?.signal ?? undefined)
        throw error
      }
    },
    snapshot() {
      return { ...captured }
    },
    recordResponse,
    recordFailure
  }
}
