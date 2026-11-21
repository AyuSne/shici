import type { ServerResponse } from 'node:http'
import {
  delay,
  isWritable,
  startLocalSseTransport,
  unusedLocalBaseUrl,
  type LocalSseRequest
} from './sse-transport'

/**
 * 本地 OpenAI Chat Completions SSE stub：单元测试与 E2E 共用一份，形状照抄
 * DeepSeek 的真实 chunk（思维链先、正文后、末尾 finish_reason 与 [DONE]）。
 * 测试不联网。传输外壳在 `sse-transport.ts`；这里只保留本协议的事件形状。
 */
/** 单个响应；`sequence` 里按请求顺序取用，最后一个脚本会被重复使用。 */
export type StubResponse =
  | {
      kind: 'stream'
      thinking?: readonly string[]
      text?: readonly string[]
      /** 第一个 chunk 之前的等待，用来观察等待态。 */
      firstChunkDelayMs?: number
      /** 思维链结束到正文开始之间的等待，用来观察计时。 */
      textDelayMs?: number
      chunkDelayMs?: number
      /** 把每条 SSE 事件拆成两次写入，模拟网络把一行拆开。 */
      fragmentChunks?: boolean
      /** 响应头：E2E 与单测用它验证 request id 只从 header 来。 */
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
      /** 正常结束响应，但没有 finish_reason 与 [DONE]。 */
      kind: 'end-early'
      thinking?: readonly string[]
      text?: readonly string[]
      headers?: Readonly<Record<string, string>>
    }

/**
 * 默认脚本或脚本序列。`sequence` 让同一个本地端点按请求顺序换响应，
 * 用来真实覆盖「失败 N 次后成功」；脚本用完后重复最后一个。
 */
export type StubScript =
  | StubResponse
  | { kind: 'sequence'; scripts: readonly StubResponse[] }

export type StubRequest = LocalSseRequest

export type SseStub = {
  readonly baseUrl: string
  readonly requests: StubRequest[]
  readonly abortedConnections: number
  setScript(script: StubScript): void
  close(): Promise<void>
}

export async function startSseStub(script: StubScript): Promise<SseStub> {
  let current = script
  let sequenceIndex = 0
  const transport = await startLocalSseTransport((response) => {
    const chosen =
      current.kind === 'sequence'
        ? (current.scripts[Math.min(sequenceIndex, current.scripts.length - 1)] ?? {
            kind: 'status' as const,
            status: 500
          })
        : current
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

/**
 * 一个当前没人监听的本地地址，用来制造连接失败（网络异常）。
 */
export function unusedBaseUrl(): Promise<string> {
  return unusedLocalBaseUrl()
}

async function respond(response: ServerResponse, script: StubResponse): Promise<void> {
  if (script.kind === 'status') {
    response.writeHead(script.status, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(script.headers ?? {})
    })
    response.end(
      JSON.stringify({
        error: {
          message: script.message ?? `stub error ${script.status} (request_id: stub-${script.status})`,
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

  const sendChunk = async (delta: Record<string, unknown>): Promise<void> => {
    if (!isWritable(response)) {
      return
    }
    const payload = `data: ${JSON.stringify({
      id: 'stub',
      choices: [{ index: 0, delta, finish_reason: null }]
    })}\n\n`
    if (script.kind === 'stream' && script.fragmentChunks) {
      const cut = Math.floor(payload.length / 2)
      response.write(payload.slice(0, cut))
      await delay(2)
      if (isWritable(response)) {
        response.write(payload.slice(cut))
      }
      return
    }
    response.write(payload)
  }

  const chunkDelay = script.kind === 'stream' ? (script.chunkDelayMs ?? 5) : 5
  const firstDelay = script.kind === 'stream' ? (script.firstChunkDelayMs ?? 0) : 0
  const textDelay = script.kind === 'stream' ? (script.textDelayMs ?? 20) : 0

  await delay(firstDelay)
  for (const piece of script.thinking ?? []) {
    if (!isWritable(response)) return
    await sendChunk({ reasoning_content: piece })
    await delay(chunkDelay)
  }

  await delay(textDelay)
  for (const piece of script.text ?? []) {
    if (!isWritable(response)) return
    await sendChunk({ content: piece })
    await delay(chunkDelay)
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

  if (!isWritable(response)) return
  response.write(
    `data: ${JSON.stringify({
      id: 'stub',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    })}\n\n`
  )
  response.write('data: [DONE]\n\n')
  response.end()
}
