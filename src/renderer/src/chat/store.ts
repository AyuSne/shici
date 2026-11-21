import { useSyncExternalStore } from 'react'
import type { ChatStreamUpdate } from '../../../shared/chat'
import {
  GROUP_WORD_LIMIT,
  deduplicateArticleContext,
  type ChatThreadView,
  type CreateThreadRequest,
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
 * 对话页的状态：线程列表、当前线程、正在生成的一条与改口草稿。
 * 生成事件跟着整个应用走，切到别的页面再回来也不会丢；回答要到结束时才落库。
 */

export type ChatStoreState = {
  threads: readonly ThreadListItem[]
  current: ChatThreadView | null
  currentId: string | null
  session: ChatSessionState
  /** 正在改上一条提问；null 表示没在改。 */
  editing: { questionId: string; text: string } | null
  /** 打开线程与提交问题之间的空隙，避免连按两次发出两条。 */
  busy: boolean
  loading: boolean
  deletingThreadId: string | null
  error: string | null
  /** 这条错误有下一步可执行的动作；没有时界面不显示「再试一次」。 */
  canRetry: boolean
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
  canRetry: false
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

/** 页面级错误的「再试一次」：重放当时失败的那一步，而不是一律重读线程。 */
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

/* ---------- 打开线程与列表 ---------- */

/**
 * 切换到一条已经拿到的线程。打开新线程时清掉上一条线程的编辑态，并让还在路上的
 * 旧上下文请求失效；同一线程被再次打开时保留它自己的编辑草稿。
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
      fail(error, '这条线程没有读出来。', () => openChatThread(threadId))
    }
  )
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

const openingThreads = new Map<string, Promise<string | null>>()
type OpenThreadOptions = { forceNew?: boolean; ensureSentenceContext?: boolean; contextItem?: ThreadContextItem }

/** 从词条、原句或文章打开最近线程；明确要求时新开一条。 */
export function openThreadForMain(
  main: CreateThreadRequest['main'],
  options: OpenThreadOptions = {}
): Promise<string | null> {
  if (main.kind === 'none') return openMainThread(main, options)
  const key = JSON.stringify({
    main,
    forceNew: options.forceNew === true,
    ensureSentenceContext: options.ensureSentenceContext === true,
    contextItem: options.contextItem
  })
  const pending = openingThreads.get(key)
  if (pending) return pending
  const operation = openMainThread(main, options).finally(() => openingThreads.delete(key))
  openingThreads.set(key, operation)
  return operation
}

async function openMainThread(
  main: CreateThreadRequest['main'],
  options: OpenThreadOptions
): Promise<string | null> {
  try {
    const result = await openThreadForMainRequest({ main, forceNew: options.forceNew, ensureSentenceContext: options.ensureSentenceContext })
    if (result.status === 'rejected') {
      const message = result.reason === 'context-full'
        ? '这条线程的上下文已满。请新开一条，或先到对话页移除部分上下文。'
        : '这个对象已经不在了，没能开线程。'
      fail(message, message, null)
      return null
    }
    if (isDeletedChatThread(result.thread.id)) return null
    let thread = result.thread
    if (options.contextItem) {
      const saved = await updateThreadContext({ threadId: thread.id, items: [...thread.context, options.contextItem] })
      if (saved.status !== 'saved') {
        fail('摘录没有带上，再试一次。', '摘录没有带上，再试一次。', null)
        return null
      }
      thread = saved.thread
    }
    activateThread(thread)
    navigate('chat', { threadId: thread.id })
    return thread.id
  } catch (error) {
    fail(error, '没能开线程，再试一次。', () => {
      void openThreadForMain(main, options)
    })
    return null
  }
}

/* ---------- 发送与生成 ---------- */

/** 提问被拒时的说法；上下文超词数与空提问不是同一件事。 */
function questionRejectText(reason: 'empty' | 'too-many-words'): string {
  return reason === 'too-many-words'
    ? `一条线程最多带 ${GROUP_WORD_LIMIT} 个词，先移除一个再发。`
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
 * 「用这些词学习」：每次都新开一条无主对象的线程，绝不复用旧的空白或组词线程。
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
  const isCurrent = (): boolean =>
    operation === groupOpenSequence && options.signal?.aborted !== true
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
    fail(error, '没能用这些词开线程，再试一次。', () => {
      void openGroupThread(ids)
    })
    return null
  }
}

/** 空白对话选材料时先创建对话，以便持久化所选上下文。 */
export async function ensureBlankContextThread(): Promise<ChatThreadView | null> {
  if (state.current) return state.current
  try {
    const result = await createThread({ main: { kind: 'none' } })
    if (result.status !== 'created') return null
    set({ current: result.thread, currentId: result.thread.id })
    replaceRoute('chat', { threadId: result.thread.id })
    void refreshThreads()
    return result.thread
  } catch (error) {
    fail(error, '没能新建对话，再试一次。', null)
    return null
  }
}

export function sendChatMessage(raw: string): boolean {
  const text = raw.trim()
  if (
    text === '' ||
    generationPending() ||
    state.busy ||
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
  try {
    let view = state.current
    if (view === null) {
      const created = await createThread({ main: { kind: 'none' } })
      if (created.status !== 'created') {
        set({ busy: false })
        fail('没能新建线程。', '没能新建线程，再试一次。', () => {
          set({ busy: true })
          void submitQuestion(text)
        })
        return
      }
      view = created.thread
      set({ current: view, currentId: view.id })
      replaceRoute('chat', { threadId: view.id })
    }

    const asked = await askThread({ threadId: view.id, text, context: view.context })
    if (asked.status !== 'asked') {
      set({ busy: false })
      fail(
        asked.status === 'rejected' ? questionRejectText(asked.reason) : '这条线程已经不在了。',
        '这条提问没有发出去。',
        asked.status === 'rejected'
          ? null
          : () => {
              set({ busy: true })
              void submitQuestion(text)
            }
      )
      return
    }
    set({ current: asked.thread, busy: false })
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
    fail(error, '这次提问没有发出去，再试一次。', () => {
      set({ busy: true })
      void submitQuestion(text)
    })
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
  if (view === null || generationPending() || state.busy || currentThreadBeingDeleted()) {
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
  if (view === null || generationPending() || state.busy || currentThreadBeingDeleted()) {
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
    now: Date.now()
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
            model: chatModel
          })
        : await saveThreadAnswer({
            threadId: generation.threadId,
            questionId: generation.questionId ?? '',
            text,
            thinking,
            thinkingMs,
            phase,
            error: generation.error,
            model: chatModel
          })

    if (result.status === 'saved') {
      if (state.currentId === generation.threadId) {
        set({ current: result.thread })
      }
      void refreshThreads()
    } else {
      fail('这条回答没能保存。', '这条回答没能保存，重新生成一次。', () =>
        regenerateLastAnswer()
      )
    }
  } catch (error) {
    fail(error, '这条回答没能保存，重新生成一次。', () => regenerateLastAnswer())
  } finally {
    dispatchSession({ type: 'clear', streamId: generation.streamId })
  }
}

/* ---------- 版本与改口 ---------- */

/** 切到另一版回答；旧版里接下去的问与答留在库里，切回来还在。 */
export function switchAnswerVersion(questionId: string, answerId: string): void {
  const view = state.current
  if (view === null || generationPending() || state.busy || currentThreadBeingDeleted()) {
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
  if (view === null || generationPending() || state.busy || currentThreadBeingDeleted()) {
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
        fail(
          result.status === 'rejected'
            ? questionRejectText(result.reason)
            : '这条线程已经不在了。',
          '这次修改没有发出去。',
          result.status === 'rejected' ? null : () => submitEdit(text)
        )
        return
      }
      set({ current: result.thread, editing: null, busy: false })
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
      fail(error, '这次修改没有发出去，再试一次。', () => submitEdit(text))
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
          `一条线程最多带 ${GROUP_WORD_LIMIT} 个词。`,
          `一条线程最多带 ${GROUP_WORD_LIMIT} 个词，先移除一个再加。`,
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
