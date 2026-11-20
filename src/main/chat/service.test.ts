import { afterEach, describe, expect, it } from 'vitest'
import type { ChatStreamEvent, ChatStreamUpdate } from '../../shared/chat'
import {
  startSseStub,
  type SseStub,
  type StubScript
} from '../../testing/sse-stub'
import type { ChatConfig } from './config'
import { streamChatCompletion } from './pi-stream'
import { createChatService } from './service'

const stubs: SseStub[] = []

afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function stub(script: StubScript): Promise<SseStub> {
  const created = await startSseStub(script)
  stubs.push(created)
  return created
}

function configFor(target: SseStub): ChatConfig {
  return {
    apiKey: 'test-key',
    baseUrl: target.baseUrl,
    model: 'deepseek-flash'
  }
}

function collector(): {
  events: ChatStreamEvent[]
  send: (update: ChatStreamUpdate) => void
  waitFor: (
    predicate: (events: readonly ChatStreamEvent[]) => boolean,
    timeoutMs?: number
  ) => Promise<void>
} {
  const events: ChatStreamEvent[] = []
  return {
    events,
    send: (update) => events.push(update.event),
    waitFor: (predicate, timeoutMs = 3000) => waitUntil(() => predicate(events), timeoutMs)
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('等待事件超时')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const userTurn = { role: 'user' as const, content: '你好' }

describe('createChatService', () => {
  it('思维链先、正文后，事件按抵达顺序归一，请求显式带思考强度', async () => {
    const target = await stub({
      kind: 'stream',
      thinking: ['先', '想'],
      text: ['答', '案'],
      chunkDelayMs: 5,
      textDelayMs: 20
    })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    expect(
      service.start({ threadId: 'thread-1', streamId: 'stream-1', messages: [userTurn] }, send)
    ).toEqual({ accepted: true })
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(events).toEqual([
      { type: 'thinking', text: '先' },
      { type: 'thinking', text: '想' },
      { type: 'text', text: '答' },
      { type: 'text', text: '案' },
      { type: 'done' }
    ])

    const request = target.requests[0]
    expect(request).toBeDefined()
    expect(request?.body).toMatchObject({
      model: 'deepseek-flash',
      stream: true,
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
      messages: [userTurn]
    })
  })

  it('SSE 一行被网络拆成两段时仍归并成同一条事件', async () => {
    const target = await stub({
      kind: 'stream',
      thinking: ['想'],
      text: ['答'],
      fragmentChunks: true,
      chunkDelayMs: 1,
      textDelayMs: 5
    })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-fragmented', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(events).toEqual([
      { type: 'thinking', text: '想' },
      { type: 'text', text: '答' },
      { type: 'done' }
    ])
  })

  it.each([
    [401, 'invalid-key'],
    [402, 'insufficient-balance'],
    [413, 'context-too-long'],
    [429, 'rate-limited'],
    [500, 'server-busy'],
    [503, 'server-busy'],
    [400, 'unknown']
  ] as const)('HTTP %i 归为 %s，并保留状态码与 request id', async (status, code) => {
    const target = await stub({ kind: 'status', status })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: `stream-${status}`, messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    const event = events.find((candidate) => candidate.type === 'error')
    expect(event).toMatchObject({ type: 'error', error: { code, status } })
    if (status === 401) {
      expect(event).toMatchObject({ error: { requestId: 'stub-401' } })
    }
  })

  it('响应 200 之后连接断掉时归为网络异常，不假装生成完成', async () => {
    const target = await stub({
      kind: 'truncate',
      thinking: ['想'],
      text: ['半句']
    })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-truncate', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    const event = events.find((candidate) => candidate.type === 'error')
    expect(event).toMatchObject({ type: 'error', error: { code: 'network' } })
    expect(events.some((candidate) => candidate.type === 'done')).toBe(false)
  })

  it('流在 finish_reason 之前结束时归为网络异常，不假装生成完成', async () => {
    const target = await stub({
      kind: 'end-early',
      thinking: ['想'],
      text: ['半句']
    })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-end-early', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    const event = events.find((candidate) => candidate.type === 'error')
    expect(event).toMatchObject({ type: 'error', error: { code: 'network' } })
    expect(events.some((candidate) => candidate.type === 'done')).toBe(false)
  })

  it('连不上模型服务时归为网络异常', async () => {
    const service = createChatService({
      resolveConfig: () => ({
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:1',
        model: 'deepseek-flash'
      })
    })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-network', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    const event = events[0]
    expect(event).toMatchObject({ type: 'error', error: { code: 'network' } })
    if (event?.type === 'error') {
      expect(event.error.status).toBeUndefined()
    }
  })

  it('没有配置密钥时给出配置错误，不发起请求', async () => {
    const service = createChatService({ resolveConfig: () => null })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-config', messages: [userTurn] }, send)
    await waitFor((current) => current.length > 0)

    expect(events).toEqual([
      { type: 'error', error: { code: 'not-configured' } }
    ])
  })

  it('停止会中断请求，已收到的内容保留，且不再补发 done 或 error', async () => {
    const target = await stub({ kind: 'hang', thinking: ['想'], text: ['半句'] })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { events, send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-stop', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'text'))

    expect(service.hasActiveThread('thread-1')).toBe(true)
    expect(service.hasActiveThread('another-thread')).toBe(false)
    expect(service.stop('stream-stop')).toEqual({ stopped: true })
    await waitUntil(() => target.abortedConnections > 0)
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(events.filter((event) => event.type === 'thinking')).toEqual([
      { type: 'thinking', text: '想' }
    ])
    expect(events.some((event) => event.type === 'done' || event.type === 'error')).toBe(
      false
    )
    expect(service.stop('stream-stop')).toEqual({ stopped: false })
  })

  it('同一 streamId 不会被启动两次', async () => {
    const target = await stub({ kind: 'hang' })
    const service = createChatService({ resolveConfig: () => configFor(target) })
    const { send } = collector()

    expect(
      service.start({ threadId: 'thread-1', streamId: 'stream-duplicate', messages: [userTurn] }, send)
    ).toEqual({ accepted: true })
    expect(
      service.start({ threadId: 'thread-1', streamId: 'stream-duplicate', messages: [userTurn] }, send)
    ).toEqual({ accepted: false })

    service.stop('stream-duplicate')
  })
})

describe('配置回写与切换', () => {
  it('一次成功调用后把使用中的 provider 标成已验证', async () => {
    const target = await stub({ kind: 'stream', text: ['答'] })
    const verified: string[] = []
    const service = createChatService({
      resolveConfig: () => ({ ...configFor(target), providerId: 'provider-1' }),
      onVerified: (providerId) => verified.push(providerId)
    })
    const { send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-verified', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'done'))

    expect(verified).toEqual(['provider-1'])
  })

  it('出错时不把 provider 标成已验证', async () => {
    const target = await stub({ kind: 'status', status: 500 })
    const verified: string[] = []
    const service = createChatService({
      resolveConfig: () => ({ ...configFor(target), providerId: 'provider-1' }),
      onVerified: (providerId) => verified.push(providerId)
    })
    const { send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-failed', messages: [userTurn] }, send)
    await waitFor((current) => current.some((event) => event.type === 'error'))

    expect(verified).toEqual([])
  })

  it('每次调用重新解析配置，切换只影响之后的调用', async () => {
    const first = await stub({ kind: 'stream', text: ['一'] })
    const second = await stub({ kind: 'stream', text: ['二'] })
    let current: ChatConfig = configFor(first)
    const service = createChatService({ resolveConfig: () => current })
    const { send, waitFor } = collector()

    service.start({ threadId: 'thread-1', streamId: 'stream-first', messages: [userTurn] }, send)
    await waitFor((events) => events.some((event) => event.type === 'done'))

    current = { ...configFor(second), model: 'deepseek-v4-pro' }
    service.start({ threadId: 'thread-1', streamId: 'stream-second', messages: [userTurn] }, send)
    await waitFor(
      (events) => events.filter((event) => event.type === 'done').length === 2
    )

    expect(first.requests[0]?.body.model).toBe('deepseek-flash')
    expect(second.requests[0]?.body.model).toBe('deepseek-v4-pro')
  })
})

describe('streamChatCompletion', () => {
  it('缺少思考强度时拒绝发送请求', async () => {
    const target = await stub({ kind: 'stream', text: ['不该出现'] })
    const controller = new AbortController()

    await expect(
      streamChatCompletion({
        apiKey: 'test-key',
        baseUrl: target.baseUrl,
        model: 'deepseek-flash',
        messages: [userTurn],
        reasoningEffort: undefined as never,
        signal: controller.signal,
        onEvent: () => undefined
      })
    ).rejects.toThrow('思考强度必须显式传入')

    expect(target.requests).toHaveLength(0)
  })
})
