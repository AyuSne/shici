import type { ServerResponse } from 'node:http'
import {
  delay,
  isWritable,
  scriptAt,
  startLocalSseTransport,
  type LocalSseRequest
} from './sse-transport'

/**
 * 本地 Gemini SSE stub：形状照抄 Gemini API 的 `streamGenerateContent?alt=sse`
 * 真实返回——`candidates[].content.parts[]` 里 `thought: true` 的是思维链，
 * 其余 `text` 是正文，最后一个 chunk 带 `finishReason` 与 `usageMetadata`。
 *
 * 测试只连 127.0.0.1，不联网、不用真实密钥；与 OpenAI 兼容的 sse-stub 分开，
 * 避免把两种协议的 chunk 形状混在一个夹具里。传输外壳共用 `sse-transport.ts`。
 */
export type GeminiStubResponse =
  | {
      kind: 'stream'
      thinking?: readonly string[]
      text?: readonly string[]
      /** 第一个 chunk 之前的等待，用来观察等待态。 */
      firstChunkDelayMs?: number
      /** 思维链结束到正文开始之间的等待。 */
      textDelayMs?: number
      chunkDelayMs?: number
      /** 把每条 SSE 事件拆成两次写入，模拟网络把一行拆开。 */
      fragmentChunks?: boolean
      /** 响应头：request id / Retry-After 等。 */
      headers?: Readonly<Record<string, string>>
    }
  | {
      kind: 'status'
      status: number
      message?: string
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
      /** 正常结束响应，但没有 finishReason（Gemini 的生成结束标记）。 */
      kind: 'end-early'
      thinking?: readonly string[]
      text?: readonly string[]
      headers?: Readonly<Record<string, string>>
    }

export type GeminiStubScript =
  | GeminiStubResponse
  | {
      /** 同一个 baseUrl 上按 URL 里的模型 ID 返回不同响应，供并发用例确定性区分。 */
      kind: 'per-model'
      scripts: Readonly<Record<string, GeminiStubResponse>>
    }
  | {
      /** 按请求顺序换响应，覆盖「失败 N 次后成功」；用完后重复最后一个。 */
      kind: 'sequence'
      scripts: readonly GeminiStubResponse[]
    }

export type GeminiStubRequest = LocalSseRequest

export type GeminiSseStub = {
  readonly baseUrl: string
  readonly requests: GeminiStubRequest[]
  readonly abortedConnections: number
  setScript(script: GeminiStubScript): void
  close(): Promise<void>
}

export async function startGeminiSseStub(
  initialScript: GeminiStubScript
): Promise<GeminiSseStub> {
  let script = initialScript
  let sequenceIndex = 0
  const transport = await startLocalSseTransport((response, request) => {
    const selected = responseFor(script, request.url, sequenceIndex)
    sequenceIndex += 1
    return respond(response, selected)
  })

  return {
    baseUrl: transport.baseUrl,
    requests: transport.requests,
    get abortedConnections() {
      return transport.abortedConnections
    },
    setScript(next) {
      script = next
      sequenceIndex = 0
    },
    close() {
      return transport.close()
    }
  }
}

/** 同一个端口上按请求序号/模型 ID 选脚本；找不到就明确 404，避免测试静默连错。 */
function responseFor(
  script: GeminiStubScript,
  url: string,
  sequenceIndex: number
): GeminiStubResponse {
  if (script.kind === 'per-model') {
    const model = /\/models\/([^:?]+)/.exec(url)?.[1]
    const chosen = model === undefined ? undefined : script.scripts[model]
    return (
      chosen ?? {
        kind: 'status',
        status: 404,
        message: `stub has no script for ${url}`
      }
    )
  }
  // 单脚本或 sequence：与其余三个协议共用同一套「用完重复最后一个」规则。
  return scriptAt(script, sequenceIndex, {
    kind: 'status',
    status: 500,
    message: `stub has no script for ${url}`
  })
}

async function respond(
  response: ServerResponse,
  script: GeminiStubResponse
): Promise<void> {
  if (script.kind === 'status') {
    response.writeHead(script.status, {
      'Content-Type': 'application/json; charset=utf-8',
      ...(script.headers ?? {})
    })
    response.end(
      JSON.stringify({
        error: {
          code: script.status,
          message: script.message ?? `stub error ${script.status}`,
          status: 'STUB_ERROR'
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

  const sendFrame = async (frame: Record<string, unknown>): Promise<void> => {
    if (!isWritable(response)) {
      return
    }
    const payload = `data: ${JSON.stringify(frame)}\n\n`
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
    await sendFrame(partFrame({ text: piece, thought: true }))
    await delay(chunkDelay)
  }

  await delay(textDelay)
  for (const piece of script.text ?? []) {
    if (!isWritable(response)) return
    await sendFrame(partFrame({ text: piece }))
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
  // 真实 Gemini 流在最后一个 chunk 给 finishReason；没有 [DONE] 标记。
  response.write(
    `data: ${JSON.stringify({
      candidates: [{ finishReason: 'STOP', index: 0 }],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        thoughtsTokenCount: 1,
        totalTokenCount: 6
      }
    })}\n\n`
  )
  response.end()
}

function partFrame(part: Record<string, unknown>): Record<string, unknown> {
  return {
    candidates: [{ content: { role: 'model', parts: [part] }, index: 0 }]
  }
}
