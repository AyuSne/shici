import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type {
  Pin,
  PinBoard,
  PinSource,
  PinTargetView,
  RestorePinInput
} from '../../../shared/pins'
import type {
  ThreadAnswer,
  ThreadContextItem,
  ThreadContextCandidates,
  ThreadListItem,
  ThreadTurn,
  ThreadVersion
} from '../../../shared/threads'
import { GROUP_WORD_LIMIT } from '../../../shared/threads'
import {
  createPin,
  deletePin,
  fileAllUnfiled,
  loadPinBoard,
  loadPinSource,
  loadThread,
  loadThreadContextCandidates,
  loadArticleContextMaterials,
  movePin,
  restorePins,
  saveGeneratedArticle
} from '../api'
import { readAnswerSelection, type AnswerSelection } from '../chat/answer-selection'
import { AnswerText, type PinMarks } from '../chat/answer-text'
import { describeChatError, suggestsSettings } from '../chat/errors'
import { ContextPanel } from '../chat/context-panel'
import { DeleteThreadDialog } from '../chat/delete-thread-dialog'
import { PinBoardPanel, type PinTab } from '../chat/pin-board'
import {
  defaultPinTarget,
  pinSourceIssueText,
  samePinTarget,
  targetFromView,
  targetLabel
} from '../chat/pin-text'
import { PinTargetDialog } from '../chat/pin-target-dialog'
import { DictionaryView } from '../dictionary/dictionary-view'
import { useDictionaryLookup } from '../dictionary/lookup'
import { singleWordOf } from '../dictionary/presentation'
import { LearningInstructionPanel } from '../instructions/learning-instructions'
import { ErrorBlock } from '../components/error-block'
import {
  liveAnswerText,
  liveAnswerThinking,
  liveThinkingSeconds,
  thinkingExpanded,
  thinkingExpandedFor,
  type LiveGeneration
} from '../chat/session'
import {
  addContextItem,
  addContextItems,
  beginEditLastQuestion,
  cancelEdit,
  canDeleteChatThread,
  continueLastAnswer,
  ensureChatEvents,
  ensureBlankContextThread,
  getChatStore,
  isDeletedChatThread,
  openChatThread,
  regenerateLastAnswer,
  removeContextItem,
  retryChat,
  sendChatMessage,
  stopChat,
  submitEdit,
  switchAnswerVersion,
  switchQuestionVersion,
  useChatStore
} from '../chat/store'
import {
  BLANK_THREAD_SUBTITLE,
  canSaveAnswerAsArticle,
  selectedVersionIndex,
  threadHeaderText
} from '../chat/turns'
import { failureText } from '../errors'
import { navigate } from '../navigate'
import { parseView } from '../routes'
import { searchUiOwns } from '../search/ownership'
import { threadViewState, updateThreadViewState } from '../view-state'

type PinSelection = AnswerSelection & { text: string }

type ToastState = {
  message: string
  undo: (() => void | Promise<void>) | null
}

type PinDialogState = {
  action: 'create' | 'move' | 'file' | 'file-all'
  title: string
  confirmLabel: string
  initial: PinTargetView
  selection: { answerId: string; start: number; end: number } | null
  pin: Pin | null
}

const EMPTY_BOARD: PinBoard = {
  threadId: null,
  threadPins: [],
  unfiledPins: [],
  unfiledCount: 0
}

/** 「已钉到词条 lament」/「已放进未归档」。 */
function pinnedLabel(pin: Pick<Pin, 'target'>): string {
  if (pin.target.kind === 'unfiled') {
    return '已放进未归档'
  }
  return `已钉到${pin.target.kind === 'entry' ? '词条' : '文章'} ${pin.target.label}`
}

function movedLabel(target: PinTargetView): string {
  return target.kind === 'unfiled' ? '已移回未归档' : `已换到${targetLabel(target)}`
}

function restoreInputOf(pin: Pin): RestorePinInput {
  return {
    id: pin.id,
    capturedText: pin.capturedText,
    start: pin.start,
    end: pin.end,
    target: targetFromView(pin.target),
    provenance: pin.provenance,
    createdAt: pin.createdAt
  }
}

/**
 * 对话页：左边线程列表，中间这一路的对话，底部是带上下文的输入框，右边是钉板抽屉。
 * 回答可以重新生成出新版本再切回旧的；改上一条提问会走新分支，原回答留在库里；
 * 继续生成接在同一版回答后面；选中一段就能钉住，落点默认跟着线程主对象走。
 */
export function ChatPage({
  threadId,
  pinId,
  fromEntryId
}: {
  threadId: string | null
  /** 从学习内容点「来源」回跳时要定位的那条钉住。 */
  pinId: string | null
  /** 回跳时「回词条」要回到的词条。 */
  fromEntryId: string | null
}) {
  const store = useChatStore()
  // 空白学习的第一问会先生成线程，再以 replaceState 更新地址；此时路由 prop 仍为空。
  const viewThreadId = threadId ?? store.current?.id ?? null
  const [draft, setDraftState] = useState(() => threadViewState(viewThreadId).draft)
  const [thinkingOpen, setThinkingOpenState] = useState(
    () => threadViewState(viewThreadId).thinkingOpen
  )
  const [now, setNow] = useState(() => Date.now())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [railOpen, setRailOpen] = useState(false)
  const [deleteCandidate, setDeleteCandidate] = useState<ThreadListItem | null>(null)
  const [candidates, setCandidates] = useState<ThreadContextCandidates | null>(null)
  const [board, setBoard] = useState<PinBoard>(EMPTY_BOARD)
  const [boardOpen, setBoardOpen] = useState(false)
  const [boardTab, setBoardTab] = useState<PinTab>('thread')
  const [freshPinIds, setFreshPinIds] = useState<readonly string[]>([])
  const [toast, setToast] = useState<ToastState | null>(null)
  const [selection, setSelection] = useState<PinSelection | null>(null)
  const [dictionaryWord, setDictionaryWord] = useState<string | null>(null)
  const { lookup: selectionLookup, loading: selectionLookupLoading } =
    useDictionaryLookup(dictionaryWord)
  const [pinDialog, setPinDialog] = useState<PinDialogState | null>(null)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [busyPinId, setBusyPinId] = useState<string | null>(null)
  /** 正在存成文章的那一版回答；同一时间只允许一个保存动作。 */
  const [savingArticleId, setSavingArticleId] = useState<string | null>(null)
  const [source, setSource] = useState<PinSource | null>(null)
  const [sourceHitPinId, setSourceHitPinId] = useState<string | null>(null)
  const [mainLinkError, setMainLinkError] = useState<string | null>(null)
  /** 源对话已删的快照要再点一次才丢弃。 */
  const [confirmDiscardId, setConfirmDiscardId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const restoredScroll = useRef(false)
  const skipAutoScroll = useRef(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const selectionCardRef = useRef<HTMLDivElement>(null)
  const boardRequest = useRef(0)
  const sourceDone = useRef<string | null>(null)
  /** 用户手动改过的落点，记到本次会话里的这条线程结束。 */
  const targetOverrides = useRef(new Map<string, PinTargetView>())

  function setDraft(value: string): void {
    updateThreadViewState(viewThreadId, { draft: value })
    setDraftState(value)
  }

  function setThinkingOpen(open: boolean): void {
    updateThreadViewState(viewThreadId, { thinkingOpen: open })
    setThinkingOpenState(open)
  }

  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node) return
    restoredScroll.current = false
    const remember = (): void => {
      if (restoredScroll.current && (viewThreadId === null || !isDeletedChatThread(viewThreadId))) {
        updateThreadViewState(viewThreadId, { scrollTop: node.scrollTop })
      }
    }
    node.addEventListener('scroll', remember)
    return () => {
      remember()
      node.removeEventListener('scroll', remember)
    }
  }, [viewThreadId])

  useLayoutEffect(() => {
    if (restoredScroll.current || store.loading || store.currentId !== viewThreadId) return
    if (viewThreadId !== null && store.current?.id !== viewThreadId) return
    const node = scrollRef.current
    if (!node) return
    const saved = threadViewState(viewThreadId).scrollTop
    if (saved !== null) node.scrollTop = saved
    skipAutoScroll.current = saved !== null
    restoredScroll.current = true
  }, [viewThreadId, store.currentId, store.current, store.loading])

  const generation = store.session.generation
  const liveHere = generation !== null && generation.threadId === store.currentId
  const generatingHere = liveHere && generation.status === 'live'
  const generatingElsewhere =
    generation !== null && generation.status === 'live' && generation.threadId !== store.currentId

  const refreshBoard = (id: string | null): void => {
    const isCurrent = (): boolean => {
      const route = parseView(window.location.hash)
      return route.route === 'chat' && route.threadId === id
    }
    if (!isCurrent()) return
    const sequence = ++boardRequest.current
    loadPinBoard(id).then(
      (value) => {
        if (sequence === boardRequest.current && isCurrent()) setBoard(value)
      },
      (error: unknown) => {
        if (sequence === boardRequest.current && isCurrent()) {
          setToast({ message: failureText(error), undo: null })
        }
      }
    )
  }

  useEffect(() => {
    ensureChatEvents()
  }, [])

  useEffect(() => {
    setDraftState(threadViewState(viewThreadId).draft)
    setThinkingOpenState(threadViewState(viewThreadId).thinkingOpen)
  }, [viewThreadId])

  useEffect(() => {
    openChatThread(threadId)
    setPickerOpen(false)
    setRailOpen(false)
    setCandidates(null)
    setBoard(EMPTY_BOARD)
    setBoardOpen(false)
    setBoardTab('thread')
    setFreshPinIds([])
    setToast(null)
    setSelection(null)
    setPinDialog(null)
    setSource(null)
    setSourceHitPinId(null)
    setMainLinkError(null)
    sourceDone.current = null
    refreshBoard(threadId)
  }, [threadId])

  useEffect(() => {
    if (!generatingHere) {
      return
    }
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [generatingHere])

  useEffect(() => {
    if (toast === null) {
      setConfirmDiscardId(null)
      return
    }
    const timer = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (freshPinIds.length === 0) {
      return
    }
    const timer = window.setTimeout(() => setFreshPinIds([]), 4000)
    return () => window.clearTimeout(timer)
  }, [freshPinIds])

  useEffect(() => {
    if (selection === null) {
      return
    }
    const onMouseDown = (event: MouseEvent): void => {
      // 搜索覆盖层与它的入口不算点对话正文，别收掉选段卡。
      if (searchUiOwns(event.target)) return
      if (selectionCardRef.current?.contains(event.target as Node)) {
        return
      }
      setSelection(null)
      setDictionaryWord(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [selection])

  useEffect(() => {
    if (pinId === null) {
      setSource(null)
      setSourceHitPinId(null)
      sourceDone.current = null
      return
    }
    let active = true
    sourceDone.current = null
    setSourceHitPinId(null)
    loadPinSource(pinId).then(
      (result) => {
        if (active) {
          setSource(result)
        }
      },
      (error: unknown) => {
        if (active) {
          setToast({ message: failureText(error), undo: null })
        }
      }
    )
    return () => {
      active = false
    }
  }, [pinId])

  const current = store.current
  const sourceAnswerId = source?.pin.provenance.answerId ?? null
  /** 未归档的钉住也留着对话里的竖条；这条线程钉过就算。 */
  const textPins =
    current === null
      ? []
      : [
          ...board.threadPins,
          ...board.unfiledPins.filter(
            (pin) => pin.provenance.threadId === current.id
          )
        ]
  const sourceOnBranch =
    current !== null &&
    sourceAnswerId !== null &&
    current.turns.some((turn) => turn.answer !== null && turn.answer.id === sourceAnswerId)
  const pinMarks: PinMarks = { pins: textPins, freshPinIds, sourceHitPinId }

  useEffect(() => {
    if (source === null || sourceAnswerId === null || !sourceOnBranch) {
      return
    }
    if (sourceDone.current === source.pin.id) {
      return
    }
    sourceDone.current = source.pin.id
    setSourceHitPinId(source.pin.id)
    const scrollTimer = window.setTimeout(() => {
      document
        .querySelector(`[data-answer-id="${sourceAnswerId}"]`)
        ?.scrollIntoView({ block: 'center' })
    }, 60)
    const clearHit = (event: MouseEvent): void => {
      // 搜索覆盖层与它的入口都不该清掉从学习内容回跳的高亮。
      if (searchUiOwns(event.target)) return
      setSourceHitPinId(null)
      document.removeEventListener('mousedown', clearHit, true)
    }
    document.addEventListener('mousedown', clearHit, true)
    return () => {
      window.clearTimeout(scrollTimer)
      document.removeEventListener('mousedown', clearHit, true)
    }
  }, [source, sourceAnswerId, sourceOnBranch])

  const liveText = liveHere && generation ? liveAnswerText(generation) : ''
  const liveThinking = liveHere && generation ? liveAnswerThinking(generation) : ''

  useEffect(() => {
    const node = scrollRef.current
    if (!node || !restoredScroll.current) {
      return
    }
    if (skipAutoScroll.current) {
      skipAutoScroll.current = false
      return
    }
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    if (distance < 160) {
      node.scrollTop = node.scrollHeight
    }
  }, [store.current?.turns, liveText, liveThinking, store.loading])

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) {
        return
      }
      if (pinDialog !== null) {
        event.preventDefault()
        setPinDialog(null)
        return
      }
      if (selection !== null) {
        event.preventDefault()
        setSelection(null)
        return
      }
      if (store.editing !== null) {
        event.preventDefault()
        cancelEdit()
        setDraft('')
        return
      }
      if (pickerOpen) {
        event.preventDefault()
        setPickerOpen(false)
        return
      }
      if (railOpen) {
        event.preventDefault()
        setRailOpen(false)
        return
      }
      if (boardOpen) {
        event.preventDefault()
        setBoardOpen(false)
        return
      }
      if (generatingHere) {
        event.preventDefault()
        stopChat()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    boardOpen,
    generatingHere,
    pickerOpen,
    pinDialog,
    railOpen,
    selection,
    store.editing
  ])

  const submit = (): void => {
    if (store.editing !== null) {
      if (submitEdit(draft)) {
        setDraft('')
        inputRef.current?.focus()
      }
      return
    }
    if (sendChatMessage(draft)) {
      setDraft('')
      inputRef.current?.focus()
    }
  }

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
      return
    }
    if (generatingHere) {
      // 生成中发送键是停止键，Enter 只换行，输入区不锁。
      return
    }
    if (generatingElsewhere) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    submit()
  }

  const togglePicker = async (): Promise<void> => {
    if (pickerOpen) {
      setPickerOpen(false)
      return
    }
    const view = store.current ?? await ensureBlankContextThread()
    if (view === null) return
    setPickerOpen(true)
    setCandidates(null)
    loadThreadContextCandidates(view.id).then(
      (result) => setCandidates(result),
      () => setCandidates({ items: [], articles: [], libraryItems: [] })
    )
  }

  const addItem = (item: ThreadContextItem): void => {
    const view = store.current
    // 界面先拦一次超词数；主进程的 updateThreadContext 还会再校验一遍。
    if (
      item.kind === 'word' &&
      view !== null &&
      view.context.filter((existing) => existing.kind === 'word').length >= GROUP_WORD_LIMIT
    ) {
      showToast(`一条线程最多带 ${GROUP_WORD_LIMIT} 个词。`)
      return
    }
    addContextItem(item)
  }

  const removeItem = (id: string): void => {
    const removed = store.current?.context.find((item) => item.id === id)
    removeContextItem(id)
    if (removed) setCandidates((current) => current && !current.items.some((item) => item.id === id)
      ? { ...current, items: [...current.items, removed] } : current)
  }

  const showToast = (
    message: string,
    undo: (() => void | Promise<void>) | null = null
  ): void => {
    setToast({ message, undo })
  }

  const defaultTargetForThread = (): PinTargetView => {
    const view = store.current
    if (view === null) {
      return { kind: 'unfiled' }
    }
    return targetOverrides.current.get(view.id) ?? defaultPinTarget(view.main)
  }

  /** 手动改过的落点记到这条线程结束；改回默认值就不再记。 */
  const rememberTarget = (target: PinTargetView): void => {
    const view = store.current
    if (view === null) {
      return
    }
    if (samePinTarget(targetFromView(target), targetFromView(defaultPinTarget(view.main)))) {
      targetOverrides.current.delete(view.id)
    } else {
      targetOverrides.current.set(view.id, target)
    }
  }

  const captureAnswerSelection = (): void => {
    const node = scrollRef.current
    if (node === null) {
      return
    }
    // 等浏览器把这次选区的范围定下来再读。
    window.setTimeout(() => {
      const read = readAnswerSelection(node)
      const view = store.current
      if (read === null || view === null) {
        setSelection(null)
        setDictionaryWord(null)
        return
      }
      const answer = view.turns
        .flatMap((turn) => (turn.answer === null ? [] : [turn.answer]))
        .find((candidate) => candidate.id === read.answerId)
      if (!answer) {
        setSelection(null)
        setDictionaryWord(null)
        return
      }
      // 换了一段选区，上一条词的释义不再跟着。
      setDictionaryWord(null)
      setSelection({ ...read, text: answer.text.slice(read.start, read.end) })
    }, 0)
  }

  /** 划词浮卡里的「释义」：只查单词，查的是离线词典，不发模型请求。 */
  const lookUpSelection = (): void => {
    if (selection === null) {
      return
    }
    const word = singleWordOf(selection.text)
    if (word !== null) {
      setDictionaryWord(word)
    }
  }

  const openCreateDialog = (value: {
    answerId: string
    start: number
    end: number
    text: string
  }): void => {
    if (value.text.trim() === '') {
      return
    }
    setPinDialog({
      action: 'create',
      title: '钉到哪儿',
      confirmLabel: '钉住',
      initial: defaultTargetForThread(),
      selection: { answerId: value.answerId, start: value.start, end: value.end },
      pin: null
    })
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }

  const openMoveDialog = (pin: Pin): void => {
    setPinDialog({
      action: 'move',
      title: '换落点',
      confirmLabel: '换到这儿',
      initial: pin.target,
      selection: null,
      pin
    })
  }

  const openFileDialog = (pin: Pin, kind: 'entry' | 'article'): void => {
    const fallback =
      kind === 'entry'
        ? ({ kind: 'entry', entryId: '', label: '词条' } as const)
        : ({ kind: 'article', articleId: '', label: '文章' } as const)
    setPinDialog({
      action: 'file',
      title: '归到哪儿',
      confirmLabel: '归位',
      initial: pin.defaultTarget.kind === kind ? pin.defaultTarget : fallback,
      selection: null,
      pin
    })
  }

  /** 全部归位：有默认落点就直接执行，只在空白线程里让人挑一个。 */
  const openFileAllDialog = (): void => {
    const target = defaultTargetForThread()
    if (target.kind !== 'unfiled') {
      void fileAllTo(target)
      return
    }
    setPinDialog({
      action: 'file-all',
      title: '全部未归档归到哪儿',
      confirmLabel: '全部归位',
      initial: { kind: 'entry', entryId: '', label: '词条' },
      selection: null,
      pin: null
    })
  }

  const fileAllTo = async (target: PinTargetView): Promise<void> => {
    const boardThreadId = store.currentId
    setDialogBusy(true)
    try {
      const result = await fileAllUnfiled({ target: targetFromView(target) })
      if (result.status !== 'filed') {
        showToast('没有归位成功，再试一次。')
        return
      }
      setPinDialog(null)
      showToast(`已将 ${result.filed.length} 条归位`, async () => {
        for (const pin of result.filed) {
          await movePin({ pinId: pin.id, target: { kind: 'unfiled' } })
        }
        refreshBoard(boardThreadId)
      })
      refreshBoard(boardThreadId)
    } catch (error) {
      showToast(failureText(error))
    } finally {
      setDialogBusy(false)
    }
  }

  const confirmPinDialog = async (target: PinTargetView): Promise<void> => {
    const dialog = pinDialog
    if (dialog === null || dialogBusy) {
      return
    }
    const view = store.current
    const boardThreadId = store.currentId
    setDialogBusy(true)
    try {
      if (dialog.action === 'create') {
        if (view === null || dialog.selection === null) {
          return
        }
        const result = await createPin({
          threadId: view.id,
          answerId: dialog.selection.answerId,
          start: dialog.selection.start,
          end: dialog.selection.end,
          target: targetFromView(target)
        })
        if (result.status !== 'pinned') {
          showToast('这条没能钉住，再试一次。')
          return
        }
        rememberTarget(target)
        setPinDialog(null)
        setFreshPinIds((ids) => [...ids, result.pin.id])
        showToast(pinnedLabel(result.pin), async () => {
          await deletePin(result.pin.id)
          setFreshPinIds((ids) => ids.filter((id) => id !== result.pin.id))
          refreshBoard(boardThreadId)
        })
        refreshBoard(boardThreadId)
        return
      }

      if (dialog.action === 'file-all') {
        setDialogBusy(false)
        await fileAllTo(target)
        return
      }

      const pin = dialog.pin
      if (pin === null) {
        return
      }
      const result = await movePin({
        pinId: pin.id,
        target: targetFromView(target)
      })
      if (result.status !== 'saved') {
        showToast('落点没能换过去，再试一次。')
        return
      }
      setPinDialog(null)
      const undo =
        dialog.action === 'file'
          ? async () => {
              await movePin({ pinId: pin.id, target: { kind: 'unfiled' } })
              refreshBoard(boardThreadId)
            }
          : null
      showToast(
        dialog.action === 'file' ? `已归到 ${targetLabel(target)}` : movedLabel(target),
        undo
      )
      refreshBoard(boardThreadId)
    } catch (error) {
      showToast(failureText(error))
    } finally {
      setDialogBusy(false)
    }
  }

  const removePin = async (pin: Pin): Promise<void> => {
    const sourceIssue = pinSourceIssueText(pin.sourceStatus)
    if (sourceIssue !== null && confirmDiscardId !== pin.id) {
      setConfirmDiscardId(pin.id)
      const action = pin.target.kind === 'unfiled' ? '丢弃' : '删除'
      const warning = pin.sourceStatus === 'thread-deleted'
        ? '这是对话被删后仅存的副本'
        : `${sourceIssue}，这是仅存的副本`
      showToast(`${warning} · 再点一次${action}`)
      return
    }
    setConfirmDiscardId(null)
    setBusyPinId(pin.id)
    try {
      const result = await deletePin(pin.id)
      if (result.status !== 'deleted') {
        showToast('这条钉住已经不在了。')
        refreshBoard(store.current?.id ?? null)
        return
      }
      if (pin.target.kind === 'unfiled') {
        showToast('已丢弃', async () => {
          await restorePins({ pins: [restoreInputOf(pin)] })
          refreshBoard(store.current?.id ?? null)
        })
      } else {
        showToast('已删除')
      }
      refreshBoard(store.current?.id ?? null)
    } catch (error) {
      showToast(failureText(error))
    } finally {
      setBusyPinId(null)
    }
  }

  const openPinSource = (pin: Pin): void => {
    const sourceIssue = pinSourceIssueText(pin.sourceStatus)
    if (sourceIssue !== null) {
      showToast(`${sourceIssue}，内容按快照保留。`)
      return
    }
    const fromHash = window.location.hash
    loadPinSource(pin.id).then(
      (result) => {
        if (window.location.hash !== fromHash) return
        const sourceThreadId = pin.provenance.threadId
        if (getChatStore().deletingThreadId === sourceThreadId) return
        if (result === null) {
          showToast('这条钉住已经不在了。')
          return
        }
        const issue = pinSourceIssueText(isDeletedChatThread(sourceThreadId) ? 'thread-deleted' : result.pin.sourceStatus)
        if (issue !== null || result.thread === null) {
          showToast(`${issue ?? '无法打开原回答'}，内容按快照保留。`)
          return
        }
        if (result.pin.provenance.threadId !== store.currentId) {
          navigate('chat', {
            threadId: result.pin.provenance.threadId,
            pinId: result.pin.id,
            fromEntryId:
              result.pin.target.kind === 'entry' ? result.pin.target.entryId : null
          })
          return
        }
        sourceDone.current = null
        setSource(result)
        setBoardOpen(false)
      },
      (error: unknown) => showToast(failureText(error))
    )
  }

  const switchToSourceBranch = (): void => {
    if (source === null || source.questionId === null) {
      showToast('找不到这条回答所在的分支。')
      return
    }
    if (store.session.generation !== null || store.busy) {
      showToast('等这次生成结束再切分支。')
      return
    }
    sourceDone.current = null
    switchAnswerVersion(source.questionId, source.pin.provenance.answerId)
  }

  const backToEntry = (): void => {
    const entryId =
      fromEntryId ??
      (source?.pin.target.kind === 'entry' ? source.pin.target.entryId : null)
    if (entryId !== null) {
      navigate('entries', { entryId })
    }
  }

  const copyText = (text: string): void => {
    void navigator.clipboard.writeText(text).then(
      () => showToast('已复制'),
      () => showToast('复制失败，改用键盘复制。')
    )
  }

  /** 存为文章：与钉住相互独立；保存的是这一版已完成的回答，重复点每次都新建一篇。 */
  const saveAnswerAsArticle = async (answer: ThreadAnswer): Promise<void> => {
    const view = store.current
    if (view === null || savingArticleId !== null) return
    setSavingArticleId(answer.id)
    try {
      const result = await saveGeneratedArticle({ threadId: view.id, answerId: answer.id })
      if (result.status === 'saved') {
        showToast(`已存为文章「${result.article.title}」，在文章库里可以打开。`)
        return
      }
      if (result.status === 'missing') {
        showToast('这条回答已经不在了，存不了文章。')
        return
      }
      showToast(
        result.reason === 'incomplete'
          ? '这条回答还没写完，等它完成后再存。'
          : result.reason === 'empty'
            ? '这条回答没有正文，存不了文章。'
            : result.reason === 'no-word-context'
              ? '只有带词条上下文的回答才能存为文章。'
              : '篇名太长了。'
      )
    } catch (error) {
      showToast(failureText(error, '这次没有存成文章，再试一次。'))
    } finally {
      setSavingArticleId(null)
    }
  }

  const openBoard = (tab: PinTab): void => {
    setBoardTab(tab)
    setBoardOpen(true)
  }

  const editing = store.editing
  const title = current === null ? '新的学习' : current.title
  const subtitle = current === null ? BLANK_THREAD_SUBTITLE : threadHeaderText(current)
  const missingMain = current?.missingMain ?? null
  const missingArticle = missingMain === 'article' || current?.main.kind === 'article'
  const blankMain = current === null || (current.main.kind === 'none' && !current.missingMain)

  async function openMainObject(): Promise<void> {
    if (current === null || current.main.kind === 'none') return
    const threadId = current.id
    const fromHash = window.location.hash
    const canFollowLink = (): boolean => window.location.hash === fromHash &&
      getChatStore().deletingThreadId !== threadId && !isDeletedChatThread(threadId)
    if (!canFollowLink()) return
    try {
      const refreshed = await loadThread(threadId)
      if (!canFollowLink()) return
      if (refreshed === null) {
        setMainLinkError('这条线程已经不在了，请从线程列表选择另一条。')
        return
      }
      if (refreshed.missingMain || refreshed.main.kind === 'none') {
        setMainLinkError('主对象已经不在了，请选择其他词条或文章。')
        return
      }
      const main = refreshed.main
      if (main.kind === 'article') navigate('reading', { articleId: main.articleId })
      else navigate('entries', {
        entryId: main.entryId,
        entrySentenceId: main.kind === 'sentence' ? main.entrySentenceId : null
      })
    } catch (error) {
      if (canFollowLink()) setMainLinkError(failureText(error, '主对象没有读出来，请再试一次。'))
    }
  }
  /** 线程已经不在了：重试只会再失败，改成回到一条空白学习。 */
  const threadGone = store.error === '这条线程已经不在了。'
  const canSend = draft.trim() !== '' && !store.busy && generation === null &&
    (store.deletingThreadId === null || store.deletingThreadId !== store.currentId)
  /** 生成、提交或改口时，回答上的动作一律收起，避免存到半截或旧版本。 */
  const actionsDisabled =
    generatingHere || generatingElsewhere || store.busy || editing !== null
  const threadEntryId =
    current === null
      ? null
      : current.main.kind === 'entry' || current.main.kind === 'sentence'
        ? current.main.entryId
        : null
  const threadPinCount = board.threadId === viewThreadId && viewThreadId !== null
    ? new Set([
        ...board.threadPins.map((pin) => pin.id),
        ...board.unfiledPins.filter((pin) => pin.provenance.threadId === viewThreadId).map((pin) => pin.id)
      ]).size
    : 0
  const sourceEntryId =
    fromEntryId ??
    (source?.pin.target.kind === 'entry' ? source.pin.target.entryId : null)

  return (
    <div className="chat-page">
      <aside
        className="chat-rail"
        aria-label="线程列表"
        data-open={railOpen ? 'true' : 'false'}
      >
        <div className="chat-rail-head">
          <button
            type="button"
            className="button button-primary chat-new"
            onClick={() => {
              setRailOpen(false)
              navigate('chat')
            }}
          >
            新的学习
          </button>
          <button
            type="button"
            className="chat-rail-unfiled"
            onClick={() => {
              setRailOpen(false)
              openBoard('unfiled')
            }}
          >
            未归档 {board.unfiledCount}
          </button>
        </div>
        {store.threads.length === 0 ? (
          <p className="empty-line chat-rail-empty">还没有线程</p>
        ) : (
          <ul className="thread-list">
            {store.threads.map((thread) => (
              <li key={thread.id} className="thread-list-item">
                <button
                  type="button"
                  className="thread-row"
                  aria-current={thread.id === store.currentId ? 'page' : undefined}
                  onClick={() => {
                    setRailOpen(false)
                    navigate('chat', { threadId: thread.id })
                  }}
                >
                  <span className="thread-row-title">{thread.title}</span>
                  <span className="thread-row-meta">
                    {thread.mainLabel} · {thread.turnCount} 轮
                  </span>
                </button>
                <button
                  type="button"
                  className="thread-delete-button"
                  aria-label={`删除线程：${thread.title}`}
                  title={canDeleteChatThread(store, thread.id) ? '删除线程' : '等操作完成后再删除'}
                  disabled={!canDeleteChatThread(store, thread.id)}
                  onClick={() => setDeleteCandidate(thread)}
                >
                  删除
                </button>
              </li>
            ))}
          </ul>
        )}
        {deleteCandidate && (
          <DeleteThreadDialog
            thread={deleteCandidate}
            canDelete={canDeleteChatThread(store, deleteCandidate.id)}
            busy={store.deletingThreadId === deleteCandidate.id}
            onClose={() => setDeleteCandidate(null)}
            onDeleted={() => {
              targetOverrides.current.delete(deleteCandidate.id)
              setDeleteCandidate(null)
              const route = parseView(window.location.hash)
              if (route.route === 'chat') refreshBoard(route.threadId)
            }}
          />
        )}
      </aside>

      <div className="chat-main">
        <header className="chat-header">
          <div className="chat-header-inner">
            <button
              type="button"
              className="chat-rail-toggle chat-action"
              aria-label="线程列表"
              aria-expanded={railOpen}
              onClick={() => setRailOpen((open) => !open)}
            >
              线程
            </button>
            <div className="chat-header-row">
              <div className="chat-header-text">
                <h1 className="chat-title">
                  {current !== null && current.main.kind !== 'none' ? (
                    <button type="button" className="chat-main-link chat-title-link" onClick={() => void openMainObject()}>
                      {title}
                    </button>
                  ) : title}
                </h1>
                <p className="chat-subtitle">
                  {current !== null && current.main.kind !== 'none' ? (
                    <button type="button" className="chat-main-link" onClick={() => void openMainObject()}>
                      {subtitle}
                    </button>
                  ) : subtitle}
                </p>
                {missingMain || mainLinkError ? (
                  <p className="chat-main-missing" role="alert">
                    {mainLinkError ?? '主对象已经不在了。'}{' '}
                    <button type="button" className="chat-main-link" onClick={() => navigate(missingArticle ? 'library' : 'entries')}>
                      {missingArticle ? '选择文章' : '选择词条'}
                    </button>
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                className="button button-small chat-board-button"
                onClick={() => openBoard('thread')}
              >
                钉板 {threadPinCount} · 本线程
              </button>
            </div>
          </div>
        </header>

        {source === null ? null : (
          <div className="pin-source-banner" role="status">
            {source.thread === null ? (
              <span>{pinSourceIssueText(source.pin.sourceStatus) ?? '无法打开原回答'} · 内容按快照保留</span>
            ) : (
              <>
                <span>
                  来自
                  {source.pin.target.kind === 'entry'
                    ? `词条 ${source.pin.target.label}`
                    : '对话'}
                  {' · 学习内容'}
                </span>
                {sourceOnBranch ? (
                  <span className="pin-source-hint">
                    已定位到第 {source.pin.provenance.turnIndex} 轮，高亮保留到点击别处
                  </span>
                ) : (
                  <>
                    <span className="pin-source-hint">这条在另一分支</span>
                    <button
                      type="button"
                      className="button button-small"
                      disabled={source.questionId === null}
                      onClick={switchToSourceBranch}
                    >
                      切到此分支
                    </button>
                  </>
                )}
              </>
            )}
            {sourceEntryId === null ? null : (
              <button
                type="button"
                className="button button-small pin-source-back"
                onClick={backToEntry}
              >
                回词条
              </button>
            )}
            <button
              type="button"
              className="pin-source-close"
              aria-label="关闭来源提示"
              onClick={() => {
                setSource(null)
                setSourceHitPinId(null)
              }}
            >
              ×
            </button>
          </div>
        )}

        <div
          className="chat-scroll"
          ref={scrollRef}
          onMouseUp={captureAnswerSelection}
          onKeyUp={captureAnswerSelection}
        >
          <div className="chat-column">
            {store.loading && current === null ? (
              <p className="empty-line">正在打开这条线程…</p>
            ) : current === null || current.turns.length === 0 ? (
              <div className="chat-empty">
                <h2 className="chat-empty-title">
                  {blankMain
                    ? '今天学点什么？'
                    : '从这条线索问起'}
                </h2>
                <p className="chat-empty-lede">
                  {blankMain
                    ? '这是一条还没有挂对象的线程：聊完把满意的段落钉住，再决定它归到哪个词条。'
                    : '上下文已经放在输入框上方，直接问就行；问完可以把满意的段落钉到这条线索上。'}
                </p>
                {blankMain ? (
                  <div className="chat-starters">
                    <button
                      type="button"
                      className="button"
                      onClick={() => navigate('entries')}
                    >
                      从一个词开始
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => navigate('library')}
                    >
                      从一篇文章开始
                    </button>
                  </div>
                ) : null}
              </div>
            ) : (
              current.turns.map((turn, index) => (
                <ChatTurnView
                  key={turn.question.id}
                  turn={turn}
                  isLast={index === current.turns.length - 1}
                  thinkingOpen={thinkingOpen}
                  live={
                    liveHere && generation !== null && index === current.turns.length - 1
                      ? generation
                      : null
                  }
                  now={now}
                  disabled={actionsDisabled}
                  marks={pinMarks}
                  onSwitchQuestion={switchQuestionVersion}
                  onSwitchAnswer={switchAnswerVersion}
                  onEdit={() => {
                    beginEditLastQuestion()
                    setDraft(turn.question.text)
                    inputRef.current?.focus()
                  }}
                  onRegenerate={regenerateLastAnswer}
                  onContinue={continueLastAnswer}
                  onRetry={regenerateLastAnswer}
                  onToggleThinking={setThinkingOpen}
                  onCopy={copyText}
                  canSaveAsArticle={canSaveAnswerAsArticle(
                    turn.question,
                    turn.answer,
                    actionsDisabled
                  )}
                  savingArticle={savingArticleId === turn.answer?.id}
                  onSaveAsArticle={(answer) => void saveAnswerAsArticle(answer)}
                  onPinAnswer={(answer) =>
                    openCreateDialog({
                      answerId: answer.id,
                      start: 0,
                      end: answer.text.length,
                      text: answer.text
                    })
                  }
                />
              ))
            )}
          </div>
        </div>

        <div className="chat-composer">
          {store.error === null ? null : (
            <div className="composer-inner">
              <ErrorBlock
                message={store.error}
                actionLabel={threadGone ? '回到空白学习' : '再试一次'}
                onAction={
                  threadGone
                    ? () => navigate('chat')
                    : store.canRetry
                      ? retryChat
                      : null
                }
              />
            </div>
          )}
          <div className="composer-inner">
            {
              <ContextPanel
                items={current?.context ?? []}
                summary={current?.contextSummary ?? { articleCount: 0, paragraphCount: 0, wordCount: 0, sentenceCount: 0, charCount: 0 }}
                candidates={candidates}
                pickerOpen={pickerOpen}
                onTogglePicker={togglePicker}
                onAdd={addItem}
                onAddMany={addContextItems}
                loadArticle={loadArticleContextMaterials}
                onRemove={removeItem}
              />
            }

            <LearningInstructionPanel draft={draft} onAppend={setDraft} />

            {editing === null ? null : (
              <div className="edit-banner" role="status">
                <span>正在编辑这一条提问 · 发送后会新建分支，原来的回答保留</span>
                <button
                  type="button"
                  className="chat-action"
                  onClick={() => {
                    cancelEdit()
                    setDraft('')
                  }}
                >
                  取消
                </button>
              </div>
            )}

            <div className="composer-box">
              <textarea
                ref={inputRef}
                className="composer-input"
                rows={2}
                aria-label="输入问题"
                placeholder={
                  editing === null
                    ? '问点什么… 例如：这两个例句里哪个更常用于书面语？'
                    : '改一下这条提问，发送后会走新的分支'
                }
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={onComposerKeyDown}
              />
              <button
                type="button"
                className={generatingHere ? 'send-button send-button-stop' : 'send-button'}
                aria-label={generatingHere ? '停止生成' : '发送'}
                disabled={generatingHere ? false : !canSend}
                onClick={generatingHere ? stopChat : submit}
              >
                {generatingHere ? (
                  <span className="stop-square" aria-hidden="true" />
                ) : (
                  <span aria-hidden="true">↑</span>
                )}
              </button>
            </div>
            <p className="composer-hint">
              {generatingElsewhere
                ? '另一条线程正在生成，等它结束再发。'
                : 'Enter 发送 · Shift+Enter 换行 · Esc 停止 · 选中一段即可钉住'}
            </p>
          </div>
        </div>
      </div>

      {boardOpen ? (
        <div className="pin-board-scrim" aria-hidden="true" onClick={() => setBoardOpen(false)} />
      ) : null}
      <PinBoardPanel
        board={board}
        open={boardOpen}
        tab={boardTab}
        threadEntryId={threadEntryId}
        busyPinId={busyPinId}
        freshPinIds={freshPinIds}
        onOpenUnfiled={() => openBoard('unfiled')}
        onClose={() => setBoardOpen(false)}
        onSelectTab={setBoardTab}
        onOpenSource={openPinSource}
        onChangeTarget={openMoveDialog}
        onDelete={(pin) => void removePin(pin)}
        onFile={openFileDialog}
        onFileAll={openFileAllDialog}
        onViewEntry={(entryId) => {
          setBoardOpen(false)
          navigate('entries', { entryId })
        }}
      />

      {selection === null ? null : (
        <div
          className="pin-selection-card"
          ref={selectionCardRef}
          style={{
            left: selection.rect.left + selection.rect.width / 2,
            top: selection.rect.bottom + 8
          }}
        >
          <div className="pin-selection-actions">
            <button
              type="button"
              className="button button-small button-primary"
              onClick={() =>
                openCreateDialog({
                  answerId: selection.answerId,
                  start: selection.start,
                  end: selection.end,
                  text: selection.text
                })
              }
            >
              钉住
            </button>
            <button
              type="button"
              className="button button-small"
              onClick={() => copyText(selection.text)}
            >
              复制
            </button>
            {singleWordOf(selection.text) === null ? null : (
              <button type="button" className="button button-small" onClick={lookUpSelection}>
                释义
              </button>
            )}
          </div>
          {dictionaryWord === null ? null : (
            <div className="pin-selection-dictionary">
              <DictionaryView
                lookup={selectionLookup}
                loading={selectionLookupLoading}
              />
            </div>
          )}
        </div>
      )}

      {pinDialog === null ? null : (
        <div
          className="pin-dialog-scrim"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              setPinDialog(null)
            }
          }}
        >
          <PinTargetDialog
            key={`${pinDialog.action}-${pinDialog.pin?.id ?? 'new'}`}
            title={pinDialog.title}
            confirmLabel={pinDialog.confirmLabel}
            initial={pinDialog.initial}
            busy={dialogBusy}
            onCancel={() => setPinDialog(null)}
            onConfirm={(target) => void confirmPinDialog(target)}
          />
        </div>
      )}

      {toast === null ? null : (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.undo === null ? null : (
            <button
              type="button"
              className="toast-undo"
              onClick={() => {
                const undo = toast.undo
                setToast(null)
                if (undo !== null) {
                  Promise.resolve(undo()).catch((error: unknown) => {
                    showToast(failureText(error))
                  })
                }
              }}
            >
              撤销
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/* ---------- 一轮对话 ---------- */

function ChatTurnView({
  turn,
  isLast,
  thinkingOpen,
  live,
  now,
  disabled,
  marks,
  onSwitchQuestion,
  onSwitchAnswer,
  onEdit,
  onRegenerate,
  onContinue,
  onRetry,
  onToggleThinking,
  onCopy,
  canSaveAsArticle,
  savingArticle,
  onSaveAsArticle,
  onPinAnswer
}: {
  turn: ThreadTurn
  isLast: boolean
  thinkingOpen: boolean | null
  live: LiveGeneration | null
  now: number
  disabled: boolean
  marks: PinMarks
  onSwitchQuestion: (questionId: string) => void
  onSwitchAnswer: (questionId: string, answerId: string) => void
  onEdit: () => void
  onRegenerate: () => void
  onContinue: () => void
  onRetry: () => void
  onToggleThinking: (open: boolean) => void
  onCopy: (text: string) => void
  /** 这一版回答带词上下文且已完成时，才给独立的「存为文章」。 */
  canSaveAsArticle: boolean
  savingArticle: boolean
  onSaveAsArticle: (answer: ThreadAnswer) => void
  onPinAnswer: (answer: ThreadAnswer) => void
}) {
  return (
    <div className="chat-turn">
      <UserMessage
        text={turn.question.text}
        versions={turn.question.versions}
        showActions={isLast && live === null && !disabled}
        onSwitch={onSwitchQuestion}
        onEdit={onEdit}
      />

      {live !== null ? (
        <LiveAnswer
          generation={live}
          thinkingOpen={thinkingOpen}
          now={now}
          onToggleThinking={onToggleThinking}
        />
      ) : turn.answer !== null ? (
        <AnswerCard
          answer={turn.answer}
          isLast={isLast}
          thinkingOpen={thinkingOpen}
          disabled={disabled}
          marks={marks}
          canSaveAsArticle={canSaveAsArticle}
          savingArticle={savingArticle}
          onSaveAsArticle={onSaveAsArticle}
          onPinAnswer={onPinAnswer}
          onCopy={onCopy}
          onSwitchVersion={(answerId) => onSwitchAnswer(turn.question.id, answerId)}
          onRegenerate={onRegenerate}
          onContinue={onContinue}
          onRetry={onRetry}
          onToggleThinking={onToggleThinking}
        />
      ) : (
        <div className="chat-unanswered">
          <span>这条还没有回答。</span>
          {isLast && !disabled ? (
            <button type="button" className="chat-action" onClick={onRegenerate}>
              生成回答
            </button>
          ) : null}
        </div>
      )}
    </div>
  )
}

function UserMessage({
  text,
  versions,
  showActions,
  onSwitch,
  onEdit
}: {
  text: string
  versions: readonly ThreadVersion[]
  showActions: boolean
  onSwitch: (questionId: string) => void
  onEdit: () => void
}) {
  return (
    <div className="chat-message-user-wrap">
      <div className="chat-message-user">{text}</div>
      {showActions ? (
        <div className="user-actions">
          {versions.length > 1 ? (
            <VersionNav
              versions={versions}
              label="提问版本"
              previousLabel="上一个提问版本"
              nextLabel="下一个提问版本"
              onSelect={onSwitch}
            />
          ) : null}
          <button type="button" className="chat-action" aria-label="编辑上一条提问" onClick={onEdit}>
            编辑
          </button>
        </div>
      ) : null}
    </div>
  )
}

function VersionNav({
  versions,
  label,
  previousLabel,
  nextLabel,
  onSelect
}: {
  versions: readonly ThreadVersion[]
  label: string
  previousLabel: string
  nextLabel: string
  onSelect: (id: string) => void
}) {
  const index = selectedVersionIndex(versions)
  if (index === 0) {
    return null
  }
  const previous = versions[(index - 2 + versions.length) % versions.length]
  const next = versions[index % versions.length]
  return (
    <div className="version-nav" role="group" aria-label={label}>
      <button
        type="button"
        className="version-step"
        aria-label={previousLabel}
        onClick={() => previous && onSelect(previous.id)}
      >
        ‹
      </button>
      <span className="version-index">
        {index}/{versions.length}
      </span>
      <button
        type="button"
        className="version-step"
        aria-label={nextLabel}
        onClick={() => next && onSelect(next.id)}
      >
        ›
      </button>
    </div>
  )
}

function AnswerCard({
  answer,
  isLast,
  thinkingOpen,
  disabled,
  marks,
  canSaveAsArticle,
  savingArticle,
  onSaveAsArticle,
  onPinAnswer,
  onCopy,
  onSwitchVersion,
  onRegenerate,
  onContinue,
  onRetry,
  onToggleThinking
}: {
  answer: ThreadAnswer
  isLast: boolean
  thinkingOpen: boolean | null
  disabled: boolean
  marks: PinMarks
  canSaveAsArticle: boolean
  savingArticle: boolean
  onSaveAsArticle: (answer: ThreadAnswer) => void
  onPinAnswer: (answer: ThreadAnswer) => void
  onCopy: (text: string) => void
  onSwitchVersion: (answerId: string) => void
  onRegenerate: () => void
  onContinue: () => void
  onRetry: () => void
  onToggleThinking: (open: boolean) => void
}) {
  const expanded = thinkingExpandedFor(thinkingOpen, {
    hasThinking: answer.thinking !== '',
    active: false
  })
  const presentation = answer.error ? describeChatError(answer.error) : null
  const badge = statusLabel(answer)
  const seconds = Math.floor(answer.thinkingMs / 1000)

  return (
    <article
      className="assistant-message"
      aria-label="学习助手"
      data-answer-id={answer.id}
    >
      <div className="assistant-head">
        <p className="assistant-label">学习助手</p>
        {answer.versions.length > 1 ? (
          <div className="answer-versions" role="group" aria-label="回答版本">
            {answer.versions.map((version, index) => (
              <button
                key={version.id}
                type="button"
                className="version-tab"
                aria-pressed={version.selected}
                aria-label={`版本 ${index + 1}`}
                onClick={() => onSwitchVersion(version.id)}
              >
                v{index + 1}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {answer.thinking !== '' ? (
        <ThinkingSection
          text={answer.thinking}
          label={`已思考 ${seconds} 秒`}
          expanded={expanded}
          onToggle={() => onToggleThinking(!expanded)}
        />
      ) : null}

      {answer.text !== '' ? <AnswerText text={answer.text} saved={{ id: answer.id, marks }} /> : null}
      {badge ? <span className="status-chip">{badge}</span> : null}

      {presentation ? (
        <div className="message-error" role="alert">
          <p className="message-error-title">{presentation.title}</p>
          <p className="message-error-detail">{presentation.detail}</p>
          {presentation.action ? (
            <p className="message-error-action">下一步：{presentation.action}</p>
          ) : null}
          {answer.error?.requestId ? (
            <p className="message-error-request">请求 ID：{answer.error.requestId}</p>
          ) : null}
          {presentation.retryable || (answer.error !== null && suggestsSettings(answer.error)) ? (
            <div className="message-error-actions">
              {presentation.retryable ? (
                <button type="button" className="button button-small" onClick={onRetry}>
                  重试
                </button>
              ) : null}
              {answer.error !== null && suggestsSettings(answer.error) ? (
                <button
                  type="button"
                  className="button button-small"
                  onClick={() => navigate('settings')}
                >
                  去设置
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {answer.text.trim() === '' ? null : (
        <div className="assistant-actions">
          <button
            type="button"
            className="chat-action"
            disabled={disabled}
            onClick={() => onPinAnswer(answer)}
          >
            钉住
          </button>
          <button type="button" className="chat-action" onClick={() => onCopy(answer.text)}>
            复制
          </button>
          {canSaveAsArticle && !disabled ? (
            <button
              type="button"
              className="chat-action"
              disabled={savingArticle}
              onClick={() => onSaveAsArticle(answer)}
            >
              {savingArticle ? '正在保存…' : '存为文章'}
            </button>
          ) : null}
          {isLast && !disabled ? (
            <>
              <button type="button" className="chat-action" onClick={onRegenerate}>
                重新生成
              </button>
              <button type="button" className="chat-action" onClick={onContinue}>
                继续生成
              </button>
            </>
          ) : null}
        </div>
      )}
    </article>
  )
}

function LiveAnswer({
  generation,
  thinkingOpen,
  now,
  onToggleThinking
}: {
  generation: LiveGeneration
  thinkingOpen: boolean | null
  now: number
  onToggleThinking: (open: boolean) => void
}) {
  const text = liveAnswerText(generation)
  const thinking = liveAnswerThinking(generation)
  const expanded = thinkingExpanded(thinkingOpen, generation)
  const seconds = liveThinkingSeconds(generation, now)
  const waiting = generation.phase === 'waiting' && text === ''

  return (
    <article className="assistant-message" aria-label="学习助手">
      <p className="assistant-label">学习助手</p>

      {waiting ? (
        <div className="waiting-dots" role="status" aria-label="正在等待回答">
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {thinking === '' ? null : (
        <ThinkingSection
          text={thinking}
          label={
            generation.phase === 'thinking'
              ? `正在思考… ${seconds} 秒`
              : `已思考 ${seconds} 秒`
          }
          expanded={expanded}
          onToggle={() => onToggleThinking(!expanded)}
        />
      )}

      {text === '' ? null : <AnswerText text={text} />}
    </article>
  )
}

function ThinkingSection({
  text,
  label,
  expanded,
  onToggle
}: {
  text: string
  label: string
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div className="thinking">
      <button
        type="button"
        className="thinking-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="thinking-dot" aria-hidden="true" />
        <span>{label}</span>
        <span className="thinking-action">{expanded ? '收起' : '展开'}</span>
      </button>
      {expanded ? (
        <div className="thinking-body" data-testid="thinking-body">
          {text}
        </div>
      ) : null}
    </div>
  )
}

function statusLabel(answer: ThreadAnswer): string | null {
  if (answer.phase === 'stopped') {
    return '已停止 · 未完成'
  }
  if (answer.phase === 'error' && answer.text.trim() !== '') {
    return '未完成'
  }
  return null
}
