import type { ServerResponse } from 'node:http'
import {
  delay,
  isWritable,
  startLocalSseTransport,
  type LocalSseRequest
} from './sse-transport'

/**
 * 本地 Anthropic Messages SSE stub：用它跑真实 pi 请求，不联网。
 *
 * 事件顺序照 Anthropic 官方流协议：`message_start` → `content_block_start`
 * （thinking / text）→ `content_block_delta`（thinking_delta / text_delta）→
 * `content_block_stop` → `message_delta`（必须带 stop_reason，否则 pi 认为
 * 流没有结束原因）→ `message_stop`。请求鉴权是 `x-api-key` 与
 * `anthropic-version: 2023-06-01`；SDK 的 beta messages 路径是
 * `/v1/messages?beta=true`。
 *
 * 与 OpenAI 形状的 `sse-stub.ts` 分开：两种协议的事件名与请求字段不同，
 * 共用一份会把两套形状混在一个类型里。传输外壳共用 `sse-transport.ts`。
 */
/** 单个响应；`sequence` 里按请求顺序取用，最后一个脚本会被重复使用。 */
export type AnthropicStubResponse =
  | {
      kind: 'stream'
      thinking?: readonly string[]
      text?: readonly string[]
      /** 第一个事件之前的等待，用来观察等待态。 */
      firstChunkDelayMs?: number
      /** 思维链结束到正文开始之间的等待，用来观察计时。 */
      textDelayMs?: number
      chunkDelayMs?: number
      /** 默认 end_turn；可换成 max_tokens 等，验证 stop_reason 的映射。 */
      stopReason?: string
      /** 响应头：request id / Retry-After 等。 */
      headers?: Readonly<Record<string, string>>
    }
  | {
      kind: 'status'
      status: number
      message?: string
      /** 响应头：request id / Retry-After 等。 */
      headers?: Readonly<Record<string, string>>
    }
  | {
      /** 已经发出 200 与部分内容，然后一直不结束，用来验证停止。 */
      kind: 'hang'
      thinking?: readonly string[]
      text?: readonly string[]
      headers?: Readonly<Record<string, string>>
    }
  | {
      /** 已经发出 200 与部分内容，然后直接断开，模拟中途断网。 */
      kind: 'truncate'
      thinking?: readonly string[]
      text?: readonly string[]
      headers?: Readonly<Record<string, string>>
    }
  | {
      /** 正常结束响应，但没有 message_delta / message_stop。 */
      kind: 'end-early'
      thinking?: readonly string[]
      text?: readonly string[]
      headers?: Readonly<Record<string, string>>
    }

/** 默认脚本或脚本序列；序列用完后重复最后一个。 */
export type AnthropicStubScript =
  | AnthropicStubResponse
  | { kind: 'sequence'; scripts: readonly AnthropicStubResponse[] }

export type AnthropicStubRequest = LocalSseRequest

export type AnthropicStub = {
  readonly baseUrl: string
  readonly requests: AnthropicStubRequest[]
  readonly abortedConnections: number
  setScript(script: AnthropicStubScript): void
  close(): Promise<void>
}

const STUB_MESSAGE_ID = 'msg_anthropic_stub'

export async function startAnthropicStub(
  script: AnthropicStubScript
): Promise<AnthropicStub> {
  let current = script
  let sequenceIndex = 0
  const transport = await startLocalSseTransport((response, request) => {
    const chosen =
      current.kind === 'sequence'
        ? (current.scripts[Math.min(sequenceIndex, current.scripts.length - 1)] ?? {
            kind: 'status' as const,
            status: 500
          })
        : current
    sequenceIndex += 1
    return respond(response, chosen, request.body)
  })

  return {
    baseUrl: transport.baseUrl,
    requests: transport.requests,
    get abortedConnections() {
      return transport.abortedConnections
    },
    setScript(next) {
      current = next
      sequenceIndex = 0
    },
    close() {
      return transport.close()
    }
  }
}

async function respond(
  response: ServerResponse,
  script: AnthropicStubResponse,
  body: Record<string, unknown>
): Promise<void> {
  if (script.kind === 'status') {
    response.writeHead(script.status, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(script.headers ?? {})
    })
    response.end(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'stub_error',
          message:
            script.message ??
            `stub error ${script.status} (request-id: stub-${script.status})`
        }
      })
    )
    return
  }

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...(script.headers ?? {})
  })

  const sse = (type: string, payload: Record<string, unknown>): void => {
    if (!isWritable(response)) {
      return
    }
    response.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
  }

  const chunkDelay = script.kind === 'stream' ? (script.chunkDelayMs ?? 5) : 5
  const firstDelay = script.kind === 'stream' ? (script.firstChunkDelayMs ?? 0) : 0
  const textDelay = script.kind === 'stream' ? (script.textDelayMs ?? 20) : 0
  const model = typeof body.model === 'string' ? body.model : 'stub-anthropic-model'

  await delay(firstDelay)
  sse('message_start', {
    type: 'message_start',
    message: {
      id: STUB_MESSAGE_ID,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 0 }
    }
  })

  let nextIndex = 0
  const thinking = script.thinking ?? []
  if (thinking.length > 0) {
    const thinkingIndex = nextIndex
    nextIndex += 1
    sse('content_block_start', {
      type: 'content_block_start',
      index: thinkingIndex,
      content_block: { type: 'thinking', thinking: '', signature: '' }
    })
    for (const piece of thinking) {
      await delay(chunkDelay)
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: thinkingIndex,
        delta: { type: 'thinking_delta', thinking: piece }
      })
    }
    sse('content_block_stop', {
      type: 'content_block_stop',
      index: thinkingIndex
    })
  }

  await delay(textDelay)
  const text = script.text ?? []
  if (text.length > 0) {
    const textIndex = nextIndex
    sse('content_block_start', {
      type: 'content_block_start',
      index: textIndex,
      content_block: { type: 'text', text: '' }
    })
    for (const piece of text) {
      await delay(chunkDelay)
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: piece }
      })
    }
    sse('content_block_stop', {
      type: 'content_block_stop',
      index: textIndex
    })
  }

  if (script.kind === 'hang') {
    return
  }
  if (script.kind === 'truncate') {
    // 先让已写出的 content_block_stop 有机会抵达客户端，再模拟断线；
    // 否则同 tick 的 socket 关闭可能把最后一段正文一起吞掉。
    await delay(10)
    response.destroy()
    return
  }
  if (script.kind === 'end-early') {
    response.end()
    return
  }

  // pi 要求 message_delta 给出 stop_reason，否则整条流按“没有结束原因”报错。
  sse('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: script.stopReason ?? 'end_turn', stop_sequence: null },
    usage: { output_tokens: 24 }
  })
  sse('message_stop', { type: 'message_stop' })
  response.end()
}
