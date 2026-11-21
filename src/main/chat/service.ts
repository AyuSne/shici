import type {
  ChatStartRequest,
  ChatStartResult,
  ChatStopResult,
  ChatStreamUpdate,
  ChatCredentialProblem
} from '../../shared/chat'
import { type ChatConfig } from './config'
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

  if (config.missingCredential === true) {
    send({
      streamId: request.streamId,
      event: {
        type: 'error',
        error: {
          code: 'not-configured',
          detail: credentialDetail(config.credentialProblem),
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

/** 给日志与排障用的说明；界面文案另从结构化原因生成。 */
function credentialDetail(problem: ChatCredentialProblem | undefined): string {
  if (problem === undefined) {
    return '本机密钥缺失或解不开'
  }
  switch (problem.kind) {
    case 'stored-decrypt-failed':
      return '本机保存的密钥解不开'
    case 'stored-missing':
      return '这套提供商没有保存密钥'
    case 'env-missing':
      return `环境变量 ${problem.envVar} 没有设置`
    case 'env-var-unset':
      return '环境模式没有填写环境变量名'
  }
}
