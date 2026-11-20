import type { ChatError, ChatErrorCode, ProviderErrorCode } from '../../shared/chat'
import { classifyStatus } from './http-capture'

/**
 * 按 HTTP 状态码分类，不依赖服务端给的 `code`：实测 401 的 code 也是
 * `invalid_request_error`，只信状态码才不会把“换密钥”给成“重试”。
 *
 * 这里保留的是渲染层已经在用的码；新的稳定分类在 `kind` 里，两者同时给。
 */
export function classifyChatError(status: number | undefined): ChatErrorCode {
  if (status === undefined) {
    return 'network'
  }
  if (status === 401 || status === 403) {
    return 'invalid-key'
  }
  if (status === 402) {
    return 'insufficient-balance'
  }
  if (status === 413) {
    return 'context-too-long'
  }
  if (status === 429) {
    return 'rate-limited'
  }
  if (status >= 500 && status <= 599) {
    return 'server-busy'
  }
  return 'unknown'
}

/** 稳定分类 → 渲染层现有文案码；过渡期两套码同时存在。 */
const RENDERER_CODE: Record<ProviderErrorCode, ChatErrorCode> = {
  AUTH: 'invalid-key',
  QUOTA: 'insufficient-balance',
  RATE_LIMIT: 'rate-limited',
  CONTEXT_WINDOW: 'context-too-long',
  SERVER: 'server-busy',
  TIMEOUT: 'network',
  TRANSPORT: 'network',
  EMPTY_RESPONSE: 'empty-response',
  INVALID_REQUEST: 'unknown',
  UNKNOWN: 'unknown'
}

export type ChatFailure = {
  kind?: ProviderErrorCode
  status?: number
  detail?: string
  requestId?: string
  retryAfterMs?: number
}

/**
 * 请求层拿到稳定分类之后统一构造渲染层错误。
 * 状态码只作为排障信息附带，分类本身来自 HTTP 状态/fetch 失败捕获，不看 message。
 */
export function chatErrorFromFailure(failure: ChatFailure): ChatError {
  const kind = failure.kind ?? 'UNKNOWN'
  return {
    code: RENDERER_CODE[kind],
    kind,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.detail ? { detail: failure.detail } : {}),
    ...(failure.requestId ? { requestId: failure.requestId } : {}),
    ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs })
  }
}

export function chatErrorFrom(
  status: number | undefined,
  detail?: string,
  requestId?: string
): ChatError {
  const id = requestId ?? requestIdFromDetail(detail)
  const kind = classifyStatus(status)
  return {
    code: classifyChatError(status),
    ...(kind === null ? {} : { kind }),
    ...(status !== undefined ? { status } : {}),
    ...(detail ? { detail } : {}),
    ...(id ? { requestId: id } : {})
  }
}

/**
 * DeepSeek 把 request_id 放在错误 message 的括号里，例如
 * `Authentication Fails (request_id: 123)`。响应头里没有独立字段时从报文兜底；
 * HTTP 头里的 request id 永远优先，由请求捕获层传进来。
 */
export function requestIdFromDetail(detail: string | undefined): string | undefined {
  if (!detail) {
    return undefined
  }
  const matched = /\(request_id:\s*([^)]+)\)/.exec(detail)
  return matched?.[1].trim() || undefined
}
