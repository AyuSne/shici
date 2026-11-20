import type {
  ChatStartRequest,
  ChatStartResult,
  ChatStopResult,
  ChatStreamUpdate
} from '../../shared/chat'
import { THINKING_EFFORT, type ChatConfig } from './config'
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
  /** 一次完整成功的调用之后把对应 provider 标成已验证。 */
  onVerified?: (providerId: string) => void
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

      // 窗口可能在生成中途关闭；发事件失败不该把主进程的流带崩。
      const emit: ChatUpdateSender = (update) => {
        try {
          send(update)
        } catch {
          // 接收方已不在。
        }
        if (update.event.type === 'done' && config?.providerId !== undefined) {
          try {
            options.onVerified?.(config.providerId)
          } catch {
            // 回写状态失败不影响这次回答。
          }
        }
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

  await streamChatCompletion({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    messages: request.messages,
    systemPrompt: request.systemPrompt,
    reasoningEffort: THINKING_EFFORT,
    signal: controller.signal,
    onEvent: (event) => send({ streamId: request.streamId, event })
  })
}
