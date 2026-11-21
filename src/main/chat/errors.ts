import type { ChatError, ChatErrorCode, ProviderErrorCode } from '../../shared/chat'
import { classifyStatus } from './http-capture'

/**
 * 稳定分类 → 渲染层现有文案码；过渡期两套码同时存在。
 * HTTP 状态到稳定分类只有请求捕获层那一张表，这里不再复制一份。
 */
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

/**
 * 按 HTTP 状态码分类，不依赖服务端给的 `code`：实测 401 的 code 也是
 * `invalid_request_error`，只信状态码才不会把“换密钥”给成“重试”。
 *
 * 这里保留的是渲染层已经在用的码；新的稳定分类在 `kind` 里，两者同时给。
 * 没有 HTTP 响应（连不上、超时）保留历史的 `network`。
 */
export function classifyChatError(status: number | undefined): ChatErrorCode {
  if (status === undefined) {
    return 'network'
  }
  return RENDERER_CODE[classifyStatus(status) ?? 'UNKNOWN']
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

/**
 * 兼容入口：仍按 HTTP 状态码构造 ChatError，但委托统一的失败构造器，
 * 状态分类与「稳定码 → 渲染层码」都只有一份。
 *
 * 没有 HTTP 状态时保留历史形状（`network`、不附带 kind），因为那表示
 * 请求根本没拿到响应，不是某一类服务端失败。
 */
export function chatErrorFrom(
  status: number | undefined,
  detail?: string,
  requestId?: string
): ChatError {
  const id = requestId ?? requestIdFromDetail(detail)
  if (status === undefined) {
    return {
      code: 'network',
      ...(detail ? { detail } : {}),
      ...(id ? { requestId: id } : {})
    }
  }
  return chatErrorFromFailure({
    kind: classifyStatus(status) ?? 'UNKNOWN',
    status,
    ...(detail ? { detail } : {}),
    ...(id ? { requestId: id } : {})
  })
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
