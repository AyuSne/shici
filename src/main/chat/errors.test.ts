import { describe, expect, it } from 'vitest'
import { chatErrorFrom, chatErrorFromFailure, classifyChatError } from './errors'

describe('classifyChatError（渲染层兼容）', () => {
  it.each([
    [401, 'invalid-key'],
    [403, 'invalid-key'],
    [402, 'insufficient-balance'],
    [413, 'context-too-long'],
    [429, 'rate-limited'],
    [500, 'server-busy'],
    [503, 'server-busy'],
    [400, 'unknown'],
    [undefined, 'network']
  ] as const)('HTTP %s 仍归为 %s', (status, code) => {
    expect(classifyChatError(status)).toBe(code)
  })
})

describe('chatErrorFrom', () => {
  it('保留既有状态码、报文与从报文里提取的 request id', () => {
    expect(chatErrorFrom(401, 'Authentication Fails (request_id: req-body)')).toEqual({
      code: 'invalid-key',
      kind: 'AUTH',
      status: 401,
      detail: 'Authentication Fails (request_id: req-body)',
      requestId: 'req-body'
    })
  })
})

describe('chatErrorFromFailure（稳定分类）', () => {
  it.each([
    ['AUTH', 'invalid-key'],
    ['QUOTA', 'insufficient-balance'],
    ['RATE_LIMIT', 'rate-limited'],
    ['CONTEXT_WINDOW', 'context-too-long'],
    ['SERVER', 'server-busy'],
    ['TIMEOUT', 'network'],
    ['TRANSPORT', 'network'],
    ['EMPTY_RESPONSE', 'empty-response'],
    ['INVALID_REQUEST', 'unknown'],
    ['UNKNOWN', 'unknown']
  ] as const)('稳定码 %s 仍落到渲染层码 %s', (kind, code) => {
    expect(chatErrorFromFailure({ kind })).toMatchObject({ kind, code })
  })

  it('带上面向排障的状态、request id、Retry-After 与报文', () => {
    expect(
      chatErrorFromFailure({
        kind: 'RATE_LIMIT',
        status: 429,
        requestId: 'req-header',
        retryAfterMs: 3000,
        detail: 'rate limited'
      })
    ).toEqual({
      code: 'rate-limited',
      kind: 'RATE_LIMIT',
      status: 429,
      requestId: 'req-header',
      retryAfterMs: 3000,
      detail: 'rate limited'
    })
  })

  it('没有稳定码时按未知错误，不会只靠 message 猜状态', () => {
    expect(chatErrorFromFailure({ detail: 'upstream exploded' })).toEqual({
      code: 'unknown',
      kind: 'UNKNOWN',
      detail: 'upstream exploded'
    })
  })
})
