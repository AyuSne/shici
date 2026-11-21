import type {
  AssistantMessage,
  Context,
  Provider,
  ProviderAuth,
  SimpleStreamOptions
} from '@earendil-works/pi-ai'
import type { ChatError, ChatStreamEvent, ChatTurn, ProviderErrorCode } from '../../shared/chat'
import { isSupportedAggregateProvider } from '../../shared/model-catalog'
import { chatErrorFromFailure, requestIdFromDetail } from './errors'
import { classifyStatus, createRequestCapture, type CapturedRequest } from './http-capture'
import type { ChatModelDescriptor } from './model-descriptor'
import { runWithNativeRequestCapture } from './native-fetch-capture'
import { loadOpenCodeGoProvider } from './opencode-go'
import { loadPi } from './pi-modules'
import { piModelOf } from './pi-model'
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
 *
 * Gemini 的 SDK 不接受自定义 fetch，改由 `native-fetch-capture` 旁路观察 undici
 * 诊断通道；其余协议仍走请求级 fetch 包装。两条路径共用同一个 capture。
 */
export async function streamChatCompletion(options: StreamChatOptions): Promise<void> {
  const capture = createRequestCapture()
  let hasContent = false
  // Gemini SDK 内部直接调 undici 的全局 fetch，注入 fetch 会被它明确拒绝。
  const nativeFetchProtocol = options.descriptor.api === 'google-generative-ai'
  // SDK 在请求还没到达 undici 时就失败时不会产生诊断事件；这条兜底只在原生
  // 捕获分支生效。其余协议由请求级 fetch 自己记录，不用一个 no-op 参数混过去。
  const recordUnreachableFailure = nativeFetchProtocol
    ? (): void => {
        const captured = capture.snapshot()
        if (captured.status === undefined && captured.transport === undefined) {
          capture.recordFailure(undefined, options.signal)
        }
      }
    : (): void => undefined

  try {
    const pi = await loadPi()
    const model = piModelOf(options.descriptor)
    // 聚合入口直接复用 pi 内置的 Provider 对象：它自带四条协议并按 model.api
    // 分派，地址取模型行。单协议入口仍按原路径构造一套单 API Provider。
    const provider: Provider = isSupportedAggregateProvider(
      options.descriptor.catalogProviderId
    )
      ? await loadOpenCodeGoProvider()
      : pi.createProvider({
          id: options.descriptor.provider,
          name: options.descriptor.provider,
          baseUrl: options.descriptor.baseUrl,
          auth: REQUEST_KEY_AUTH,
          models: [model],
          api: await loadProtocolApi(options.descriptor.api)
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
      ...(nativeFetchProtocol ? {} : { fetch: capture.fetch })
    }
    // 流的创建与完整消费都要在这个闭包里：Gemini 的请求归属靠 AsyncLocalStorage，
    // 只返回迭代器会把创建挪出 scope。
    const consume = async (): Promise<void> => {
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
              // 空回答同样走失败构造器：200 状态、request id 与 Retry-After 都已捕获，
              // 只把稳定分类固定成 EMPTY_RESPONSE，不丢排障信息。
              options.onEvent({
                type: 'error',
                error: failureError(
                  capture.snapshot(),
                  '模型服务返回了空回答',
                  'EMPTY_RESPONSE'
                )
              })
              return
            }
            options.onEvent({ type: 'done' })
            return
          case 'error':
            if (event.reason === 'aborted' || options.signal.aborted) {
              return
            }
            recordUnreachableFailure()
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
      recordUnreachableFailure()
      options.onEvent({
        type: 'error',
        error: failureError(capture.snapshot(), '模型服务在生成结束前断开了连接')
      })
    }

    if (nativeFetchProtocol) {
      await runWithNativeRequestCapture(capture, options.signal, consume)
    } else {
      await consume()
    }
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
 *
 * `kindOverride` 给「没有 HTTP 失败但也不是成功」的空回答用：分类固定成
 * EMPTY_RESPONSE，其余捕获信息照常带出。
 */
function failureError(
  captured: CapturedRequest,
  detail: string,
  kindOverride?: ProviderErrorCode
): ChatError {
  const requestId = captured.requestId ?? requestIdFromDetail(detail)
  const kind = kindOverride ?? failureKind(captured)
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
