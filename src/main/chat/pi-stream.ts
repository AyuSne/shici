import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderAuth,
  SimpleStreamOptions
} from '@earendil-works/pi-ai'
import type { ChatError, ChatStreamEvent, ChatTurn, ProviderErrorCode } from '../../shared/chat'
import { chatErrorFromFailure, requestIdFromDetail } from './errors'
import { classifyStatus, createRequestCapture, type CapturedRequest } from './http-capture'
import type { ChatModelDescriptor } from './model-descriptor'
import { loadPi } from './pi-modules'
import { loadProtocolApi } from './protocols'
import { resolveThinkingLevel } from './thinking'

export type StreamChatOptions = {
  /** 这次调用冻结下来的 provider/模型描述符；切换配置不影响已经在跑的流。 */
  descriptor: ChatModelDescriptor
  apiKey: string
  messages: readonly ChatTurn[]
  /** 学习上下文以 system 消息打头；没有上下文时不传。 */
  systemPrompt?: string
  signal: AbortSignal
  onEvent: (event: ChatStreamEvent) => void
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/** `resolve` 只声明“密钥从调用处来”；请求级的 apiKey 优先，不会去环境里找别的凭据。 */
const REQUEST_KEY_AUTH: ProviderAuth = {
  apiKey: {
    name: 'API key',
    resolve: async () => ({ auth: {} })
  }
}

/**
 * 把 pi-ai 的事件归一成 thinking / text / done / error 四种事件。
 * 渲染层不需要知道 pi-ai、SSE、协议或状态码。
 *
 * 协议实现按描述符的 `api` 从注册表懒加载；请求级 fetch 捕获 HTTP 状态、
 * request id 与 Retry-After，pi 之后怎么拍平异常都不影响稳定分类。
 * `maxRetries: 0` 表示一次调用只发一次请求：本批没有重试层，失败交给界面决定。
 */
export async function streamChatCompletion(options: StreamChatOptions): Promise<void> {
  const capture = createRequestCapture()
  let hasContent = false

  try {
    const pi = await loadPi()
    const protocolApi = await loadProtocolApi(options.descriptor.api)
    const model = piModelOf(options.descriptor)
    const provider = pi.createProvider({
      id: options.descriptor.provider,
      name: options.descriptor.provider,
      baseUrl: options.descriptor.baseUrl,
      auth: REQUEST_KEY_AUTH,
      models: [model],
      api: protocolApi
    })
    const models = pi.createModels()
    models.setProvider(provider)

    const reasoning = await resolveThinkingLevel(options.descriptor)
    const requestOptions: SimpleStreamOptions = {
      apiKey: options.apiKey,
      ...(reasoning === undefined ? {} : { reasoning }),
      signal: options.signal,
      // 一次调用一次尝试；重试属于后续批次，绝不在模型层偷偷叠加。
      maxRetries: 0,
      fetch: capture.fetch
    }
    const stream = models.streamSimple(
      model,
      toContext(options.messages, options.descriptor, options.systemPrompt),
      requestOptions
    )

    for await (const event of stream) {
      switch (event.type) {
        case 'thinking_delta':
          if (event.delta !== '') {
            hasContent = true
            options.onEvent({ type: 'thinking', text: event.delta })
          }
          break
        case 'text_delta':
          if (event.delta !== '') {
            hasContent = true
            options.onEvent({ type: 'text', text: event.delta })
          }
          break
        case 'done':
          if (!hasContent) {
            options.onEvent({
              type: 'error',
              error: chatErrorFromFailure({
                kind: 'EMPTY_RESPONSE',
                detail: '模型服务返回了空回答'
              })
            })
            return
          }
          options.onEvent({ type: 'done' })
          return
        case 'error':
          if (event.reason === 'aborted' || options.signal.aborted) {
            return
          }
          options.onEvent({
            type: 'error',
            error: failureError(
              capture.snapshot(),
              event.error.errorMessage ?? '模型服务中断了这次生成'
            )
          })
          return
        default:
          break
      }
    }

    // 没有 done / error 就结束：不假装生成完成，按连接中断处理。
    options.onEvent({
      type: 'error',
      error: failureError(capture.snapshot(), '模型服务在生成结束前断开了连接')
    })
  } catch (error) {
    if (options.signal.aborted) {
      return
    }
    options.onEvent({
      type: 'error',
      error: failureError(capture.snapshot(), describeError(error))
    })
  }
}

function piModelOf(descriptor: ChatModelDescriptor): Model<Api> {
  return {
    id: descriptor.model,
    name: descriptor.model,
    api: descriptor.api,
    provider: descriptor.provider,
    baseUrl: descriptor.baseUrl,
    input: [...descriptor.input],
    cost: ZERO_COST,
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
    reasoning: descriptor.reasoning,
    ...(descriptor.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: descriptor.thinkingLevelMap }),
    ...(descriptor.compat === undefined ? {} : { compat: descriptor.compat })
  } as Model<Api>
}

function toContext(
  messages: readonly ChatTurn[],
  descriptor: ChatModelDescriptor,
  systemPrompt: string | undefined
): Context {
  return {
    ...(systemPrompt ? { systemPrompt } : {}),
    messages: messages.map((turn) =>
      turn.role === 'user'
        ? { role: 'user', content: turn.content, timestamp: Date.now() }
        : assistantMessage(turn.content, descriptor)
    )
  }
}

function assistantMessage(
  text: string,
  descriptor: ChatModelDescriptor
): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: descriptor.api,
    provider: descriptor.provider,
    model: descriptor.model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  }
}

/**
 * 分类优先级：HTTP 状态 > fetch 层超时/传输失败 > 拿到响应后断流按传输失败。
 * 请求还没发出去就失败（例如加载协议实现出错）算未知错误，不误导成“检查网络”。
 * request id 只认响应头；没有头时才从报文的 DeepSeek 括号格式兜底。
 */
function failureError(captured: CapturedRequest, detail: string): ChatError {
  const requestId = captured.requestId ?? requestIdFromDetail(detail)
  const kind = failureKind(captured)
  return chatErrorFromFailure({
    kind,
    ...(captured.status === undefined ? {} : { status: captured.status }),
    detail,
    ...(requestId === undefined ? {} : { requestId }),
    ...(captured.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: captured.retryAfterMs })
  })
}

function failureKind(captured: CapturedRequest): ProviderErrorCode {
  const statusKind = classifyStatus(captured.status)
  if (statusKind !== null) {
    return statusKind
  }
  if (captured.transport !== undefined) {
    return captured.transport
  }
  if (captured.status !== undefined) {
    return 'TRANSPORT'
  }
  return 'UNKNOWN'
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
