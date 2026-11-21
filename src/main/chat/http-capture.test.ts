import { describe, expect, it } from 'vitest'
import {
  classifyFailure,
  classifyStatus,
  createRequestCapture,
  readRetryAfterMs,
  readRequestId
} from './http-capture'

function headersOf(entries: Record<string, string>): Headers {
  return new Headers(entries)
}

describe('classifyStatus', () => {
  it.each([
    [401, 'AUTH'],
    [403, 'AUTH'],
    [402, 'QUOTA'],
    [408, 'TIMEOUT'],
    [413, 'CONTEXT_WINDOW'],
    [400, 'INVALID_REQUEST'],
    [404, 'INVALID_REQUEST'],
    [422, 'INVALID_REQUEST'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [503, 'SERVER'],
    [302, 'UNKNOWN'],
    [200, null],
    [204, null]
  ] as const)('HTTP %i 归为 %s', (status, code) => {
    expect(classifyStatus(status)).toBe(code)
  })

  it('没有 HTTP 响应时状态分类为空，交给传输层分类', () => {
    expect(classifyStatus(undefined)).toBeNull()
  })
})

describe('classifyFailure', () => {
  it('超时与连接失败分开，普通错误按传输失败', () => {
    expect(classifyFailure(new DOMException('timed out', 'TimeoutError'))).toBe('TIMEOUT')
    expect(classifyFailure(new DOMException('aborted', 'AbortError'))).toBe('TIMEOUT')
    expect(classifyFailure(new TypeError('fetch failed'))).toBe('TRANSPORT')
    expect(classifyFailure(new Error('socket hang up'))).toBe('TRANSPORT')
  })

  it('原生 fetch 把超时码放在 cause 链里时也算超时，不看 message 措辞', () => {
    const failed = (cause: unknown): TypeError =>
      new TypeError('fetch failed', { cause })
    const wrapped = (cause: unknown): TypeError =>
      new TypeError('fetch failed', { cause: failed(cause) })

    // Node/undici 的连接、响应头、响应体超时都只把码放在 cause 上。
    expect(classifyFailure(failed({ code: 'UND_ERR_CONNECT_TIMEOUT' }))).toBe('TIMEOUT')
    expect(classifyFailure(wrapped({ code: 'UND_ERR_HEADERS_TIMEOUT' }))).toBe('TIMEOUT')
    expect(classifyFailure(wrapped({ code: 'UND_ERR_BODY_TIMEOUT' }))).toBe('TIMEOUT')
    expect(classifyFailure(failed({ code: 'ETIMEDOUT' }))).toBe('TIMEOUT')
    expect(
      classifyFailure(failed(Object.assign(new Error('超时'), { name: 'TimeoutError' })))
    ).toBe('TIMEOUT')
    // 只有 message 里有 timeout 字样时不算，避免按文案猜分类。
    expect(classifyFailure(new TypeError('request timeout occurred'))).toBe('TRANSPORT')
    expect(classifyFailure(failed({ code: 'ECONNREFUSED' }))).toBe('TRANSPORT')
    expect(classifyFailure(failed(new Error('connect failed')))).toBe('TRANSPORT')
  })

  it('cause 链打转或过长时安全收尾，不会无限递归', () => {
    const looped: { cause?: unknown } = {}
    looped.cause = looped
    expect(classifyFailure(new TypeError('fetch failed', { cause: looped }))).toBe('TRANSPORT')

    const cyclic = new Error('fetch failed') as Error & { cause?: unknown }
    cyclic.cause = cyclic
    expect(classifyFailure(cyclic)).toBe('TRANSPORT')

    let chain: Error & { cause?: unknown } = new Error('fetch failed')
    for (let depth = 0; depth < 50; depth += 1) {
      const next = new Error('fetch failed') as Error & { cause?: unknown }
      chain.cause = next
      chain = next
    }
    expect(classifyFailure(chain)).toBe('TRANSPORT')
  })
})

describe('readRequestId', () => {
  it('从响应头读 request id，支持常见几种名字', () => {
    expect(readRequestId(headersOf({ 'x-request-id': 'req-1' }))).toBe('req-1')
    expect(readRequestId(headersOf({ 'request-id': 'req-2' }))).toBe('req-2')
    expect(readRequestId(headersOf({ 'x-goog-request-id': 'req-3' }))).toBe('req-3')
    expect(readRequestId(headersOf({ 'anthropic-request-id': 'req-4' }))).toBe('req-4')
    expect(readRequestId(headersOf({ 'x-amzn-requestid': 'req-5' }))).toBe('req-5')
    expect(readRequestId(headersOf({ 'content-type': 'application/json' }))).toBeUndefined()
    expect(readRequestId(headersOf({ 'x-request-id': '   ' }))).toBeUndefined()
  })
})

describe('readRetryAfterMs', () => {
  const now = Date.parse('2026-11-21T00:00:00.000Z')

  it('Retry-After 的秒数与 HTTP 日期都换算成毫秒', () => {
    expect(readRetryAfterMs(headersOf({ 'retry-after': '7' }), now)).toBe(7000)
    expect(
      readRetryAfterMs(
        headersOf({ 'retry-after': new Date(now + 12_000).toUTCString() }),
        now
      )
    ).toBe(12_000)
    expect(readRetryAfterMs(headersOf({ 'retry-after': 'soon' }), now)).toBeUndefined()
    expect(readRetryAfterMs(headersOf({}), now)).toBeUndefined()
  })
})

describe('createRequestCapture', () => {
  it('每次请求一份独立捕获：状态、响应头 request id 与 Retry-After 都在 pi 拍平异常之前拿到', async () => {
    const capture = createRequestCapture({
      fetchImpl: async () =>
        new Response('{}', {
          status: 429,
          headers: {
            'x-request-id': 'req-429',
            'retry-after': '3'
          }
        })
    })

    expect(capture.snapshot()).toEqual({})

    const response = await capture.fetch('https://example.com/v1/chat/completions')
    expect(response.status).toBe(429)
    expect(capture.snapshot()).toEqual({
      status: 429,
      requestId: 'req-429',
      retryAfterMs: 3000
    })
  })

  it('请求没拿到响应时记录超时/传输失败，并把原错误继续抛给 pi', async () => {
    const timeout = createRequestCapture({
      fetchImpl: async () => {
        throw new DOMException('timed out', 'TimeoutError')
      }
    })
    await expect(timeout.fetch('https://example.com')).rejects.toThrow('timed out')
    expect(timeout.snapshot()).toEqual({ transport: 'TIMEOUT' })

    const transport = createRequestCapture({
      fetchImpl: async () => {
        throw new TypeError('fetch failed')
      }
    })
    await expect(transport.fetch('https://example.com')).rejects.toThrow('fetch failed')
    expect(transport.snapshot()).toEqual({ transport: 'TRANSPORT' })
  })

  it('用户主动停止不算超时：abort 之后失败只留下已拿到的状态', async () => {
    const controller = new AbortController()
    const capture = createRequestCapture({
      fetchImpl: async () => {
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      }
    })

    await expect(
      capture.fetch('https://example.com', { signal: controller.signal })
    ).rejects.toThrow('aborted')
    expect(capture.snapshot()).toEqual({})
  })

  it('并发请求各用各的捕获，状态不会互相串', async () => {
    const first = createRequestCapture({
      fetchImpl: async () =>
        new Response('{}', { status: 500, headers: { 'x-request-id': 'first' } })
    })
    const second = createRequestCapture({
      fetchImpl: async () =>
        new Response('{}', { status: 401, headers: { 'x-request-id': 'second' } })
    })

    await Promise.all([first.fetch('https://example.com/a'), second.fetch('https://example.com/b')])

    expect(first.snapshot()).toEqual({ status: 500, requestId: 'first' })
    expect(second.snapshot()).toEqual({ status: 401, requestId: 'second' })
  })
})
