import { AsyncLocalStorage } from 'node:async_hooks'
import { channel } from 'node:diagnostics_channel'
import type { RequestCapture } from './http-capture'

/**
 * Gemini SDK（`@google/genai`）不接受请求级 `fetch` 注入：它在内部直接调用
 * `undici` 的全局 fetch。为了沿用同一套 HTTP 状态/request id/Retry-After 捕获，
 * 这里改为旁路观察 undici 的诊断通道，不替换 `globalThis.fetch`：
 *
 * - `undici:request:create` 在请求真正建立时回调，此刻 AsyncLocalStorage 里的
 *   scope 可见，把 request 对象与本次请求的 capture 用 WeakMap 绑定；
 * - `undici:request:headers` 带 statusCode 与原始响应头；`undici:request:error`
 *   带传输失败原因。两者都按 request 对象回写同一个 capture，不按 URL 或错误
 *   message 猜测归属，也不会把别的请求算进来。
 *
 * 订阅只在 Gemini scope 存活期间存在（引用计数），最后一个 scope 结束就取消；
 * 回调必须防坏消息且绝不能抛，否则会干扰正常请求。
 */

type ScopeEntry = {
  capture: RequestCapture
  signal?: AbortSignal
}

type UndiciRequest = object

type DiagnosticsMessage = {
  request?: unknown
  response?: { statusCode?: unknown; headers?: unknown }
  error?: unknown
}

const requestScopes = new WeakMap<UndiciRequest, ScopeEntry>()
const scopeStorage = new AsyncLocalStorage<ScopeEntry>()

let activeScopes = 0
let subscribed = false

type ChannelSubscription = {
  name: string
  listener: (message: unknown) => void
}

const subscriptions: ChannelSubscription[] = [
  { name: 'undici:request:create', listener: onRequestCreate },
  { name: 'undici:request:headers', listener: onRequestHeaders },
  { name: 'undici:request:error', listener: onRequestError }
]

function subscribe(): void {
  if (subscribed) {
    return
  }
  subscribed = true
  for (const subscription of subscriptions) {
    channel(subscription.name).subscribe(subscription.listener)
  }
}

function unsubscribe(): void {
  if (!subscribed) {
    return
  }
  subscribed = false
  for (const subscription of subscriptions) {
    channel(subscription.name).unsubscribe(subscription.listener)
  }
}

/**
 * 在独立 scope 里跑完整的一次 Gemini 流：请求的创建与流的消费都必须在这个
 * 闭包内完成，否则 `undici:request:create` 看不到 AsyncLocalStorage 里的 capture。
 */
export async function runWithNativeRequestCapture<T>(
  capture: RequestCapture,
  signal: AbortSignal | undefined,
  work: () => Promise<T>
): Promise<T> {
  activeScopes += 1
  subscribe()
  try {
    return await scopeStorage.run({ capture, signal }, work)
  } finally {
    activeScopes -= 1
    if (activeScopes === 0) {
      unsubscribe()
    }
  }
}

function onRequestCreate(message: unknown): void {
  try {
    const { request } = message as DiagnosticsMessage
    if (typeof request !== 'object' || request === null) {
      return
    }
    const scope = scopeStorage.getStore()
    if (scope !== undefined) {
      requestScopes.set(request, scope)
    }
  } catch {
    // 诊断回调只是旁路观察，坏消息不能影响请求本身。
  }
}

function onRequestHeaders(message: unknown): void {
  try {
    const typed = message as DiagnosticsMessage
    const scope = scopeOf(typed.request)
    if (scope === undefined) {
      return
    }
    const status = typed.response?.statusCode
    if (typeof status !== 'number') {
      return
    }
    scope.capture.recordResponse(status, headersOf(typed.response?.headers))
  } catch {
    // 同上：旁路观察失败不干扰请求。
  }
}

function onRequestError(message: unknown): void {
  try {
    const typed = message as DiagnosticsMessage
    const scope = scopeOf(typed.request)
    scope?.capture.recordFailure(typed.error, scope.signal)
  } catch {
    // 同上。
  }
}

function scopeOf(request: unknown): ScopeEntry | undefined {
  if (typeof request !== 'object' || request === null) {
    return undefined
  }
  return requestScopes.get(request)
}

/**
 * undici 的响应头在实测的 Node 22 与 Electron 内置 Node 24 上是
 * `[name, value, name, value, ...]` 的 Buffer 扁平数组。只接受这个已实测的形状；
 * 解析不出来就当没有头，不为没有调用方的嵌套数组提前买单。
 */
function headersOf(raw: unknown): Headers {
  const headers = new Headers()
  if (!Array.isArray(raw)) {
    return headers
  }
  for (let index = 0; index + 1 < raw.length; index += 2) {
    appendHeader(headers, raw[index], raw[index + 1])
  }
  return headers
}

function appendHeader(headers: Headers, name: unknown, value: unknown): void {
  const headerName = textOf(name)?.trim()
  const headerValue = textOf(value)
  if (!headerName || headerValue === null) {
    return
  }
  try {
    headers.append(headerName, headerValue)
  } catch {
    // 非法头名跳过，不影响其余头。
  }
}

function textOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8')
  }
  return null
}
