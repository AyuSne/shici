import { describe, expect, it, vi } from 'vitest'
import { startLocalSseTransport } from './sse-transport'

/**
 * 本地 SSE 传输只负责一台本地 HTTP 服务的外壳：记录请求、统计中途断开、
 * 监听与关闭。协议事件形状由调用方的 responder 决定，这里不测任何协议。
 */
describe('startLocalSseTransport', () => {
  it('记录方法、路径、请求头与解析后的 JSON 体，并原样交回 responder', async () => {
    const transport = await startLocalSseTransport(async (response, request) => {
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(`ok ${request.url} ${String(request.body.model)}`)
    })

    try {
      const reply = await fetch(`${transport.baseUrl}/v1/chat?stream=true`, {
        method: 'POST',
        headers: { 'x-api-key': 'test-key' },
        body: JSON.stringify({ model: 'stub-model' })
      })

      expect(await reply.text()).toBe('ok /v1/chat?stream=true stub-model')
      expect(transport.requests).toHaveLength(1)
      expect(transport.requests[0]).toMatchObject({
        method: 'POST',
        url: '/v1/chat?stream=true',
        headers: { 'x-api-key': 'test-key' },
        body: { model: 'stub-model' }
      })
    } finally {
      await transport.close()
    }
  })

  it('JSON 体解析不出时记为空对象，不阻断请求', async () => {
    const transport = await startLocalSseTransport(async (response) => {
      response.writeHead(200)
      response.end('ok')
    })

    try {
      await fetch(transport.baseUrl, { method: 'POST', body: 'not json' })
      expect(transport.requests[0]?.body).toEqual({})
    } finally {
      await transport.close()
    }
  })

  it('统计客户端中途断开的连接，close 不悬挂', async () => {
    const transport = await startLocalSseTransport(async (response) => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.write('data: {"type":"ping"}\n\n')
      // 故意不结束：调用方稍后中断连接，模拟停止流。
    })

    try {
      const controller = new AbortController()
      const reply = await fetch(transport.baseUrl, { signal: controller.signal })
      const reader = reply.body?.getReader()
      expect(reader).toBeDefined()
      await reader?.read()
      controller.abort()

      await vi.waitFor(() => {
        expect(transport.abortedConnections).toBe(1)
      })
    } finally {
      await transport.close()
    }
  })
})
