import type { ProviderCredentialProblem } from './provider-credentials'

/**
 * 对话流在渲染层与主进程之间传递的形状。渲染层只认这套事件，
 * 不认识 SSE、HTTP 状态码或具体服务商。
 */

export type ChatTurn = {
  role: 'user' | 'assistant'
  content: string
}

/**
 * 凭据不可用的原因：直接复用主进程的 `ProviderCredentialProblem`，
 * 渲染层只认这套，不问来源细节。
 */
export type ChatCredentialProblem = ProviderCredentialProblem

/**
 * 思考强度必须显式传给模型服务：不传时服务端会回到“关闭思考”，
 * 界面上的思维链永远不会出现（已实测）。首版固定 high，唯一来源在
 * `src/main/chat/thinking.ts` 的 `DESIRED_THINKING_LEVEL`。
 */

export type ChatErrorCode =
  | 'invalid-key'
  | 'insufficient-balance'
  | 'context-too-long'
  | 'rate-limited'
  | 'server-busy'
  | 'network'
  | 'empty-response'
  | 'not-configured'
  | 'unknown'

/**
 * 稳定的服务端失败分类：请求层在 pi 把异常拍平成字符串之前就从 HTTP 状态与
 * fetch 失败里拿到，后续批次的重试策略只认这些码。渲染层的 `code` 仍按
 * 原样给中文文案，两套码同时存在是为了不让界面文案变成协议。
 */
export type ProviderErrorCode =
  | 'AUTH'
  | 'QUOTA'
  | 'RATE_LIMIT'
  | 'CONTEXT_WINDOW'
  | 'INVALID_REQUEST'
  | 'SERVER'
  | 'TIMEOUT'
  | 'TRANSPORT'
  | 'EMPTY_RESPONSE'
  | 'UNKNOWN'

export type ChatError = {
  code: ChatErrorCode
  /**
   * 发送前就发现凭据不可用时的结构化原因。界面据此点名缺失的环境变量，
   * 或明确说「本机密钥解不开」——不把两种情况混成一句「没配置」。
   */
  credential?: ChatCredentialProblem
  /** 稳定的失败分类；只用于后续重试策略与排障，不直接展示。 */
  kind?: ProviderErrorCode
  /** 服务端返回的 HTTP 状态码；网络异常等没有响应时为空。 */
  status?: number
  /** 供日志与排障使用的服务端报文，不直接展示给学习者。 */
  detail?: string
  requestId?: string
  /** 服务端要求等待多久再试（Retry-After）；自动重试不会早于这个时间。 */
  retryAfterMs?: number
}

export type ChatStreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; error: ChatError }

/** 一次生成的所有事件都带着同一个 streamId，渲染层据此丢弃旧流。 */
export type ChatStreamUpdate = {
  streamId: string
  event: ChatStreamEvent
}

export type ChatStartRequest = {
  threadId: string
  streamId: string
  messages: ChatTurn[]
  /** 这次带上的学习上下文；没有上下文时不传，请求里也就没有 system 消息。 */
  systemPrompt?: string
}

export type ChatStartResult = {
  accepted: boolean
}

export type ChatStopRequest = {
  streamId: string
}

export type ChatStopResult = {
  stopped: boolean
}
