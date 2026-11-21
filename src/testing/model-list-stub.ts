import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * 本地 HTTP stub：给「获取可用模型」的单元测试与 E2E 用。
 *
 * 只回模型列表这类 GET JSON，不联网；请求记录里保留 method / url / headers，
 * 测试据此断言路径、query 与各协议鉴权头。响应可以按 Content-Length 或 chunked
 * 发送、延迟响应头或正文、在正文中途挂起/断开，用来覆盖 4 MiB 与超时边界。
 */
export type ModelListScript = {
  /** HTTP 状态码；默认 200。 */
  status?: number
  /** 正文；默认空字符串。 */
  body?: string | Buffer
  headers?: Readonly<Record<string, string>>
  /** 响应头之前的等待，模拟服务端迟迟不回应。 */
  headersDelayMs?: number
  /** 响应头之后、正文之前的等待。 */
  bodyDelayMs?: number
  /**
   * 显式 Content-Length：number 原样发送，null 表示不发送（chunked/close 边界）；
   * 不传时按实际 body 长度发送。
   */
  contentLength?: number | null
  /** 正文分块写入的字节数；不传一次写完。 */
  chunkSize?: number
  /** 写完这么多字节后不再发送也不结束，模拟正文挂起。 */
  hangAfterBytes?: number
  /** 写完这么多字节后直接断开，模拟传输中断。 */
  truncateAfterBytes?: number
}

export type ModelListRequest = {
  method: string
  url: string
  headers: IncomingMessage['headers']
}

export type ModelListStub = {
  readonly baseUrl: string
  readonly requests: ModelListRequest[]
  readonly abortedConnections: number
  setScript(script: ModelListScript): void
  close(): Promise<void>
}

export async function startModelListStub(script: ModelListScript): Promise<ModelListStub> {
  let current = script
  const requests: ModelListRequest[] = []
  let abortedConnections = 0

  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      headers: request.headers
    })
    request.resume()

    response.on('error', () => undefined)
    response.on('close', () => {
      if (!response.writableEnded) {
        abortedConnections += 1
      }
    })

    void respond(response, current).catch(() => {
      response.destroy()
    })
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
    setScript(next) {
      current = next
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

async function respond(response: ServerResponse, script: ModelListScript): Promise<void> {
  const body = Buffer.isBuffer(script.body)
    ? script.body
    : Buffer.from(script.body ?? '', 'utf8')

  await delay(script.headersDelayMs ?? 0)
  if (!isWritable(response)) {
    return
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    ...(script.headers ?? {})
  }
  if (script.contentLength !== null) {
    headers['content-length'] = String(script.contentLength ?? body.length)
  }
  response.writeHead(script.status ?? 200, headers)
  // 先把头刷出去：没写 Content-Length 时后续写入就是 chunked，正好覆盖边界。
  response.flushHeaders()

  await delay(script.bodyDelayMs ?? 0)
  if (!isWritable(response)) {
    return
  }

  if (script.hangAfterBytes !== undefined) {
    await writeAtMost(response, body, script.hangAfterBytes, script.chunkSize)
    return
  }
  if (script.truncateAfterBytes !== undefined) {
    await writeAtMost(response, body, script.truncateAfterBytes, script.chunkSize)
    if (isWritable(response)) {
      response.destroy()
    }
    return
  }

  if (script.chunkSize === undefined) {
    response.end(body)
    return
  }
  for (let offset = 0; offset < body.length; offset += script.chunkSize) {
    if (!isWritable(response)) {
      return
    }
    response.write(body.subarray(offset, offset + script.chunkSize))
    await delay(1)
  }
  if (isWritable(response)) {
    response.end()
  }
}

async function writeAtMost(
  response: ServerResponse,
  body: Buffer,
  limit: number,
  chunkSize: number | undefined
): Promise<void> {
  const size = chunkSize ?? body.length
  for (let offset = 0; offset < limit; offset += size) {
    if (!isWritable(response)) {
      return
    }
    response.write(body.subarray(offset, Math.min(offset + size, limit)))
    await delay(1)
  }
}

function isWritable(response: ServerResponse): boolean {
  return !response.writableEnded && !response.destroyed
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms))
}
