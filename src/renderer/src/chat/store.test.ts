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
  askThread: vi.fn(),
  editThreadQuestion: vi.fn(),
  saveThreadAnswer: vi.fn(),
  saveThreadContinuation: vi.fn()
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

function editableThread(id: string): ChatThreadView {
  const base = view(id, [])
  return {
    ...base,
    turns: [
      {
        question: {
          id: 'q-old',
          text: '旧问题',
          createdAt: '2026-11-20T00:00:00.000Z',
          wordCount: 0,
          versions: [{ id: 'q-old', selected: true }]
        },
        answer: null
      }
    ]
  }
}

function questionThread(id: string, questionId = 'q-a'): ChatThreadView {
  const base = view(id, [])
  return {
    ...base,
    turns: [
      {
        question: {
          id: questionId,
          text: '问题',
          createdAt: '2026-11-20T00:00:00.000Z',
          wordCount: 0,
          versions: [{ id: questionId, selected: true }]
        },
        answer: null
      }
    ]
  }
}

function answeredThread(id: string): ChatThreadView {
  const base = questionThread(id)
  return {
    ...base,
    turns: [
      {
        ...base.turns[0]!,
        answer: {
          id: 'a-root',
          versions: [{ id: 'a-root', selected: true }],
          text: '已有正文',
          thinking: '',
          thinkingMs: 0,
          phase: 'done',
          error: null,
          model: 'old-model',
          createdAt: '2026-11-20T00:00:00.000Z',
          continuationIds: []
        }
      }
    ]
  }
}

function streamIdOfLastStart(): string {
  const calls = windowApi.invoke.mock.calls.filter(([channel]) => channel === 'chat:start')
  const call = calls.at(-1)
  if (call === undefined) throw new Error('没有发起生成')
  return (call[1] as { streamId: string }).streamId
}

function streamText(streamId: string, text: string): void {
  const handler = windowApi.subscribe.mock.calls[0]?.[1]
  if (typeof handler !== 'function') throw new Error('没有订阅 chat:event')
  handler({ streamId, event: { type: 'text', text } })
  handler({ streamId, event: { type: 'done' } })
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
  api.editThreadQuestion.mockReset()
  api.saveThreadAnswer.mockReset()
  api.saveThreadContinuation.mockReset()
  windowApi.invoke.mockClear()
  windowApi.subscribe.mockClear()
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

describe('后台错误只属于发起它的线程', () => {
  it('空白创建 reject 时已打开 B：不写 B 的错误/重试，也不把 A 文本发到 B', async () => {
    const pendingCreate = deferred<Awaited<ReturnType<typeof api.createThread>>>()
    const pendingB = deferred<Awaited<ReturnType<typeof api.loadThread>>>()
    api.createThread.mockReturnValueOnce(pendingCreate.promise)
    api.loadThread.mockReturnValueOnce(pendingB.promise)

    expect(store.sendChatMessage('A 的问题')).toBe(true)
    store.openChatThread('t-existing')
    pendingCreate.reject(new Error('ipc down'))
    await vi.waitFor(() => expect(store.getChatStore().busy).toBe(false))

    expect(store.getChatStore().currentId).toBe('t-existing')
    expect(store.getChatStore().error).toBeNull()
    expect(store.getChatStore().canRetry).toBe(false)
    store.retryChat()
    expect(api.createThread).toHaveBeenCalledTimes(1)
    expect(api.askThread).not.toHaveBeenCalled()
  })

  it('空白创建 reject 且仍归当前空白页：保留可重试错误，重试重新创建', async () => {
    const pendingCreate = deferred<Awaited<ReturnType<typeof api.createThread>>>()
    api.createThread.mockReturnValueOnce(pendingCreate.promise)
    api.askThread.mockResolvedValueOnce({ status: 'missing' })

    expect(store.sendChatMessage('空白问题')).toBe(true)
    pendingCreate.reject(new Error('ipc down'))
    await vi.waitFor(() => expect(store.getChatStore().error).not.toBeNull())
    expect(store.getChatStore().canRetry).toBe(true)

    api.createThread.mockResolvedValueOnce({ status: 'created', thread: view('t-retry', []) })
    store.retryChat()
    await vi.waitFor(() => expect(api.createThread).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(api.askThread).toHaveBeenCalledTimes(1))
  })

  it('改口成功晚于打开 B：生成归 A，但 current 仍是 B', async () => {
    const threadA = editableThread('t-a')
    api.loadThread.mockResolvedValueOnce(threadA)
    store.openChatThread('t-a')
    await vi.waitFor(() => expect(store.getChatStore().currentId).toBe('t-a'))
    store.beginEditLastQuestion()
    expect(store.getChatStore().editing?.questionId).toBe('q-old')

    const pendingEdit = deferred<Awaited<ReturnType<typeof api.editThreadQuestion>>>()
    const pendingB = deferred<Awaited<ReturnType<typeof api.loadThread>>>()
    api.editThreadQuestion.mockReturnValueOnce(pendingEdit.promise)
    api.loadThread.mockReturnValueOnce(pendingB.promise)

    expect(store.submitEdit('改过的问题')).toBe(true)
    store.openChatThread('t-b')
    pendingB.resolve(editableThread('t-b'))
    await vi.waitFor(() => expect(store.getChatStore().current?.id).toBe('t-b'))
    pendingEdit.resolve({ status: 'asked', questionId: 'q-new', thread: editableThread('t-a') })
    await vi.waitFor(() =>
      expect(store.getChatStore().session.generation?.threadId).toBe('t-a')
    )

    expect(store.getChatStore().currentId).toBe('t-b')
    expect(store.getChatStore().current?.id).toBe('t-b')
    expect(store.getChatStore().error).toBeNull()
    expect(store.getChatStore().canRetry).toBe(false)
  })

  it('A 生成结束保存失败后已打开 B：B 无错误/重试，A 的内容留在待保存快照', async () => {
    const save = deferred<Awaited<ReturnType<typeof api.saveThreadAnswer>>>()
    api.createThread.mockResolvedValueOnce({ status: 'created', thread: questionThread('t-a') })
    api.askThread.mockResolvedValueOnce({
      status: 'asked',
      questionId: 'q-a',
      thread: questionThread('t-a')
    })
    api.saveThreadAnswer.mockReturnValueOnce(save.promise)

    store.setChatModel('model-original')
    store.ensureChatEvents()
    expect(store.sendChatMessage('A 问题')).toBe(true)
    await vi.waitFor(() => expect(windowApi.invoke).toHaveBeenCalled())
    const streamId = streamIdOfLastStart()
    // 模型在生成中被改掉，保存必须仍用发起时的快照。
    store.setChatModel('model-later')
    streamText(streamId, 'A 未保存正文')
    await vi.waitFor(() => expect(api.saveThreadAnswer).toHaveBeenCalledTimes(1))
    expect(api.saveThreadAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 't-a', questionId: 'q-a', model: 'model-original' })
    )

    api.loadThread.mockResolvedValueOnce(questionThread('t-b'))
    store.openChatThread('t-b')
    await vi.waitFor(() => expect(store.getChatStore().current?.id).toBe('t-b'))

    save.reject(new Error('ipc save down'))
    await vi.waitFor(() =>
      expect(store.getChatStore().pendingSaves['t-a']?.failure).not.toBeNull()
    )
    expect(store.getChatStore().currentId).toBe('t-b')
    expect(store.getChatStore().error).toBeNull()
    expect(store.getChatStore().canRetry).toBe(false)
    const pending = store.getChatStore().pendingSaves['t-a']
    expect(pending).toMatchObject({
      threadId: 't-a',
      questionId: 'q-a',
      text: 'A 未保存正文',
      displayText: 'A 未保存正文',
      model: 'model-original',
      retryable: true
    })
    expect(store.getChatStore().session.generation).toBeNull()

    // 重试只保存 A，不重新请求模型，也不动 B。
    api.loadThread.mockResolvedValueOnce(questionThread('t-a'))
    const retrySave = deferred<Awaited<ReturnType<typeof api.saveThreadAnswer>>>()
    api.saveThreadAnswer.mockReturnValueOnce(retrySave.promise)
    const retry = store.retryPendingSave('t-a')
    await vi.waitFor(() => expect(api.loadThread).toHaveBeenCalledTimes(2))
    expect(api.saveThreadAnswer).toHaveBeenCalledTimes(2)
    expect(api.saveThreadAnswer.mock.calls[1]?.[0]).toMatchObject({
      threadId: 't-a',
      questionId: 'q-a',
      text: 'A 未保存正文',
      model: 'model-original'
    })

    retrySave.resolve({ status: 'saved', thread: questionThread('t-a') })
    await retry
    expect(store.getChatStore().pendingSaves['t-a']).toBeUndefined()
    expect(store.getChatStore().currentId).toBe('t-b')
    expect(store.getChatStore().error).toBeNull()
    expect(
      windowApi.invoke.mock.calls.filter(([channel]) => channel === 'chat:start')
    ).toHaveLength(1)
  })

  it('当前 A 保存失败：A 看到待保存快照，重试成功后同一线程更新', async () => {
    const save = deferred<Awaited<ReturnType<typeof api.saveThreadAnswer>>>()
    api.createThread.mockResolvedValueOnce({ status: 'created', thread: questionThread('t-a') })
    api.askThread.mockResolvedValueOnce({
      status: 'asked',
      questionId: 'q-a',
      thread: questionThread('t-a')
    })
    api.saveThreadAnswer.mockReturnValueOnce(save.promise)
    store.ensureChatEvents()
    expect(store.sendChatMessage('当前 A 问题')).toBe(true)
    await vi.waitFor(() => expect(windowApi.invoke).toHaveBeenCalled())
    streamText(streamIdOfLastStart(), '当前 A 正文')
    await vi.waitFor(() => expect(api.saveThreadAnswer).toHaveBeenCalledTimes(1))
    save.reject(new Error('save down'))
    await vi.waitFor(() => expect(store.getChatStore().pendingSaves['t-a']).toBeDefined())
    expect(store.getChatStore().currentId).toBe('t-a')
    expect(store.getChatStore().error).toBeNull()

    api.loadThread.mockResolvedValueOnce(questionThread('t-a'))
    api.saveThreadAnswer.mockResolvedValueOnce({
      status: 'saved',
      thread: questionThread('t-a')
    })
    await store.retryPendingSave('t-a')
    expect(store.getChatStore().pendingSaves['t-a']).toBeUndefined()
    expect(store.getChatStore().currentId).toBe('t-a')
    expect(store.getChatStore().error).toBeNull()
  })

  it('A 的旧未保存回答不会被之后成功的新回答清掉', async () => {
    const firstSave = deferred<Awaited<ReturnType<typeof api.saveThreadAnswer>>>()
    api.createThread.mockResolvedValueOnce({ status: 'created', thread: questionThread('t-a') })
    api.askThread.mockResolvedValueOnce({
      status: 'asked',
      questionId: 'q-a',
      thread: questionThread('t-a')
    })
    api.saveThreadAnswer.mockReturnValueOnce(firstSave.promise)
    store.ensureChatEvents()
    expect(store.sendChatMessage('A 第一问')).toBe(true)
    await vi.waitFor(() => expect(windowApi.invoke).toHaveBeenCalled())
    streamText(streamIdOfLastStart(), '第一问未保存正文')
    await vi.waitFor(() => expect(api.saveThreadAnswer).toHaveBeenCalledTimes(1))
    firstSave.reject(new Error('first save down'))
    await vi.waitFor(() => expect(store.getChatStore().pendingSaves['t-a']).toBeDefined())

    // 用户没有先保存，就在 A 里继续问了第二问；第二问保存成功不能把第一问的未保存内容抹掉。
    const secondThread = questionThread('t-a', 'q-b')
    api.askThread.mockResolvedValueOnce({
      status: 'asked',
      questionId: 'q-b',
      thread: secondThread
    })
    api.saveThreadAnswer.mockResolvedValueOnce({ status: 'saved', thread: secondThread })
    expect(store.sendChatMessage('A 第二问')).toBe(true)
    await vi.waitFor(() => expect(api.askThread).toHaveBeenCalledTimes(2))
    streamText(streamIdOfLastStart(), '第二问已保存正文')
    await vi.waitFor(() => expect(api.saveThreadAnswer).toHaveBeenCalledTimes(2))

    expect(store.getChatStore().pendingSaves['t-a']).toMatchObject({
      text: '第一问未保存正文',
      questionId: 'q-a'
    })
    expect(store.getChatStore().current?.id).toBe('t-a')
  })

  it('保存返回 missing 时保留内容但不再给重试，B 不受影响', async () => {
    const save = deferred<Awaited<ReturnType<typeof api.saveThreadAnswer>>>()
    api.createThread.mockResolvedValueOnce({ status: 'created', thread: questionThread('t-a') })
    api.askThread.mockResolvedValueOnce({
      status: 'asked',
      questionId: 'q-a',
      thread: questionThread('t-a')
    })
    api.saveThreadAnswer.mockReturnValueOnce(save.promise)
    store.ensureChatEvents()
    expect(store.sendChatMessage('A 问题')).toBe(true)
    await vi.waitFor(() => expect(windowApi.invoke).toHaveBeenCalled())
    streamText(streamIdOfLastStart(), 'A 正文')

    api.loadThread.mockResolvedValueOnce(questionThread('t-b'))
    store.openChatThread('t-b')
    await vi.waitFor(() => expect(store.getChatStore().current?.id).toBe('t-b'))
    save.resolve({ status: 'missing' })
    await vi.waitFor(() => expect(store.getChatStore().pendingSaves['t-a']).toBeDefined())

    expect(store.getChatStore().pendingSaves['t-a']).toMatchObject({
      retryable: false,
      text: 'A 正文'
    })
    expect(store.getChatStore().error).toBeNull()
    expect(store.getChatStore().canRetry).toBe(false)
  })

  it('重试前读回发现 A 其实已保存：清掉快照，不重复 append', async () => {
    const save = deferred<Awaited<ReturnType<typeof api.saveThreadAnswer>>>()
    api.createThread.mockResolvedValueOnce({ status: 'created', thread: questionThread('t-a') })
    api.askThread.mockResolvedValueOnce({
      status: 'asked',
      questionId: 'q-a',
      thread: questionThread('t-a')
    })
    api.saveThreadAnswer.mockReturnValueOnce(save.promise)
    store.ensureChatEvents()
    expect(store.sendChatMessage('A 问题')).toBe(true)
    await vi.waitFor(() => expect(windowApi.invoke).toHaveBeenCalled())
    streamText(streamIdOfLastStart(), 'A 正文')
    await vi.waitFor(() => expect(api.saveThreadAnswer).toHaveBeenCalledTimes(1))
    save.reject(new Error('reply lost'))
    await vi.waitFor(() => expect(store.getChatStore().pendingSaves['t-a']).toBeDefined())

    // IPC 回复丢了，但库里已经有这一版回答。
    api.loadThread.mockResolvedValueOnce(answeredThread('t-a'))
    await store.retryPendingSave('t-a')
    expect(store.getChatStore().pendingSaves['t-a']).toBeUndefined()
    expect(api.saveThreadAnswer).toHaveBeenCalledTimes(1)
  })

  it('继续生成保存失败也保留 A 的完整展示文本，并可用原模型重试', async () => {
    const save = deferred<Awaited<ReturnType<typeof api.saveThreadContinuation>>>()
    api.loadThread.mockResolvedValueOnce(answeredThread('t-a'))
    api.saveThreadContinuation.mockReturnValueOnce(save.promise)
    store.openChatThread('t-a')
    await vi.waitFor(() => expect(store.getChatStore().current?.id).toBe('t-a'))
    store.setChatModel('continuation-model')
    store.ensureChatEvents()
    store.continueLastAnswer()
    const streamId = streamIdOfLastStart()
    streamText(streamId, '续写正文')
    await vi.waitFor(() => expect(api.saveThreadContinuation).toHaveBeenCalledTimes(1))

    api.loadThread.mockResolvedValueOnce(answeredThread('t-b'))
    store.openChatThread('t-b')
    await vi.waitFor(() => expect(store.getChatStore().current?.id).toBe('t-b'))
    save.reject(new Error('continue save down'))
    await vi.waitFor(() => expect(store.getChatStore().pendingSaves['t-a']).toBeDefined())

    expect(store.getChatStore().pendingSaves['t-a']).toMatchObject({
      mode: 'continue',
      answerId: 'a-root',
      displayText: '已有正文续写正文',
      model: 'continuation-model',
      retryable: true
    })
    api.loadThread.mockResolvedValueOnce(answeredThread('t-a'))
    api.saveThreadContinuation.mockResolvedValueOnce({
      status: 'saved',
      thread: answeredThread('t-a')
    })
    await store.retryPendingSave('t-a')
    expect(api.saveThreadContinuation.mock.calls[1]?.[0]).toMatchObject({
      threadId: 't-a',
      answerId: 'a-root',
      text: '续写正文',
      model: 'continuation-model'
    })
    expect(store.getChatStore().currentId).toBe('t-b')
    expect(store.getChatStore().error).toBeNull()
  })

  it('改口失败晚于打开 B：不写 B 的错误/重试', async () => {
    api.loadThread.mockResolvedValueOnce(editableThread('t-a'))
    store.openChatThread('t-a')
    await vi.waitFor(() => expect(store.getChatStore().currentId).toBe('t-a'))
    store.beginEditLastQuestion()

    const pendingEdit = deferred<Awaited<ReturnType<typeof api.editThreadQuestion>>>()
    api.editThreadQuestion.mockReturnValueOnce(pendingEdit.promise)
    api.loadThread.mockReturnValueOnce(deferred<Awaited<ReturnType<typeof api.loadThread>>>().promise)
    expect(store.submitEdit('改过的问题')).toBe(true)
    store.openChatThread('t-b')
    pendingEdit.reject(new Error('edit down'))
    await vi.waitFor(() => expect(store.getChatStore().busy).toBe(false))

    expect(store.getChatStore().currentId).toBe('t-b')
    expect(store.getChatStore().error).toBeNull()
    expect(store.getChatStore().canRetry).toBe(false)
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
