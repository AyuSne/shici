import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatThreadView, ThreadContextItem } from '../../../shared/threads'

/** 只 mock 系统边界的 IPC 封装；store 的状态迁移仍走它自己的公开入口。 */
const api = vi.hoisted(() => ({
  loadThread: vi.fn(),
  loadThreads: vi.fn(),
  updateThreadContext: vi.fn(),
  openThreadForMainRequest: vi.fn(),
  packArticleWords: vi.fn(),
  createGroupThread: vi.fn(),
  createThread: vi.fn(),
  askThread: vi.fn()
}))

vi.mock('../api', () => api)

const windowApi = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue({ accepted: true }),
  subscribe: vi.fn()
}))
vi.stubGlobal('window', { api: windowApi })

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
  api.createGroupThread.mockReset()
  api.createThread.mockReset()
  api.askThread.mockReset()
  windowApi.invoke.mockClear()
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

  it('就地先发起、完整页随后是更新的意图：完整页导航胜出，旧就地打开不返回成功 id', async () => {
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
    await expect(local).resolves.toBeNull()
    await expect(page).resolves.toBe('t-page')
    expect(store.getChatStore().currentId).toBe('t-page')
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

describe('就地/完整页打开的所有权与最新意图', () => {
  const mainA = { kind: 'entry', entryId: 'e-a' } as const
  const mainB = { kind: 'entry', entryId: 'e-b' } as const

  it('取消的 A 晚到不会把已经打开的 B 换回去，也不产生导航或错误', async () => {
    const pendingA = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    const pendingB = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    api.openThreadForMainRequest
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise)
    const controller = new AbortController()

    const a = store.openThreadForMain(mainA, {
      openInPlace: true,
      signal: controller.signal
    })
    controller.abort()
    const b = store.openThreadForMain(mainB, { openInPlace: true })
    pendingB.resolve({ status: 'created', thread: view('t-b', []) })
    await expect(b).resolves.toBe('t-b')
    expect(store.getChatStore().currentId).toBe('t-b')

    // A 在主进程里跑完才回来：它的调用方已取消，不能激活自己。
    pendingA.resolve({ status: 'created', thread: view('t-a', []) })
    await expect(a).resolves.toBeNull()

    expect(store.getChatStore().currentId).toBe('t-b')
    expect(store.getChatStore().error).toBeNull()
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('较旧的完整页 A 晚于较新的 B 返回时，不覆盖 B 的当前对话与导航', async () => {
    const pendingA = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    const pendingB = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    api.openThreadForMainRequest
      .mockReturnValueOnce(pendingA.promise)
      .mockReturnValueOnce(pendingB.promise)

    const a = store.openThreadForMain(mainA)
    const b = store.openThreadForMain(mainB)
    pendingB.resolve({ status: 'created', thread: view('t-newer', []) })
    await expect(b).resolves.toBe('t-newer')
    expect(store.getChatStore().currentId).toBe('t-newer')
    expect(navigation.navigate).toHaveBeenCalledTimes(1)

    pendingA.resolve({ status: 'created', thread: view('t-older', []) })
    await expect(a).resolves.toBeNull()

    expect(store.getChatStore().currentId).toBe('t-newer')
    expect(navigation.navigate).toHaveBeenCalledTimes(1)
    expect(navigation.navigate).toHaveBeenCalledWith('chat', { threadId: 't-newer' })
  })

  it('所有调用方都取消后，晚到的失败不污染当前对话的错误状态', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    api.openThreadForMainRequest.mockReturnValueOnce(pending.promise)
    const controller = new AbortController()

    const a = store.openThreadForMain(mainA, {
      openInPlace: true,
      signal: controller.signal
    })
    controller.abort()
    pending.reject(new Error('主进程读失败'))
    await expect(a).resolves.toBeNull()

    expect(store.getChatStore().currentId).toBeNull()
    expect(store.getChatStore().error).toBeNull()
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('共享操作里一个调用方取消、另一个仍有效时照常激活并只激活一次', async () => {
    const pending = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    api.openThreadForMainRequest.mockReturnValueOnce(pending.promise)
    const controller = new AbortController()

    const cancelled = store.openThreadForMain(mainA, {
      openInPlace: true,
      signal: controller.signal
    })
    const valid = store.openThreadForMain(mainA, { openInPlace: true })
    controller.abort()
    pending.resolve({ status: 'created', thread: view('t-shared', []) })

    await expect(cancelled).resolves.toBeNull()
    await expect(valid).resolves.toBe('t-shared')
    expect(store.getChatStore().currentId).toBe('t-shared')
    expect(store.getChatStore().error).toBeNull()
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('默认完整页打开仍然激活当前对话并导航一次', async () => {
    api.openThreadForMainRequest.mockResolvedValueOnce({
      status: 'created',
      thread: view('t-page', [])
    })

    await expect(store.openThreadForMain(mainA)).resolves.toBe('t-page')

    expect(store.getChatStore().currentId).toBe('t-page')
    expect(navigation.navigate).toHaveBeenCalledTimes(1)
    expect(navigation.navigate).toHaveBeenCalledWith('chat', { threadId: 't-page' })
  })
})

describe('跨入口的对话意图：任何真实打开方式都让旧请求过期', () => {
  const mainA = { kind: 'entry', entryId: 'e-a' } as const

  it('打开已有对话 B（B 还在读）时，晚到的 A 不激活、不返回成功 id，B 的读回仍生效', async () => {
    const pendingA = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    const pendingB = deferred<Awaited<ReturnType<typeof api.loadThread>>>()
    api.openThreadForMainRequest.mockReturnValueOnce(pendingA.promise)
    api.loadThread.mockReturnValueOnce(pendingB.promise)

    const a = store.openThreadForMain(mainA, { openInPlace: true })
    store.openChatThread('t-existing')
    expect(store.getChatStore().currentId).toBe('t-existing')

    // A 先回来：B 的数据还在路上。旧代码会把 currentId 改成 A，随后 B 的读回
    // 被 currentId guard 丢掉；正确行为是 A 过期，B 的读回照常落地。
    pendingA.resolve({ status: 'created', thread: view('t-late-a', []) })
    await expect(a).resolves.toBeNull()
    expect(store.getChatStore().currentId).toBe('t-existing')

    pendingB.resolve(view('t-existing', []))
    await vi.waitFor(() =>
      expect(store.getChatStore().current?.id).toBe('t-existing')
    )
    expect(store.getChatStore().error).toBeNull()
    expect(navigation.navigate).not.toHaveBeenCalled()
  })

  it('打包打开 B 后，晚到的 A 不覆盖 B 的当前对话，也不再多导航一次', async () => {
    const pendingA = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    const pendingPack = deferred<Awaited<ReturnType<typeof api.packArticleWords>>>()
    api.openThreadForMainRequest.mockReturnValueOnce(pendingA.promise)
    api.packArticleWords.mockReturnValueOnce(pendingPack.promise)

    const a = store.openThreadForMain(mainA, { openInPlace: true })
    const pack = store.openArticlePackThread('article-1')
    pendingPack.resolve({
      status: 'created',
      thread: view('t-packed', []),
      packedCount: 1,
      totalCount: 1,
      omittedCount: 0
    })
    await expect(pack).resolves.toMatchObject({ status: 'created' })
    expect(store.getChatStore().currentId).toBe('t-packed')
    expect(navigation.navigate).toHaveBeenCalledTimes(1)

    pendingA.resolve({ status: 'created', thread: view('t-late-a', []) })
    await expect(a).resolves.toBeNull()

    expect(store.getChatStore().currentId).toBe('t-packed')
    expect(navigation.navigate).toHaveBeenCalledTimes(1)
    expect(navigation.navigate).toHaveBeenCalledWith('chat', { threadId: 't-packed' })
    expect(store.getChatStore().error).toBeNull()
  })

  it('组词打开 B 后，晚到的 A 不覆盖 B，也不把错误写进 B', async () => {
    const pendingA = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    api.openThreadForMainRequest.mockReturnValueOnce(pendingA.promise)
    api.createGroupThread.mockResolvedValueOnce({ status: 'created', thread: view('t-group', []) })

    const a = store.openThreadForMain(mainA, { openInPlace: true })
    await expect(store.openGroupThread(['e-a'])).resolves.toBe('t-group')
    expect(store.getChatStore().currentId).toBe('t-group')

    pendingA.resolve({ status: 'created', thread: view('t-late-a', []) })
    await expect(a).resolves.toBeNull()

    expect(store.getChatStore().currentId).toBe('t-group')
    expect(store.getChatStore().error).toBeNull()
    expect(navigation.navigate).toHaveBeenCalledTimes(1)
  })

  it('空白对话先建好并激活后，晚到的 A 不把它换回旧线程', async () => {
    const pendingA = deferred<Awaited<ReturnType<typeof api.openThreadForMainRequest>>>()
    api.openThreadForMainRequest.mockReturnValueOnce(pendingA.promise)
    api.createThread.mockResolvedValueOnce({ status: 'created', thread: view('t-blank', []) })

    const a = store.openThreadForMain(mainA, { openInPlace: true })
    await expect(store.ensureBlankContextThread()).resolves.toMatchObject({ id: 't-blank' })
    expect(store.getChatStore().currentId).toBe('t-blank')

    pendingA.resolve({ status: 'created', thread: view('t-late-a', []) })
    await expect(a).resolves.toBeNull()

    expect(store.getChatStore().currentId).toBe('t-blank')
    expect(store.getChatStore().error).toBeNull()
  })

  it('空白第一问的正常路径：路由对同一条线程再打开也不丢刚写下的 turn', async () => {
    const ask = deferred<Awaited<ReturnType<typeof api.askThread>>>()
    api.createThread.mockResolvedValueOnce({ status: 'created', thread: view('t-question', []) })
    api.askThread.mockReturnValueOnce(ask.promise)

    expect(store.sendChatMessage('正常第一问')).toBe(true)
    await vi.waitFor(() => expect(api.askThread).toHaveBeenCalledTimes(1))
    // 路由挂载会对当前线程再调一次 openChatThread；这不是切到别的对话。
    store.openChatThread('t-question')

    const askedThread = view('t-question', [])
    ask.resolve({ status: 'asked', questionId: 'q-normal', thread: askedThread })
    await vi.waitFor(() => expect(store.getChatStore().current).toBe(askedThread))
    expect(store.getChatStore().session.generation?.threadId).toBe('t-question')
    expect(store.getChatStore().session.generation?.questionId).toBe('q-normal')
  })

  it('空白第一问创建期间路由先落到空白对话：创建回来仍要占住它自己的当前线程', async () => {
    const pendingCreate = deferred<Awaited<ReturnType<typeof api.createThread>>>()
    const ask = deferred<Awaited<ReturnType<typeof api.askThread>>>()
    api.createThread.mockReturnValueOnce(pendingCreate.promise)
    api.askThread.mockReturnValueOnce(ask.promise)

    expect(store.sendChatMessage('路由竞态也要显示')).toBe(true)
    // ChatPage 的 mount effect 可能先于 createThread 回复执行；这是同一个空白意图。
    store.openChatThread(null)
    pendingCreate.resolve({ status: 'created', thread: view('t-race', []) })
    await vi.waitFor(() => expect(api.askThread).toHaveBeenCalledTimes(1))

    const askedThread = view('t-race', [])
    ask.resolve({ status: 'asked', questionId: 'q-race', thread: askedThread })
    await vi.waitFor(() => expect(store.getChatStore().current).toBe(askedThread))
    expect(store.getChatStore().currentId).toBe('t-race')
    expect(store.getChatStore().session.generation?.threadId).toBe('t-race')
  })

  it('空白第一问的创建迟到：问题仍写进 A 并在 A 生成，B 的当前对话不被改写', async () => {
    const pendingCreate = deferred<Awaited<ReturnType<typeof api.createThread>>>()
    const pendingAsk = deferred<Awaited<ReturnType<typeof api.askThread>>>()
    const pendingB = deferred<Awaited<ReturnType<typeof api.loadThread>>>()
    api.createThread.mockReturnValueOnce(pendingCreate.promise)
    api.askThread.mockReturnValueOnce(pendingAsk.promise)
    api.loadThread.mockReturnValueOnce(pendingB.promise)

    expect(store.sendChatMessage('这个问题属于 A')).toBe(true)
    store.openChatThread('t-existing')
    expect(store.getChatStore().currentId).toBe('t-existing')

    pendingCreate.resolve({ status: 'created', thread: view('t-question', []) })
    await vi.waitFor(() =>
      expect(api.askThread).toHaveBeenCalledWith({
        threadId: 't-question',
        text: '这个问题属于 A',
        context: []
      })
    )

    pendingAsk.resolve({
      status: 'asked',
      questionId: 'q-a',
      thread: view('t-question', [])
    })
    await vi.waitFor(() =>
      expect(store.getChatStore().session.generation?.threadId).toBe('t-question')
    )

    // B 的读回迟到：提问与生成留在 A，但当前界面仍是 B。
    pendingB.resolve(view('t-existing', []))
    await vi.waitFor(() => expect(store.getChatStore().current?.id).toBe('t-existing'))
    expect(store.getChatStore().session.generation?.threadId).toBe('t-question')
    expect(store.getChatStore().session.generation?.questionId).toBe('q-a')
    expect(store.getChatStore().busy).toBe(false)
    expect(store.getChatStore().error).toBeNull()
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
