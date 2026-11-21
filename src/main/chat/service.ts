import type {
  ChatError,
  ChatStartRequest,
  ChatStartResult,
  ChatStopResult,
  ChatStreamEvent,
  ChatStreamUpdate
} from '../../shared/chat'
import { credentialProblemDetail, type ChatConfig } from './config'
import { streamChatCompletion } from './pi-stream'

export type ChatUpdateSender = (update: ChatStreamUpdate) => void

export type ChatService = {
  start(request: ChatStartRequest, send: ChatUpdateSender): ChatStartResult
  stop(streamId: string): ChatStopResult
  hasActiveThread(threadId: string): boolean
}

export type ChatServiceOptions = {
  /** 每次 start 时重新解析：设置页切换配置只影响之后的调用。 */
  resolveConfig: () => ChatConfig | null
  /**
   * 一次完整成功的调用之后把对应 provider 标成已验证。
   * `providerUpdatedAt` 是调用开始时冻结的配置版本：换地址 / 换密钥 / 换默认
   * 模型后，旧结果不能把新配置误标已验证。
   */
  onVerified?: (providerId: string, providerUpdatedAt: string | undefined) => void
  /**
   * 一次真实调用失败（请求已经发出并失败）之后记录最后错误；不降级已验证。
   * 发送前的本地配置错误（not-configured）不走这里。
   */
  onError?: (
    providerId: string,
    error: ChatError,
    providerUpdatedAt: string | undefined
  ) => void
}

/**
 * 一次生成的生命周期：start 立刻返回，事件经 send 推给调用方；stop 本地中断，
 * 已发出的内容由渲染层保留。同一 streamId 不会被启动两次。
 */
export function createChatService(options: ChatServiceOptions): ChatService {
  const active = new Map<string, { controller: AbortController; threadId: string }>()

  return {
    start(request, send) {
      if (active.has(request.streamId)) {
        return { accepted: false }
      }

      const config = options.resolveConfig()
      const controller = new AbortController()
      active.set(request.streamId, { controller, threadId: request.threadId })
      // 一次流只回写一次终态：done 与 error 都可能被上层补发，不能重复记。
      let reported = false

      const reportOutcome = (event: ChatStreamEvent): void => {
        if (reported || config?.providerId === undefined) {
          return
        }
        if (event.type === 'done') {
          reported = true
          try {
            options.onVerified?.(config.providerId, config.providerUpdatedAt)
          } catch {
            // 回写状态失败不影响这次回答。
          }
          return
        }
        if (event.type !== 'error') {
          return
        }
        // 发送前就报的配置错误没有对应的服务端失败，不覆盖上一次真实错误。
        if (event.error.code === 'not-configured') {
          return
        }
        reported = true
        try {
          options.onError?.(config.providerId, event.error, config.providerUpdatedAt)
        } catch {
          // 回写状态失败不影响这次回答。
        }
      }

      // 窗口可能在生成中途关闭；发事件失败不该把主进程的流带崩。
      const emit: ChatUpdateSender = (update) => {
        try {
          send(update)
        } catch {
          // 接收方已不在。
        }
        reportOutcome(update.event)
      }

      void runStream(request, emit, controller, config)
        .catch(() => {
          if (!controller.signal.aborted) {
            emit({
              streamId: request.streamId,
              event: { type: 'error', error: { code: 'unknown' } }
            })
          }
        })
        .finally(() => {
          active.delete(request.streamId)
        })

      return { accepted: true }
    },

    stop(streamId) {
      const stream = active.get(streamId)
      if (!stream) {
        return { stopped: false }
      }
      stream.controller.abort()
      return { stopped: true }
    },

    hasActiveThread(threadId) {
      return [...active.values()].some((stream) => stream.threadId === threadId)
    }
  }
}

async function runStream(
  request: ChatStartRequest,
  send: ChatUpdateSender,
  controller: AbortController,
  config: ChatConfig | null
): Promise<void> {
  if (!config) {
    send({
      streamId: request.streamId,
      event: { type: 'error', error: { code: 'not-configured' } }
    })
    return
  }

  if (config.missingCredential === true) {
    send({
      streamId: request.streamId,
      event: {
        type: 'error',
        error: {
          code: 'not-configured',
          detail: credentialProblemDetail(config.credentialProblem),
          ...(config.credentialProblem === undefined
            ? {}
            : { credential: config.credentialProblem })
        }
      }
    })
    return
  }

  await streamChatCompletion({
    apiKey: config.apiKey,
    descriptor: config.descriptor,
    messages: request.messages,
    systemPrompt: request.systemPrompt,
    signal: controller.signal,
    onEvent: (event) => send({ streamId: request.streamId, event })
  })
}
