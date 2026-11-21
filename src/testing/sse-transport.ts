import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 本地 SSE/JSON stub 的传输外壳。
 *
 * 只拥有所有协议都相同的那部分：监听 127.0.0.1 的随机端口、读取并解析请求体、
 * 记录请求与中途断开的连接、关闭服务。协议自己的事件名与 chunk 形状留在各自的
 * `*-sse-stub.ts` 里，绝不把 Anthropic / Gemini / Responses 的形状混进这里。
 */
export type LocalSseRequest = {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

/** responder 拿到解析后的请求；写响应仍由各协议自己负责。 */
export type LocalSseResponder = (
  response: ServerResponse,
  request: { url: string; body: Record<string, unknown> }
) => Promise<void>

export type LocalSseTransport = {
  readonly baseUrl: string
  readonly requests: LocalSseRequest[]
  readonly abortedConnections: number
  close(): Promise<void>
}

export async function startLocalSseTransport(
  respond: LocalSseResponder
): Promise<LocalSseTransport> {
  const requests: LocalSseRequest[] = []
  let abortedConnections = 0

  const server = createServer(async (request, response) => {
    const body = parseJson(await readBody(request))
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers,
      body
    })

    response.on('error', () => undefined)
    response.on('close', () => {
      if (!response.writableEnded) {
        abortedConnections += 1
      }
    })

    try {
      await respond(response, { url: request.url ?? '', body })
    } catch {
      // 客户端中途断开时写入会失败，测试里不算服务端问题。
      response.destroy()
    }
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    get abortedConnections() {
      return abortedConnections
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/** 一个当前没人监听的本地地址，用来制造连接失败（网络异常）。 */
export async function unusedLocalBaseUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${address.port}`
}

export function isWritable(response: ServerResponse): boolean {
  return !response.writableEnded && !response.destroyed
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}
