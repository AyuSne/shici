import { useSyncExternalStore } from 'react'
import type { ChatError, ChatStreamUpdate } from '../../../shared/chat'
import {
  GROUP_WORD_LIMIT,
  deduplicateArticleContext,
  type ChatThreadView,
  type CreateThreadRequest,
  type PackArticleWordsResult,
  type SaveAnswerResult,
  type ThreadContextItem,
  type ThreadListItem
} from '../../../shared/threads'
import {
  askThread,
  createGroupThread,
  createThread,
  deleteThread,
  editThreadQuestion,
  loadThread,
  loadThreads,
  openThreadForMainRequest,
  packArticleWords,
  saveThreadAnswer,
  saveThreadContinuation,
  switchThreadAnswer,
  switchThreadQuestion,
  updateThreadContext
} from '../api'
import { failureText } from '../errors'
import { forgetChatThread, navigate, replaceRoute } from '../navigate'
import { clearThreadViewState } from '../view-state'
import {
  chatSessionReducer,
  initialChatSession,
  type ChatSessionAction,
  type ChatSessionState,
  type LiveGeneration
} from './session'
import { buildMessages, lastTurn, summarizeContext, threadSystemPrompt, type GenerationMode } from './turns'

/**
 * 对话页的状态：对话列表、当前对话、正在生成的一条与改口草稿。
 * 生成事件跟着整个应用走，切到别的页面再回来也不会丢；回答要到结束时才落库。
 */

export type ChatStoreState = {
  threads: readonly ThreadListItem[]
  current: ChatThreadView | null
  currentId: string | null
  session: ChatSessionState
  /** 正在改上一条提问；null 表示没在改。 */
  editing: { questionId: string; text: string } | null
  /** 打开对话与提交问题之间的空隙，避免连按两次发出两条。 */
  busy: boolean
  loading: boolean
  deletingThreadId: string | null
  error: string | null
  /** 这条错误有下一步可执行的动作；没有时界面不显示「再试一次」。 */
  canRetry: boolean
  /** 已生成完但还没写进库的回答；按线程保存，切走再回来仍可看/重试保存。 */
  pendingSaves: Readonly<Record<string, PendingSave>>
  /** 正在重试保存的线程；同一时刻只允许一个保存动作。 */
  savingPendingThread: string | null
}

/**
 * 一条已经生成完、但落库失败的回答快照。它不是流状态：没有 status/live 事件，
 * 只保留把同一份内容重新交给保存接口所需的数据；重试绝不重新请求模型。
 */
export type PendingSave = {
  threadId: string
  /** 发起生成时的流身份；只有同一次生成的成功才能清掉这份快照。 */
  streamId: string
  mode: 'answer' | 'continue'
  questionId: string | null
  answerId: string | null
  /** 这次需要写进库的新正文/思考（继续生成时不含底稿）。 */
  text: string
  thinking: string
  thinkingMs: number
  phase: 'done' | 'stopped' | 'error'
  error: ChatError | null
  /** 生成时的模型快照，不随后来的默认模型改变。 */
  model: string
  /** 界面展示用：继续生成时把底稿接在前面。 */
  displayText: string
  displayThinking: string
  /** 上一次保存失败的可读原因；null 表示还没试过保存。 */
  failure: string | null
  /** 是否还值得重试；线程/原提问已消失时不再复活。 */
  retryable: boolean
}

const initialState: ChatStoreState = {
  threads: [],
  current: null,
  currentId: null,
  session: initialChatSession,
  editing: null,
  busy: false,
  loading: false,
  deletingThreadId: null,
  error: null,
  canRetry: false,
  pendingSaves: {},
  savingPendingThread: null
}

let state: ChatStoreState = initialState
const listeners = new Set<() => void>()
let connected = false
let persisting: string | null = null
/** 当前这条错误对应的重试动作；load 错误重读，操作错误重放那一次操作。 */
let retryAction: (() => void) | null = null
/** 当前配置的模型名；回答落库时记进条目，钉住出处才有据可查。 */
let chatModel = ''
/** 上下文改动连点时只认最后一次返回；界面先按本地算的摘要往前走。 */
let contextSequence = 0
let threadListSequence = 0
/** 「用这些词学习」的调用序号；取消、离开或再开一次都会让旧结果失效。 */
let groupOpenSequence = 0
/** 「本篇未整理词打包」的调用序号；换文章 / 离开工作台后旧结果不得再导航。 */
let packOpenSequence = 0
const deletedThreads = new Set<string>()

export function isDeletedChatThread(threadId: string): boolean {
  return deletedThreads.has(threadId)
}

export function canDeleteChatThread(store: ChatStoreState, threadId: string): boolean {
  return !store.busy && store.deletingThreadId === null &&
    store.session.generation?.threadId !== threadId
}

function currentThreadBeingDeleted(): boolean {
  return state.deletingThreadId !== null && state.deletingThreadId === state.currentId
}

export function getChatStore(): ChatStoreState {
  return state
}

export function subscribeChat(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function emit(): void {
  for (const listener of [...listeners]) {
    listener()
  }
}

function set(patch: Partial<ChatStoreState>): void {
  state = { ...state, ...patch }
  emit()
}

function dispatchSession(action: ChatSessionAction): void {
  const session = chatSessionReducer(state.session, action)
  if (session === state.session) {
    return
  }
  state = { ...state, session }
  emit()
}

function clearError(): void {
  retryAction = null
  set({ error: null, canRetry: false })
}

/** 记下一条错误与它的重试动作；没有可重放的动作就不显示重试按钮。 */
function fail(
  error: unknown,
  fallback: string,
  retry: (() => void) | null
): void {
  retryAction = retry
  set({ error: failureText(error, fallback), canRetry: retry !== null })
}

/** 页面级错误的「再试一次」：重放当时失败的那一步，而不是一律重读对话。 */
export function retryChat(): void {
  const action = retryAction
  if (action === null) return
  clearError()
  action()
}

export function useChatStore(): ChatStoreState {
  return useSyncExternalStore(subscribeChat, getChatStore, getChatStore)
}

/** 启动时把当前模型名交给对话层；之后每次保存回答都带上。 */
export function setChatModel(model: string): void {
  chatModel = model.trim()
}

/** 还有一条没落完库的回答时，不发新请求，也不切版本。 */
function generationPending(): boolean {
  return state.session.generation !== null
}

/**
 * 事件订阅跟随整个应用生命周期：切到别的页面再回来，正在生成的回答也不会丢。
 */
export function ensureChatEvents(): void {
  if (connected) {
    return
  }
  connected = true
  window.api.subscribe('chat:event', (update: ChatStreamUpdate) => {
    dispatchSession({
      type: 'stream',
      streamId: update.streamId,
      event: update.event,
      now: Date.now()
    })
    void maybePersistGeneration()
  })
}

/* ---------- 打开对话与列表 ---------- */

/**
 * 切换到一条已经拿到的对话。打开新对话时清掉上一条对话的编辑态，并让还在路上的
 * 旧上下文请求失效；同一对话被再次打开时保留它自己的编辑草稿。
 */
function activateThread(view: ChatThreadView): void {
  ++contextSequence
  retryAction = null
  state = {
    ...state,
    currentId: view.id,
    current: view,
    editing: state.currentId === view.id ? state.editing : null,
    loading: false,
    error: null,
    canRetry: false
  }
  emit()
}

export function openChatThread(threadId: string | null): void {
  // 打开一条已有线程（或空白线程）也是一次真实的对话意图：在途的主对象打开
  // 必须立刻过期，不能等它的 IPC 回来再抢走当前对话。
  claimConversationIntent()
  if (threadId === state.currentId && state.current !== null) {
    void refreshThreads()
    return
  }

  retryAction = null
  state = {
    ...state,
    currentId: threadId,
    current: null,
    editing: null,
    error: null,
    canRetry: false,
    loading: threadId !== null
  }
  contextSequence += 1
  emit()
  void refreshThreads()

  if (threadId === null) {
    return
  }
  void loadThread(threadId).then(
    (view) => {
      if (state.currentId !== threadId) return
      if (view === null) {
        forgetDeletedThread(threadId)
        return
      }
      set({ current: view, loading: false })
    },
    (error: unknown) => {
      if (state.currentId !== threadId) return
      set({ loading: false })
      fail(error, '这条对话没有读出来。', () => openChatThread(threadId))
    }
  )
}

/**
 * 路由同步：只有地址真的切到另一条对话/对象时才当成用户打开。
 * ChatPage mount 对同一条 route 再调用一次不是新的对话意图，不能取消正在
 * create/ask 的空白首问；显式「新的学习」走 openChatThread(null) 主动 claim。
 */
export function syncChatThread(threadId: string | null): void {
  if (threadId === state.currentId) {
    void refreshThreads()
    return
  }
  openChatThread(threadId)
}

export function refreshThreads(): Promise<void> {
  const sequence = ++threadListSequence
  return loadThreads().then(
    (listing) => {
      if (sequence === threadListSequence) set({ threads: listing.threads })
    },
    (error: unknown) => {
      if (sequence === threadListSequence) fail(error, '对话没有读出来。', () => {
        void refreshThreads()
      })
    }
  )
}

function forgetDeletedThread(threadId: string): void {
  deletedThreads.add(threadId)
  clearPendingSave(threadId)
  ++threadListSequence
  clearThreadViewState(threadId)
  const threads = state.threads.filter((thread) => thread.id !== threadId)
  if (state.currentId === threadId) {
    ++contextSequence
    retryAction = null
    set({ threads, currentId: null, current: null, editing: null, loading: false, error: null, canRetry: false })
  } else {
    set({ threads })
  }
  if (forgetChatThread(threadId)) clearThreadViewState(null)
  void refreshThreads()
}

export async function removeChatThread(threadId: string): Promise<boolean> {
  if (!canDeleteChatThread(state, threadId)) return false
  set({ deletingThreadId: threadId })
  try {
    const result = await deleteThread(threadId)
    if (result.status === 'busy') return false
    forgetDeletedThread(threadId)
    return true
  } finally {
    set({ deletingThreadId: null })
  }
}

/** 共享打开操作的调用方；全部取消后，晚到的结果不能激活/报错去污染新对话。 */
type OpenClaimants = {
  signals: (AbortSignal | null)[]
  /** 新的有效调用方加入时，把共享数据的展示意图推进到最新。 */
  reclaim: () => void
}

/** 一次操作自己是否还有有效调用方，以及它是否仍是最新意图。 */
type OpenOwnership = {
  isLive: () => boolean
  isLatest: () => boolean
}

const openingThreads = new Map<string, { promise: Promise<string | null>; claimants: OpenClaimants }>()
/**
 * 一次「用户现在要看哪条对话」的意图。所有真实打开入口（已有线程、主对象、
 * 组词、打包、空白线程）都推进它；晚到的旧请求因此不能再激活/导航/报错。
 */
let conversationIntentSequence = 0

function claimConversationIntent(): number {
  conversationIntentSequence += 1
  return conversationIntentSequence
}

function intentIsCurrent(intent: number): boolean {
  return intent === conversationIntentSequence
}

function liveClaimant(claimants: OpenClaimants): boolean {
  return claimants.signals.some((signal) => signal === null || !signal.aborted)
}

type OpenThreadOptions = {
  forceNew?: boolean
  ensureSentenceContext?: boolean
  contextItem?: ThreadContextItem
  /**
   * 就地打开：仍在同一份 store 里激活线程、沿用同一套生成事件、停止与落库，
   * 只是不跳去对话页。迷你轻问抽屉用它；默认（false）保持完整对话页语义。
   */
  openInPlace?: boolean
  /**
   * 这次调用方的所有权。取消只让这一个调用方拿到 null，不会撤销另一个
   * 仍然有效的同对象请求；也不阻止已共享的操作完成激活。
   */
  signal?: AbortSignal
}

/** 从词条、原句或文章打开最近对话；明确要求时新开一条。 */
export function openThreadForMain(
  main: CreateThreadRequest['main'],
  options: OpenThreadOptions = {}
): Promise<string | null> {
  const signal = options.signal ?? null
  if (main.kind === 'none') {
    const intent =
      signal !== null && signal.aborted
        ? conversationIntentSequence
        : claimConversationIntent()
    const ownership: OpenOwnership = {
      isLive: () => signal === null || !signal.aborted,
      isLatest: () => intentIsCurrent(intent)
    }
    const pending = openMainThread(main, options, ownership)
    if (signal === null) return pending
    return pending.then((threadId) => (signal.aborted ? null : threadId))
  }
  // presentation 必须进 key：就地抽屉与完整对话页对同一个主对象是两种意图，
  // 不能让其中一个的导航被另一个吞掉，也不能互相取消。
  const key = JSON.stringify({
    main,
    forceNew: options.forceNew === true,
    ensureSentenceContext: options.ensureSentenceContext === true,
    contextItem: options.contextItem,
    openInPlace: options.openInPlace === true
  })
  let opening = openingThreads.get(key)
  if (opening === undefined) {
    const validAtStart = signal === null || !signal.aborted
    // 已取消的调用方不能抢占当前意图；它只作为共享数据的一个（无效）claimant。
    let intent = validAtStart ? claimConversationIntent() : conversationIntentSequence
    const claimants: OpenClaimants = {
      signals: [signal],
      reclaim: () => {
        intent = claimConversationIntent()
      }
    }
    const ownership: OpenOwnership = {
      isLive: () => liveClaimant(claimants),
      isLatest: () => intentIsCurrent(intent)
    }
    const promise = openMainThread(main, options, ownership).finally(() => {
      openingThreads.delete(key)
    })
    opening = { promise, claimants }
    openingThreads.set(key, opening)
  } else {
    // 同一次共享操作多了一个调用方：它取消不影响另一个仍有效的人。
    // 没有 signal 的调用方按「始终有效」记一个 null，不能因为前一个调用方取消就算全取消。
    opening.claimants.signals.push(signal)
    // 新 valid claimant 重新打开同一主对象，是最新的展示意图；旧 operation 的
    // captured intent 不能一直压住它。已 abort 的调用方不得抢 intent。
    if (signal === null || !signal.aborted) opening.claimants.reclaim()
  }
  const pending = opening.promise
  if (signal === null) return pending
  // 共享操作照常完成；取消方只是不认领这次结果，另一次有效调用仍能拿到线程。
  return pending.then((threadId) => (signal.aborted ? null : threadId))
}

async function openMainThread(
  main: CreateThreadRequest['main'],
  options: OpenThreadOptions,
  ownership: OpenOwnership
): Promise<string | null> {
  try {
    const result = await openThreadForMainRequest({ main, forceNew: options.forceNew, ensureSentenceContext: options.ensureSentenceContext })
    // 所有调用方都取消，或者更新的打开意图已经接管：数据操作可以做完，
    // 但旧结果不许激活线程、导航或把错误写进新对话的界面。
    if (!ownership.isLive()) return null
    if (result.status === 'rejected') {
      if (!ownership.isLatest()) return null
      const message = result.reason === 'context-full'
        ? '这条对话的上下文已满。请新开一条，或先到对话页移除部分上下文。'
        : '关联的内容已删除，没能开对话。'
      fail(message, message, null)
      return null
    }
    if (isDeletedChatThread(result.thread.id)) return null
    let thread = result.thread
    if (options.contextItem) {
      const saved = await updateThreadContext({ threadId: thread.id, items: [...thread.context, options.contextItem] })
      if (!ownership.isLive()) return null
      if (saved.status !== 'saved') {
        if (ownership.isLatest()) fail('摘录没有带上，再试一次。', '摘录没有带上，再试一次。', null)
        return null
      }
      thread = saved.thread
    }
    if (ownership.isLive() && ownership.isLatest()) {
      activateThread(thread)
      // 就地打开只换当前线程；完整对话页仍然是原来的跳转语义。
      if (options.openInPlace !== true) {
        navigate('chat', { threadId: thread.id })
      }
      return thread.id
    }
    // 过期/被别的入口接管的操作不返回成功 id：调用方不能拿它去开一个
    // 与当前真正激活的对话不同的 UI。
    return null
  } catch (error) {
    if (!ownership.isLive() || !ownership.isLatest()) return null
    fail(error, '没能开对话，再试一次。', () => {
      void openThreadForMain(main, options)
    })
    return null
  }
}

/* ---------- 发送与生成 ---------- */

/** 提问被拒时的说法；上下文超词数与空提问不是同一件事。 */
function questionRejectText(reason: 'empty' | 'too-many-words'): string {
  return reason === 'too-many-words'
    ? `一条对话最多带 ${GROUP_WORD_LIMIT} 个词，先移除一个再发。`
    : '这条提问是空的。'
}

/* ---------- 用一组词学习 ---------- */

function groupThreadRejectText(reason: 'empty' | 'missing-word' | 'too-many-words'): string {
  switch (reason) {
    case 'empty':
      return '先选几个词再开始。'
    case 'too-many-words':
      return `一次最多选 ${GROUP_WORD_LIMIT} 个词。`
    case 'missing-word':
      return '有词条已经不在了，刷新词条列表后再试。'
  }
}

/**
 * 「用这些词学习」：每次都新开一条无主对象的对话，绝不复用旧的空白或组词对话。
 * 打开后跳到对话页；失败时把原因写在 store 里，由调用方就地提示。
 */
export async function openGroupThread(
  entryIds: readonly string[],
  options: { signal?: AbortSignal } = {}
): Promise<string | null> {
  const ids = [...new Set(entryIds.map((id) => id.trim()).filter((id) => id !== ''))]
  if (ids.length === 0) {
    fail('先选几个词再开始。', '先选几个词再开始。', null)
    return null
  }
  // caller 取消、离开页面或开始下一次尝试都会推进序号；迟到的结果不许再改当前状态。
  const operation = ++groupOpenSequence
  const intent =
    options.signal?.aborted === true ? conversationIntentSequence : claimConversationIntent()
  const isCurrent = (): boolean =>
    operation === groupOpenSequence &&
    intentIsCurrent(intent) &&
    options.signal?.aborted !== true
  try {
    const result = await createGroupThread({ entryIds: ids })
    if (!isCurrent()) return null
    if (result.status === 'rejected') {
      const message = groupThreadRejectText(result.reason)
      fail(message, message, null)
      return null
    }
    activateThread(result.thread)
    navigate('chat', { threadId: result.thread.id })
    return result.thread.id
  } catch (error) {
    if (!isCurrent()) return null
    fail(error, '没能用这些词开对话，再试一次。', () => {
      void openGroupThread(ids)
    })
    return null
  }
}

/**
 * 「把本篇未整理学习内容的词打包问模型」：只读筛选与组线程都在主进程完成，
 * 创建成功才激活并跳去对话页；没有可打包的词时原样返回 empty，由工作台温和提示。
 * `onCreated` 在跳转之后、页面卸载之前执行，调用方据此给出一条跟得过去的回执。
 * 取消 / 换文章 / 离开工作台后迟到的结果不再导航。
 */
export async function openArticlePackThread(
  articleId: string,
  options: {
    signal?: AbortSignal
    onCreated?: (result: Extract<PackArticleWordsResult, { status: 'created' }>) => void
  } = {}
): Promise<PackArticleWordsResult | null> {
  const operation = ++packOpenSequence
  const intent =
    options.signal?.aborted === true ? conversationIntentSequence : claimConversationIntent()
  const isCurrent = (): boolean =>
    operation === packOpenSequence &&
    intentIsCurrent(intent) &&
    options.signal?.aborted !== true
  try {
    const result = await packArticleWords({ articleId })
    if (!isCurrent()) return null
    if (result.status === 'created') {
      activateThread(result.thread)
      navigate('chat', { threadId: result.thread.id })
      options.onCreated?.(result)
    }
    return result
  } catch (error) {
    if (!isCurrent()) return null
    fail(error, '没能把本篇的词打包问模型，再试一次。', () => {
      void openArticlePackThread(articleId)
    })
    return null
  }
}

/** 空白对话选材料时先创建对话，以便持久化所选上下文。 */
export async function ensureBlankContextThread(): Promise<ChatThreadView | null> {
  if (state.current) return state.current
  const intent = claimConversationIntent()
  try {
    const result = await createThread({ main: { kind: 'none' } })
    if (!intentIsCurrent(intent)) return null
    if (result.status !== 'created') return null
    set({ current: result.thread, currentId: result.thread.id })
    replaceRoute('chat', { threadId: result.thread.id })
    void refreshThreads()
    return result.thread
  } catch (error) {
    if (!intentIsCurrent(intent)) return null
    fail(error, '没能新建对话，再试一次。', null)
    return null
  }
}

/** 当前线程还有未保存回答时，先保存，不继续推进对话分支。 */
function pendingOnCurrent(): boolean {
  return state.currentId !== null && state.pendingSaves[state.currentId] !== undefined
}

export function sendChatMessage(raw: string): boolean {
  const text = raw.trim()
  if (
    text === '' ||
    generationPending() ||
    state.busy ||
    pendingOnCurrent() ||
    currentThreadBeingDeleted() ||
    state.editing !== null
  ) {
    return false
  }
  set({ busy: true })
  clearError()
  void submitQuestion(text)
  return true
}

async function submitQuestion(text: string): Promise<void> {
  const intentAtStart = conversationIntentSequence
  let blankIntent: number | null = null
  let errorThreadId: string | null = null
  const presentationOwned = (): boolean =>
    blankIntent === null
      ? intentAtStart === conversationIntentSequence
      : intentIsCurrent(blankIntent)
  // 路由挂载会对同一条线程再调一次 openChatThread，推进全局意图；这不是
  // 「用户切到了别的对话」。只要线程仍是当前线程，更新它自己的 turn 就不算劫持。
  const ownsThread = (threadId: string): boolean =>
    presentationOwned() || state.currentId === threadId
  try {
    let view = state.current
    if (view === null) {
      // 空白线程的第一问本身就是一次新的对话意图；但创建出来之后即使用户
      // 已经切到 B，问题与回答仍归 A，只放弃把 A 摆到当前界面上。
      blankIntent = claimConversationIntent()
      const created = await createThread({ main: { kind: 'none' } })
      if (created.status !== 'created') {
        set({ busy: false })
        if (presentationOwned()) {
          fail('没能新建对话。', '没能新建对话，再试一次。', () => {
            set({ busy: true })
            void submitQuestion(text)
          })
        }
        return
      }
      view = created.thread
      // 显式新的空白对话是比旧 create 更新的意图；旧 A 只能留在后台数据/生成。
      if (presentationOwned()) {
        set({ current: view, currentId: view.id })
        replaceRoute('chat', { threadId: view.id })
      }
    }
    errorThreadId = view.id

    const asked = await askThread({ threadId: view.id, text, context: view.context })
    if (asked.status !== 'asked') {
      set({ busy: false })
      if (ownsThread(view.id)) {
        fail(
          asked.status === 'rejected' ? questionRejectText(asked.reason) : '这条对话已经不在了。',
          '这条提问没有发出去。',
          asked.status === 'rejected'
            ? null
            : () => {
                set({ busy: true })
                void submitQuestion(text)
              }
        )
      }
      return
    }
    // 过期只代表不再展示 A：提问已经写进 A，回答生成仍归属 A，B 的正文不被改写。
    if (ownsThread(asked.thread.id)) {
      set({ current: asked.thread, busy: false })
    } else {
      set({ busy: false })
    }
    void refreshThreads()
    startGeneration(asked.thread, { kind: 'answer' }, {
      mode: 'answer',
      questionId: asked.questionId,
      answerId: null,
      baseText: '',
      baseThinking: '',
      baseThinkingMs: 0
    })
  } catch (error) {
    set({ busy: false })
    // 空白创建还没返回 id：用这次空白意图和当前线程判归属。已经切到 B 时
    // 连错误/重试都不该出现，更不能让重试把 A 的文本发进 B。
    const ownsError =
      errorThreadId === null ? presentationOwned() : ownsThread(errorThreadId)
    if (ownsError) {
      fail(error, '这次提问没有发出去，再试一次。', () => {
        set({ busy: true })
        void submitQuestion(text)
      })
    }
  }
}

export function stopChat(): void {
  const generation = state.session.generation
  if (!generation || generation.status !== 'live') {
    return
  }
  dispatchSession({ type: 'stop', now: Date.now() })
  void window.api.invoke('chat:stop', { streamId: generation.streamId }).catch(() => undefined)
  void maybePersistGeneration()
}

/** 重新生成上一条回答：同一提问下多出一个版本，旧版仍在。 */
export function regenerateLastAnswer(): void {
  const view = state.current
  if (
    view === null ||
    generationPending() ||
    state.busy ||
    pendingOnCurrent() ||
    currentThreadBeingDeleted()
  ) {
    return
  }
  const turn = lastTurn(view)
  if (!turn) {
    return
  }
  startGeneration(view, { kind: 'regenerate', questionId: turn.question.id }, {
    mode: 'answer',
    questionId: turn.question.id,
    answerId: null,
    baseText: '',
    baseThinking: '',
    baseThinkingMs: 0
  })
}

/** 继续生成：新的正文接在当前回答这一路后面，不产生新版本。 */
export function continueLastAnswer(): void {
  const view = state.current
  if (
    view === null ||
    generationPending() ||
    state.busy ||
    pendingOnCurrent() ||
    currentThreadBeingDeleted()
  ) {
    return
  }
  const answer = lastTurn(view)?.answer
  if (!answer) {
    return
  }
  startGeneration(view, { kind: 'continue' }, {
    mode: 'continue',
    questionId: null,
    answerId: answer.id,
    baseText: answer.text,
    baseThinking: answer.thinking,
    baseThinkingMs: answer.thinkingMs
  })
}

function startGeneration(
  view: ChatThreadView,
  mode: GenerationMode,
  target: {
    mode: 'answer' | 'continue'
    questionId: string | null
    answerId: string | null
    baseText: string
    baseThinking: string
    baseThinkingMs: number
  }
): void {
  const streamId = newId()
  dispatchSession({
    type: 'begin',
    threadId: view.id,
    streamId,
    mode: target.mode,
    questionId: target.questionId,
    answerId: target.answerId,
    baseText: target.baseText,
    baseThinking: target.baseThinking,
    baseThinkingMs: target.baseThinkingMs,
    now: Date.now(),
    model: chatModel
  })

  const systemPrompt = threadSystemPrompt(view.context)
  const payload = {
    streamId,
    threadId: view.id,
    messages: buildMessages(view, mode),
    ...(systemPrompt === null ? {} : { systemPrompt })
  }
  window.api.invoke('chat:start', payload).then(
    (result) => {
      if (!result.accepted) {
        failStream(streamId)
      }
    },
    () => failStream(streamId)
  )
}

function failStream(streamId: string): void {
  dispatchSession({
    type: 'stream',
    streamId,
    event: { type: 'error', error: { code: 'unknown' } },
    now: Date.now()
  })
  void maybePersistGeneration()
}

/* ---------- 落库 ---------- */

async function maybePersistGeneration(): Promise<void> {
  const generation = state.session.generation
  if (!generation || generation.status !== 'finishing') {
    return
  }
  if (persisting === generation.streamId) {
    return
  }
  persisting = generation.streamId
  try {
    await persistGeneration(generation)
  } finally {
    if (persisting === generation.streamId) {
      persisting = null
    }
  }
}

async function persistGeneration(generation: LiveGeneration): Promise<void> {
  const phase = generation.terminal ?? (generation.error ? 'error' : 'done')
  // 落库的是这一段新写出来的内容；继续生成时底稿已经在库里，不再重复带上。
  const text = generation.text
  const thinking = generation.thinking
  const thinkingMs =
    generation.thinkingStartedAt !== null && generation.thinkingEndedAt !== null
      ? Math.max(0, generation.thinkingEndedAt - generation.thinkingStartedAt)
      : 0
  const pending: PendingSave = {
    threadId: generation.threadId,
    streamId: generation.streamId,
    mode: generation.mode,
    questionId: generation.questionId,
    answerId: generation.answerId,
    text,
    thinking,
    thinkingMs,
    phase,
    error: generation.error,
    model: generation.model,
    displayText: generation.mode === 'continue' ? generation.baseText + text : text,
    displayThinking:
      generation.mode === 'continue'
        ? [generation.baseThinking, thinking].filter((part) => part.trim() !== '').join('\n\n')
        : thinking,
    failure: null,
    retryable: true
  }

  try {
    const result =
      generation.mode === 'continue'
        ? await saveThreadContinuation({
            threadId: generation.threadId,
            answerId: generation.answerId ?? '',
            text,
            thinking,
            thinkingMs,
            phase,
            error: generation.error,
            model: generation.model,
            attemptId: generation.streamId
          })
        : await saveThreadAnswer({
            threadId: generation.threadId,
            questionId: generation.questionId ?? '',
            text,
            thinking,
            thinkingMs,
            phase,
            error: generation.error,
            model: generation.model,
            attemptId: generation.streamId
          })

    if (result.status === 'saved') {
      // 只有同一次生成的成功才清掉它的快照；A 里后来另一问的成功
      // 不能把先前仍未保存的回答一起抹掉。
      clearPendingSave(generation.threadId, generation.streamId)
      if (state.currentId === generation.threadId) {
        set({ current: result.thread })
      }
      void refreshThreads()
    } else {
      // 不把错误塞给当前 B；A 的未保存内容留在 per-thread 快照里，回到 A 可看可重试。
      rememberPendingSave({
        ...pending,
        failure: pendingSaveFailure(result),
        retryable: false
      })
    }
  } catch (error) {
    rememberPendingSave({
      ...pending,
      failure: failureText(error, '这条回答没能保存，重试保存。'),
      retryable: true
    })
  } finally {
    dispatchSession({ type: 'clear', streamId: generation.streamId })
  }
}

function rememberPendingSave(snapshot: PendingSave): void {
  // 同一线程只保留一份 pending（发送/生成已 gated）；不同 stream 的失败
  // 不能互相覆盖，更不能被后来的 clear 误删。
  const existing = state.pendingSaves[snapshot.threadId]
  if (existing !== undefined && existing.streamId !== snapshot.streamId) return
  set({ pendingSaves: { ...state.pendingSaves, [snapshot.threadId]: snapshot } })
}

function updatePendingSave(
  threadId: string,
  streamId: string,
  patch: Partial<PendingSave>
): void {
  const current = state.pendingSaves[threadId]
  if (current === undefined || current.streamId !== streamId) return
  set({ pendingSaves: { ...state.pendingSaves, [threadId]: { ...current, ...patch } } })
}

function clearPendingSave(threadId: string, streamId?: string): void {
  const current = state.pendingSaves[threadId]
  if (current === undefined) return
  if (streamId !== undefined && current.streamId !== streamId) return
  const next = { ...state.pendingSaves }
  delete next[threadId]
  set({ pendingSaves: next })
}

function pendingSaveFailure(
  result: Extract<SaveAnswerResult, { status: 'missing' | 'rejected' }>
): string {
  if (result.status === 'missing') {
    return '这条对话已经不在了，未保存的回答无法再写回。'
  }
  if (result.reason === 'conflict') {
    return '这次保存与已有记录冲突，原记录没有被改写；未保存内容仍留在本窗口，可复制到新对话。'
  }
  return '原提问或原回答已经不在了，未保存的回答无法再写回。'
}

/**
 * 重试保存捕获的 A 快照；绝不调用模型、绝不读写当前 B 的 turn/error。
 * 幂等由后端 attemptId 保证：同一 stream 重复保存不会 append 第二份。
 */
export async function retryPendingSave(threadId: string): Promise<void> {
  const pending = state.pendingSaves[threadId]
  if (pending === undefined || state.savingPendingThread !== null) return
  set({ savingPendingThread: threadId })
  try {
    const result =
      pending.mode === 'continue'
        ? await saveThreadContinuation({
            threadId,
            answerId: pending.answerId ?? '',
            text: pending.text,
            thinking: pending.thinking,
            thinkingMs: pending.thinkingMs,
            phase: pending.phase,
            error: pending.error,
            model: pending.model,
            attemptId: pending.streamId
          })
        : await saveThreadAnswer({
            threadId,
            questionId: pending.questionId ?? '',
            text: pending.text,
            thinking: pending.thinking,
            thinkingMs: pending.thinkingMs,
            phase: pending.phase,
            error: pending.error,
            model: pending.model,
            attemptId: pending.streamId
          })

    if (result.status === 'saved') {
      clearPendingSave(threadId, pending.streamId)
      if (state.currentId === threadId) set({ current: result.thread })
      void refreshThreads()
      return
    }
    updatePendingSave(threadId, pending.streamId, {
      failure: pendingSaveFailure(result),
      retryable: false
    })
  } catch (error) {
    updatePendingSave(threadId, pending.streamId, {
      failure: failureText(error, '这条回答没能保存，重试保存。'),
      retryable: true
    })
  } finally {
    if (state.savingPendingThread === threadId) set({ savingPendingThread: null })
  }
}

/* ---------- 版本与改口 ---------- */

/** 切到另一版回答；旧版里接下去的问与答留在库里，切回来还在。 */
export function switchAnswerVersion(questionId: string, answerId: string): void {
  const view = state.current
  if (
    view === null ||
    generationPending() ||
    state.busy ||
    pendingOnCurrent() ||
    currentThreadBeingDeleted()
  ) {
    return
  }
  void switchThreadAnswer({
    threadId: view.id,
    questionId,
    answerId
  }).then(
    (result) => {
      if (result.status === 'switched' && state.currentId === view.id) {
        set({ current: result.thread })
        clearError()
      }
    },
    (error: unknown) => {
      if (state.currentId === view.id) {
        fail(error, '切换回答版本没有完成，再试一次。', () => switchAnswerVersion(questionId, answerId))
      }
    }
  )
}

export function switchQuestionVersion(questionId: string): void {
  const view = state.current
  if (
    view === null ||
    generationPending() ||
    state.busy ||
    pendingOnCurrent() ||
    currentThreadBeingDeleted()
  ) {
    return
  }
  void switchThreadQuestion({ threadId: view.id, questionId }).then(
    (result) => {
      if (result.status === 'switched' && state.currentId === view.id) {
        set({ current: result.thread })
        clearError()
      }
    },
    (error: unknown) => {
      if (state.currentId === view.id) {
        fail(error, '切换提问版本没有完成，再试一次。', () => switchQuestionVersion(questionId))
      }
    }
  )
}

export function beginEditLastQuestion(): void {
  const view = state.current
  const turn = view === null ? null : lastTurn(view)
  if (turn === null || generationPending() || state.busy) {
    return
  }
  set({ editing: { questionId: turn.question.id, text: turn.question.text } })
}

export function cancelEdit(): void {
  if (state.editing === null) {
    return
  }
  set({ editing: null })
}

export function submitEdit(raw: string): boolean {
  const view = state.current
  const editing = state.editing
  const text = raw.trim()
  if (
    view === null ||
    editing === null ||
    text === '' ||
    generationPending() ||
    state.busy ||
    pendingOnCurrent() ||
    currentThreadBeingDeleted()
  ) {
    return false
  }
  set({ busy: true })
  clearError()
  void (async () => {
    try {
      const result = await editThreadQuestion({
        threadId: view.id,
        questionId: editing.questionId,
        text,
        context: view.context
      })
      if (result.status !== 'asked') {
        set({ busy: false })
        if (state.currentId === view.id) {
          fail(
            result.status === 'rejected'
              ? questionRejectText(result.reason)
              : '这条对话已经不在了。',
            '这次修改没有发出去。',
            result.status === 'rejected' ? null : () => submitEdit(text)
          )
        }
        return
      }
      // 改口已经写进 A；是否把 A 摆到界面上只看用户此刻是否还停在 A。
      if (state.currentId === view.id) {
        set({ current: result.thread, editing: null, busy: false })
      } else {
        set({ busy: false })
      }
      void refreshThreads()
      startGeneration(result.thread, { kind: 'answer' }, {
        mode: 'answer',
        questionId: result.questionId,
        answerId: null,
        baseText: '',
        baseThinking: '',
        baseThinkingMs: 0
      })
    } catch (error) {
      set({ busy: false })
      if (state.currentId === view.id) {
        fail(error, '这次修改没有发出去，再试一次。', () => submitEdit(text))
      }
    }
  })()
  return true
}

/* ---------- 上下文 ---------- */

export function addContextItems(items: readonly ThreadContextItem[]): void {
  const view = state.current
  if (view === null) return
  const ids = new Set(view.context.map((item) => item.id))
  const additions = items.filter((item) => !ids.has(item.id) && (ids.add(item.id), true))
  if (additions.length === 0) return
  changeContext(view, deduplicateArticleContext([...view.context, ...additions]))
}

export function addContextItem(item: ThreadContextItem): void {
  addContextItems([item])
}

export function removeContextItem(id: string): void {
  const view = state.current
  if (view === null) {
    return
  }
  changeContext(
    view,
    view.context.filter((item) => item.id !== id)
  )
}

function changeContext(view: ChatThreadView, items: ThreadContextItem[]): void {
  const sequence = ++contextSequence
  // 先按本地算的摘要显示，连点两下增删也不会互相盖掉；服务端返回后再对齐。
  set({ current: { ...view, context: items, contextSummary: summarizeContext(items) } })
  void updateThreadContext({ threadId: view.id, items }).then(
    (result) => {
      if (sequence !== contextSequence || state.currentId !== view.id) {
        return
      }
      if (result.status === 'saved') {
        set({ current: result.thread })
        clearError()
        return
      }
      if (result.status === 'rejected') {
        // 主进程边界拦下了超词数的上下文：把界面拉回已存下的那一份，并说清原因。
        fail(
          `一条对话最多带 ${GROUP_WORD_LIMIT} 个词。`,
          `一条对话最多带 ${GROUP_WORD_LIMIT} 个词，先移除一个再加。`,
          null
        )
        void loadThread(view.id).then(
          (latest) => {
            // 这次恢复读也必须服从发起时的上下文序号：等待期间用户可能已经成功改了上下文。
            if (
              sequence === contextSequence &&
              state.currentId === view.id &&
              latest !== null &&
              latest.id === view.id
            ) {
              set({ current: latest })
            }
          },
          () => undefined
        )
      }
    },
    (error: unknown) => {
      if (sequence === contextSequence) {
        fail(error, '这次上下文没有存上，再试一次。', () =>
          changeContext(view, items)
        )
      }
    }
  )
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
