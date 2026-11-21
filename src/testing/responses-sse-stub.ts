import type { ServerResponse } from 'node:http'
import {
  delay,
  isWritable,
  scriptAt,
  startLocalSseTransport,
  type LocalSseRequest
} from './sse-transport'

/**
 * 本地 OpenAI Responses SSE stub（#67）。
 *
 * 形状按 Responses 流式契约写：`response.created` → `output_item.added`
 * （reasoning / message）→ `reasoning_summary_text.delta` / `output_text.delta`
 * → `response.completed`。pi 只会在收到对应 `output_item.added` 后接受增量，
 * 所以这里不能复用 Chat Completions 的 chunk 形状。
 *
 * 与 `sse-stub.ts` 分开维护：每种协议都有自己的事件形状。测试与 E2E 共用
 * 本文件，全部请求都落在 127.0.0.1；传输外壳共用 `sse-transport.ts`。
 */
/** 单个响应；`sequence` 里按请求顺序取用，最后一个脚本会被重复使用。 */
export type ResponsesStubResponse =
  | {
      kind: 'stream'
      thinking?: readonly string[]
      text?: readonly string[]
      /** 第一个事件之前的等待，用来观察等待态。 */
      firstChunkDelayMs?: number
      /** 思维链结束到正文开始之间的等待。 */
      textDelayMs?: number
      chunkDelayMs?: number
      /** 响应头：E2E 与单测用它验证 request id 只从 header 来。 */
      headers?: Readonly<Record<string, string>>
      usage?: {
        inputTokens?: number
        outputTokens?: number
        totalTokens?: number
      }
    }
  | {
      kind: 'status'
      status: number
      message?: string
      /** 响应头：request id / Retry-After 等。 */
      headers?: Readonly<Record<string, string>>
    }
  | {
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
      /** 正常结束响应，但没有 response.completed。 */
      kind: 'end-early'
      thinking?: readonly string[]
      text?: readonly string[]
      headers?: Readonly<Record<string, string>>
    }

/** 默认脚本或脚本序列；序列用完后重复最后一个。 */
export type ResponsesStubScript =
  | ResponsesStubResponse
  | { kind: 'sequence'; scripts: readonly ResponsesStubResponse[] }

export type ResponsesStubRequest = LocalSseRequest

export type ResponsesStub = {
  readonly baseUrl: string
  readonly requests: ResponsesStubRequest[]
  readonly abortedConnections: number
  setScript(script: ResponsesStubScript): void
  close(): Promise<void>
}

export async function startResponsesStub(
  script: ResponsesStubScript
): Promise<ResponsesStub> {
  let current = script
  let sequenceIndex = 0
  const transport = await startLocalSseTransport((response) => {
    const chosen = scriptAt(current, sequenceIndex, {
      kind: 'status' as const,
      status: 500
    })
    sequenceIndex += 1
    return respond(response, chosen)
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
  script: ResponsesStubResponse
): Promise<void> {
  if (script.kind === 'status') {
    response.writeHead(script.status, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(script.headers ?? {})
    })
    response.end(
      JSON.stringify({
        error: {
          message:
            script.message ??
            `stub error ${script.status} (request_id: stub-${script.status})`,
          type: 'stub_error',
          code: 'stub_error'
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

  const send = (event: Record<string, unknown>): void => {
    if (!isWritable(response)) {
      return
    }
    response.write(`event: ${String(event.type)}\n`)
    response.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  const thinking = script.thinking ?? []
  const text = script.text ?? []
  const chunkDelay = script.kind === 'stream' ? (script.chunkDelayMs ?? 5) : 5
  const firstDelay = script.kind === 'stream' ? (script.firstChunkDelayMs ?? 0) : 0
  const textDelay = script.kind === 'stream' ? (script.textDelayMs ?? 20) : 0
  const responseId = 'resp_stub'

  await delay(firstDelay)
  send({
    type: 'response.created',
    response: { id: responseId, status: 'in_progress' }
  })

  let outputIndex = 0
  if (thinking.length > 0) {
    send({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { id: 'rs_stub', type: 'reasoning', summary: [] }
    })
    for (const piece of thinking) {
      if (!isWritable(response)) return
      send({
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_stub',
        output_index: outputIndex,
        summary_index: 0,
        delta: piece
      })
      await delay(chunkDelay)
    }
    send({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        id: 'rs_stub',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: thinking.join('') }]
      }
    })
    outputIndex += 1
  }

  await delay(textDelay)
  if (text.length > 0) {
    send({
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        status: 'in_progress',
        content: []
      }
    })
    for (const piece of text) {
      if (!isWritable(response)) return
      send({
        type: 'response.output_text.delta',
        item_id: 'msg_stub',
        output_index: outputIndex,
        content_index: 0,
        delta: piece
      })
      await delay(chunkDelay)
    }
    send({
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          { type: 'output_text', text: text.join(''), annotations: [] }
        ]
      }
    })
  }

  if (script.kind === 'hang') {
    return
  }

  if (script.kind === 'truncate') {
    response.destroy()
    return
  }

  if (script.kind === 'end-early') {
    response.end()
    return
  }

  const usage =
    script.kind === 'stream'
      ? {
          input_tokens: script.usage?.inputTokens ?? 12,
          output_tokens: script.usage?.outputTokens ?? 8,
          total_tokens: script.usage?.totalTokens ?? 20
        }
      : {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20
        }

  send({
    type: 'response.completed',
    response: {
      id: responseId,
      status: 'completed',
      output: [],
      usage
    }
  })
  response.end()
}
