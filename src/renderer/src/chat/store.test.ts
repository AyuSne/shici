import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatThreadView, ThreadContextItem } from '../../../shared/threads'

/** 只 mock 系统边界的 IPC 封装；store 的状态迁移仍走它自己的公开入口。 */
const api = vi.hoisted(() => ({
  loadThread: vi.fn(),
  loadThreads: vi.fn(),
  updateThreadContext: vi.fn(),
  openThreadForMainRequest: vi.fn(),
  packArticleWords: vi.fn()
}))

vi.mock('../api', () => api)

/** 导航是页面级副作用；in-place 打开要求它完全不被调用。 */
const navigation = vi.hoisted(() => ({
  navigate: vi.fn(),
  replaceRoute: vi.fn(),
  forgetChatThread: vi.fn()
}))

vi.mock('../navigate', () => navigation)

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
  api.openThreadForMainRequest.mockReset()
  api.packArticleWords.mockReset()
  navigation.navigate.mockReset()
  navigation.replaceRoute.mockReset()
  navigation.forgetChatThread.mockReset()
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

describe('就地打开对话（迷你轻问抽屉）', () => {
  const main = { kind: 'entry', entryId: 'e-1' } as const

  it('openInPlace 只激活线程、不导航；默认仍走完整对话页', async () => {
    api.openThreadForMainRequest.mockResolvedValueOnce({
      status: 'created',
      thread: view('t-in-place', [])
    })

    await store.openThreadForMain(main, { openInPlace: true })

    expect(store.getChatStore().currentId).toBe('t-in-place')
    expect(navigation.navigate).not.toHaveBeenCalled()

    api.openThreadForMainRequest.mockResolvedValueOnce({
      status: 'created',
      thread: view('t-page', [])
    })
    await store.openThreadForMain(main)

    expect(store.getChatStore().currentId).toBe('t-page')
    expect(navigation.navigate).toHaveBeenCalledWith('chat', { threadId: 't-page' })
  })

  it('in-place 与完整页的同一对象请求不共享同一个在途操作，互不吞掉导航意图', async () => {
    const inPlace = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    const fullPage = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    api.openThreadForMainRequest
      .mockReturnValueOnce(inPlace.promise)
      .mockReturnValueOnce(fullPage.promise)

    const local = store.openThreadForMain(main, { openInPlace: true })
    const page = store.openThreadForMain(main)

    expect(api.openThreadForMainRequest).toHaveBeenCalledTimes(2)
    inPlace.resolve({ status: 'created', thread: view('t-local', []) })
    fullPage.resolve({ status: 'created', thread: view('t-page', []) })
    await expect(local).resolves.toBe('t-local')
    await expect(page).resolves.toBe('t-page')
    expect(navigation.navigate).toHaveBeenCalledTimes(1)
    expect(navigation.navigate).toHaveBeenCalledWith('chat', { threadId: 't-page' })
  })

  it('一个调用方取消不会误取消另一个有效调用方，迟到的激活也不会替取消方导航', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    api.openThreadForMainRequest.mockReturnValueOnce(pending.promise)
    const controller = new AbortController()

    const cancelled = store.openThreadForMain(main, {
      openInPlace: true,
      signal: controller.signal
    })
    const valid = store.openThreadForMain(main, { openInPlace: true })
    expect(api.openThreadForMainRequest).toHaveBeenCalledTimes(1)

    controller.abort()
    pending.resolve({ status: 'created', thread: view('t-shared', []) })

    await expect(cancelled).resolves.toBeNull()
    await expect(valid).resolves.toBe('t-shared')
    expect(store.getChatStore().currentId).toBe('t-shared')
    expect(navigation.navigate).not.toHaveBeenCalled()
  })
})

describe('本篇未整理词打包问模型', () => {
  it('创建成功才激活线程并跳对话页；没有可打包的词时不动当前对话也不跳', async () => {
    api.packArticleWords.mockResolvedValueOnce({
      status: 'created',
      thread: view('t-pack', []),
      packedCount: 2,
      totalCount: 3,
      omittedCount: 1
    })

    const created = await store.openArticlePackThread('article-1')

    expect(created).toMatchObject({ status: 'created', packedCount: 2, omittedCount: 1 })
    expect(store.getChatStore().currentId).toBe('t-pack')
    expect(navigation.navigate).toHaveBeenCalledWith('chat', { threadId: 't-pack' })

    navigation.navigate.mockClear()
    const before = store.getChatStore().currentId
    api.packArticleWords.mockResolvedValueOnce({
      status: 'empty',
      reason: 'all-organized',
      totalCount: 0
    })
    const empty = await store.openArticlePackThread('article-1')

    expect(empty).toEqual({ status: 'empty', reason: 'all-organized', totalCount: 0 })
    expect(store.getChatStore().currentId).toBe(before)
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('迟到的打包结果在取消后不激活、不导航', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.packArticleWords>>>()
    api.packArticleWords.mockReturnValueOnce(pending.promise)
    const controller = new AbortController()

    const call = store.openArticlePackThread('article-1', { signal: controller.signal })
    controller.abort()
    pending.resolve({
      status: 'created',
      thread: view('t-late', []),
      packedCount: 1,
      totalCount: 1,
      omittedCount: 0
    })

    await expect(call).resolves.toBeNull()
    expect(store.getChatStore().currentId).toBeNull()
    expect(navigation.navigate).not.toHaveBeenCalled()
  })
})
