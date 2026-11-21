import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatThreadView, ThreadContextItem } from '../../../shared/threads'

/** 只 mock 系统边界的 IPC 封装；store 的状态迁移仍走它自己的公开入口。 */
const api = vi.hoisted(() => ({
  loadThread: vi.fn(),
  loadThreads: vi.fn(),
  updateThreadContext: vi.fn()
}))

vi.mock('../api', () => api)

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

const alpha: ThreadContextItem = {
  id: 'word:e-alpha',
  kind: 'word',
  label: 'alpha',
  text: 'alpha',
  source: ''
}

const beta: ThreadContextItem = {
  id: 'word:e-beta',
  kind: 'word',
  label: 'beta',
  text: 'beta',
  source: ''
}

const gamma: ThreadContextItem = {
  id: 'word:e-gamma',
  kind: 'word',
  label: 'gamma',
  text: 'gamma',
  source: ''
}

function view(id: string, items: readonly ThreadContextItem[]): ChatThreadView {
  return {
    id,
    title: '组词练习',
    main: { kind: 'none' },
    context: [...items],
    contextSummary: {
      articleCount: 0,
      paragraphCount: 0,
      wordCount: items.length,
      sentenceCount: 0,
      excerptCount: 0,
      charCount: items.reduce((total, item) => total + item.text.length, 0)
    },
    turns: [],
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z'
  }
}

let store: typeof import('./store')

beforeEach(async () => {
  vi.resetModules()
  api.loadThread.mockReset()
  api.loadThreads.mockReset()
  api.updateThreadContext.mockReset()
  api.loadThreads.mockResolvedValue({ threads: [] })
  store = await import('./store')
})

describe('changeContext 的恢复读', () => {
  it('拒绝后的旧快照晚到，不能盖掉之后已经成功保存的较新上下文', async () => {
    const initial = view('t-1', [alpha])
    const staleRecovery = deferred<ChatThreadView | null>()
    api.loadThread
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(staleRecovery.promise)

    store.openChatThread('t-1')
    await vi.waitFor(() => expect(store.getChatStore().current?.id).toBe('t-1'))

    // 第一次改上下文被主进程拒绝，store 立即发起一次恢复读；这次回复被刻意扣住。
    api.updateThreadContext.mockResolvedValueOnce({
      status: 'rejected',
      reason: 'too-many-words'
    })
    store.addContextItem(beta)
    await vi.waitFor(() => expect(api.loadThread).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(store.getChatStore().error).not.toBeNull())

    // 恢复读还没回来时，用户删掉 alpha，主进程成功保存了只含 beta 的新上下文。
    const newer = view('t-1', [beta, gamma])
    api.updateThreadContext.mockResolvedValueOnce({ status: 'saved', thread: newer })
    store.removeContextItem(alpha.id)
    await vi.waitFor(() =>
      expect(store.getChatStore().current?.context.map((item) => item.id)).toEqual([
        beta.id,
        gamma.id
      ])
    )

    // 旧恢复读现在才回来：它手里的快照包含已经删掉的 alpha。
    staleRecovery.resolve(view('t-1', [alpha, beta]))
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getChatStore().current?.context.map((item) => item.id)).toEqual([
      beta.id,
      gamma.id
    ])
  })

  it('恢复读期间切到另一条线程，旧线程的迟到快照不能把当前线程换回去', async () => {
    const initial = view('t-1', [alpha])
    const staleRecovery = deferred<ChatThreadView | null>()
    api.loadThread
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(staleRecovery.promise)

    store.openChatThread('t-1')
    await vi.waitFor(() => expect(store.getChatStore().current?.id).toBe('t-1'))

    api.updateThreadContext.mockResolvedValueOnce({
      status: 'rejected',
      reason: 'too-many-words'
    })
    store.addContextItem(beta)
    await vi.waitFor(() => expect(api.loadThread).toHaveBeenCalledTimes(2))

    const nextThread = view('t-2', [gamma])
    api.loadThread.mockResolvedValueOnce(nextThread)
    store.openChatThread('t-2')
    await vi.waitFor(() => expect(store.getChatStore().current?.id).toBe('t-2'))

    staleRecovery.resolve(view('t-1', [alpha, beta]))
    await Promise.resolve()
    await Promise.resolve()
    expect(store.getChatStore().currentId).toBe('t-2')
    expect(store.getChatStore().current?.context.map((item) => item.id)).toEqual([gamma.id])
  })
})
