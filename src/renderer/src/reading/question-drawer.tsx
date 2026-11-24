import { useEffect, useRef, useState } from 'react'
import type { EntryListItem } from '../../../shared/entries'
import type { Pin, PinTargetView } from '../../../shared/pins'
import { wordContextEntryId } from '../../../shared/threads'
import {
  createPin,
  deletePin,
  loadEntryList,
  loadPinBoard
} from '../api'
import { readAnswerSelection } from '../chat/answer-selection'
import { AnswerText, type PinMarks } from '../chat/answer-text'
import { describeChatError } from '../chat/errors'
import {
  defaultPinTarget,
  samePinTarget,
  targetFromView
} from '../chat/pin-text'
import { PinTargetDialog } from '../chat/pin-target-dialog'
import { SelectionCapsule } from '../chat/selection-capsule'
import { matchSelectedEntry } from '../chat/selection-match'
import {
  liveAnswerText,
  liveAnswerThinking,
  liveThinkingSeconds,
  thinkingExpandedFor
} from '../chat/session'
import {
  addContextItem,
  ensureChatEvents,
  getChatStore,
  regenerateLastAnswer,
  retryChat,
  sendChatMessage,
  stopChat,
  useChatStore
} from '../chat/store'
import { contextSummaryText } from '../chat/turns'
import { ErrorBlock } from '../components/error-block'
import { showToast } from '../components/toast-store'
import { failureText } from '../errors'
import { threadViewState, updateThreadViewState } from '../view-state'

type PinSelection = {
  answerId: string
  start: number
  end: number
  text: string
  rect: DOMRect
}

type PinDialogState = {
  selection: PinSelection
  initial: PinTargetView
}

const EMPTY_MARKS: PinMarks = { pins: [], freshPinIds: [], sourceHitPinId: null }

/** 「已钉到词条 lament」/「已放进未归档」；与对话页同一句回执。 */
function pinnedLabel(pin: Pick<Pin, 'target'>): string {
  if (pin.target.kind === 'unfiled') {
    return '已放进未归档'
  }
  return `已钉到${pin.target.kind === 'entry' ? '词条' : '文章'} ${pin.target.label}`
}

function statusLabel(answer: { phase: 'done' | 'stopped' | 'error'; text: string }): string | null {
  if (answer.phase === 'stopped') return '已停止 · 未完成'
  if (answer.phase === 'error' && answer.text.trim() !== '') return '未完成'
  return null
}

/**
 * 阅读页右侧的迷你轻问抽屉：就地打开一条对话，边对照左侧原文边提问、停止与钉住。
 *
 * 它不持有第二套生成状态：线程、流式事件、停止、重试、部分结果落库与钉住都走
 * 和对话页同一个 store 与同一批服务；抽屉只负责把当前线程按紧凑形态摆出来。
 * 「在对话页展开」沿用同一个 threadId，草稿存在同一条线程的浏览状态里。
 */
export function QuestionDrawer({
  onClose,
  onExpand
}: {
  onClose: () => void
  onExpand: (threadId: string) => void
}) {
  const store = useChatStore()
  const view = store.current
  const threadId = view?.id ?? null
  const [draft, setDraftState] = useState(() => threadViewState(threadId).draft)
  const [thinkingOpen, setThinkingOpen] = useState<boolean | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [selection, setSelection] = useState<PinSelection | null>(null)
  const [pinDialog, setPinDialog] = useState<PinDialogState | null>(null)
  const [busyPin, setBusyPin] = useState(false)
  const [pins, setPins] = useState<readonly Pin[]>([])
  const [contextEntries, setContextEntries] = useState<readonly EntryListItem[]>([])
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const boardRequest = useRef(0)
  /** 用户手动改过的落点，记到这条对话结束；智能预选与主对象默认都不覆盖它。 */
  const targetOverrides = useRef(new Map<string, PinTargetView>())

  function setDraft(value: string): void {
    updateThreadViewState(threadId, { draft: value })
    setDraftState(value)
  }

  const generation = store.session.generation
  const liveHere = generation !== null && generation.threadId === threadId
  const generatingHere = liveHere && generation.status === 'live'
  const generatingElsewhere =
    generation !== null && generation.status === 'live' && generation.threadId !== threadId
  const threadGone = view === null && store.currentId !== null && !store.loading

  useEffect(() => {
    setDraftState(threadViewState(threadId).draft)
    setThinkingOpen(null)
    setSelection(null)
    setPinDialog(null)
    setPins([])
    if (threadId === null) return
    const sequence = ++boardRequest.current
    loadPinBoard(threadId).then(
      (board) => {
        if (sequence !== boardRequest.current) return
        setPins([
          ...board.threadPins,
          ...board.unfiledPins.filter((pin) => pin.provenance.threadId === threadId)
        ])
      },
      () => {
        if (sequence === boardRequest.current) setPins([])
      }
    )
  }, [threadId])

  // 智能预选只在对话上下文里有词时才有意义：取一次词条列表，按主词形与变体匹配。
  const contextWordKey =
    view === null
      ? ''
      : view.context
          .map((item) => wordContextEntryId(item))
          .filter((entryId): entryId is string => entryId !== null)
          .sort()
          .join('|')
  useEffect(() => {
    if (contextWordKey === '') {
      setContextEntries([])
      return
    }
    let active = true
    loadEntryList({}).then(
      (listing) => {
        if (active) setContextEntries(listing.entries)
      },
      () => {
        if (active) setContextEntries([])
      }
    )
    return () => {
      active = false
    }
  }, [contextWordKey])

  useEffect(() => {
    // 抽屉和对话页共用同一条全局事件订阅：没去过对话页也要能收到流式事件。
    ensureChatEvents()
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!generatingHere) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [generatingHere])

  // Esc 所有权：内层钉住弹层先关，其次收起选中胶囊，最后才收回抽屉。
  // 阅读页在抽屉打开时把 Esc 让给这里，所以不会顺手退出阅读页或停止生成。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      if (pinDialog !== null) {
        setPinDialog(null)
        return
      }
      if (selection !== null) {
        setSelection(null)
        window.getSelection()?.removeAllRanges()
        return
      }
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pinDialog, selection, onClose])

  // 点别处收起选中胶囊；胶囊自己的按钮不算。
  useEffect(() => {
    if (selection === null) return
    const onMouseDown = (event: MouseEvent): void => {
      if ((event.target as Element | null)?.closest('.selection-capsule')) return
      setSelection(null)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [selection])

  const liveText = liveHere && generation !== null ? liveAnswerText(generation) : ''
  const liveThinking = liveHere && generation !== null ? liveAnswerThinking(generation) : ''

  // 只自动跟到底部；抽屉自己滚动，不碰阅读正文的滚动位置。
  useEffect(() => {
    const node = bodyRef.current
    if (node === null) return
    node.scrollTop = node.scrollHeight
  }, [view?.turns.length, liveText, liveThinking])

  function captureSelection(): void {
    const node = bodyRef.current
    if (node === null) return
    window.setTimeout(() => {
      const read = readAnswerSelection(node)
      const current = getChatStore().current
      if (read === null || current === null) {
        setSelection(null)
        return
      }
      const answer = current.turns
        .flatMap((turn) => (turn.answer === null ? [] : [turn.answer]))
        .find((candidate) => candidate.id === read.answerId)
      if (!answer) {
        setSelection(null)
        return
      }
      setSelection({ ...read, text: answer.text.slice(read.start, read.end) })
    }, 0)
  }

  function defaultTargetForThread(text: string): PinTargetView {
    if (view === null) return { kind: 'unfiled' }
    const override = targetOverrides.current.get(view.id)
    if (override !== undefined) return override
    const wordIds = new Set(
      view.context
        .map((item) => wordContextEntryId(item))
        .filter((entryId): entryId is string => entryId !== null)
    )
    if (wordIds.size > 0) {
      const candidates = contextEntries
        .filter((entry) => wordIds.has(entry.id))
        .map((entry) => ({ entryId: entry.id, mainForm: entry.mainForm, variants: entry.variants }))
      const matched = matchSelectedEntry(text, candidates)
      if (matched !== null) {
        return { kind: 'entry', entryId: matched.entryId, label: matched.mainForm }
      }
    }
    return defaultPinTarget(view.main)
  }

  function refreshPins(): void {
    if (threadId === null) return
    const sequence = ++boardRequest.current
    loadPinBoard(threadId).then(
      (board) => {
        if (sequence !== boardRequest.current) return
        setPins([
          ...board.threadPins,
          ...board.unfiledPins.filter((pin) => pin.provenance.threadId === threadId)
        ])
      },
      () => undefined
    )
  }

  async function confirmPin(target: PinTargetView): Promise<void> {
    const dialog = pinDialog
    const current = view
    if (dialog === null || current === null || busyPin) return
    setBusyPin(true)
    try {
      const result = await createPin({
        threadId: current.id,
        answerId: dialog.selection.answerId,
        start: dialog.selection.start,
        end: dialog.selection.end,
        target: targetFromView(target)
      })
      if (result.status !== 'pinned') {
        showToast({ message: '这条没能钉住，再试一次。', tone: 'error' })
        return
      }
      const fallback = defaultPinTarget(current.main)
      if (samePinTarget(targetFromView(target), targetFromView(fallback))) {
        targetOverrides.current.delete(current.id)
      } else {
        targetOverrides.current.set(current.id, target)
      }
      setPinDialog(null)
      setSelection(null)
      window.getSelection()?.removeAllRanges()
      showToast({
        message: pinnedLabel(result.pin),
        action: {
          label: '撤销',
          run: async () => {
            await deletePin(result.pin.id)
            refreshPins()
          },
          failureMessage: '撤销没有完成，再试一次。'
        }
      })
      refreshPins()
    } catch (error) {
      showToast({ message: failureText(error, '这条没能钉住，再试一次。'), tone: 'error' })
    } finally {
      setBusyPin(false)
    }
  }

  function followUpSelection(): void {
    if (selection === null) return
    addContextItem({
      id: `excerpt:${crypto.randomUUID()}`,
      kind: 'excerpt',
      label: '追问',
      text: selection.text,
      source: '来自当前回答'
    })
    setSelection(null)
    window.getSelection()?.removeAllRanges()
    inputRef.current?.focus()
    showToast({ message: '已把这段放进追问，写下你的问题。' })
  }

  function copySelection(): void {
    if (selection === null) return
    void navigator.clipboard.writeText(selection.text).then(
      () => {
        setSelection(null)
        window.getSelection()?.removeAllRanges()
        showToast({ message: '已复制' })
      },
      () => showToast({ message: '复制失败，请再试一次。', tone: 'error' })
    )
  }

  function submit(): void {
    const text = draft
    if (!sendChatMessage(text)) return
    setDraft('')
  }

  const busyElsewhere = generatingElsewhere || (store.session.generation !== null && !liveHere)
  const canSend =
    view !== null &&
    draft.trim() !== '' &&
    !store.busy &&
    !generatingHere &&
    !busyElsewhere &&
    !threadGone
  const marks: PinMarks = { ...EMPTY_MARKS, pins }

  return (
    <aside className="reading-drawer" aria-label="轻问" data-question-drawer="true">
      <header className="reading-drawer-head">
        <div className="reading-drawer-heading">
          <h2 className="reading-drawer-title">轻问</h2>
          <p className="reading-drawer-subtitle">
            {view === null ? '正在打开…' : contextSummaryText(view.contextSummary)}
          </p>
        </div>
        <div className="reading-drawer-head-actions">
          <button
            type="button"
            className="reading-drawer-expand"
            disabled={threadId === null}
            onClick={() => {
              if (threadId !== null) onExpand(threadId)
            }}
          >
            在对话页展开
          </button>
          <button
            type="button"
            className="reading-drawer-close"
            aria-label="收回轻问"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>

      {store.error === null ? null : (
        <div className="reading-drawer-error">
          <ErrorBlock
            message={store.error}
            actionLabel={store.canRetry ? '再试一次' : '知道了'}
            onAction={store.canRetry ? retryChat : null}
          />
        </div>
      )}

      <div className="reading-drawer-body" ref={bodyRef} onMouseUp={captureSelection}>
        {view === null ? (
          <p className="empty-line" aria-busy="true">
            {threadGone ? '这条对话已经不在了。' : '正在打开轻问…'}
          </p>
        ) : view.turns.length === 0 && !liveHere ? (
          <div className="reading-drawer-empty">
            <p className="reading-drawer-empty-title">还没有问过</p>
            <p className="empty-line">就着左边的原文问一句，答案满意就钉住。</p>
          </div>
        ) : (
          view.turns.map((turn, index) => {
            const live =
              liveHere && generation !== null && index === view.turns.length - 1
                ? generation
                : null
            const answer = turn.answer
            const liveThinkingExpanded = thinkingExpandedFor(thinkingOpen, {
              hasThinking: liveThinking !== '',
              active: live !== null && live.phase === 'thinking'
            })
            const savedThinkingExpanded =
              answer !== null &&
              thinkingExpandedFor(thinkingOpen, {
                hasThinking: answer.thinking !== '',
                active: false
              })
            return (
              <div className="reading-drawer-turn" key={turn.question.id}>
                <p className="reading-drawer-question">{turn.question.text}</p>
                {live !== null ? (
                  <div className="reading-drawer-answer">
                    {liveThinking !== '' ? (
                      <div className="reading-drawer-thinking">
                        <button
                          type="button"
                          className="reading-drawer-thinking-toggle"
                          aria-expanded={liveThinkingExpanded}
                          onClick={() => setThinkingOpen(!liveThinkingExpanded)}
                        >
                          {live.phase === 'thinking'
                            ? `正在思考… ${liveThinkingSeconds(live, now)} 秒`
                            : `已思考 ${liveThinkingSeconds(live, now)} 秒`}
                        </button>
                        {liveThinkingExpanded ? (
                          <div className="reading-drawer-thinking-body">{liveThinking}</div>
                        ) : null}
                      </div>
                    ) : null}
                    {liveText === '' ? (
                      <p className="reading-drawer-waiting" aria-busy="true">
                        正在等待回答…
                      </p>
                    ) : (
                      <AnswerText text={liveText} />
                    )}
                  </div>
                ) : answer !== null ? (
                  <div className="reading-drawer-answer">
                    {answer.thinking === '' ? null : (
                      <div className="reading-drawer-thinking">
                        <button
                          type="button"
                          className="reading-drawer-thinking-toggle"
                          aria-expanded={savedThinkingExpanded}
                          onClick={() => setThinkingOpen(!savedThinkingExpanded)}
                        >
                          思考过程 · {Math.floor(answer.thinkingMs / 1000)} 秒
                        </button>
                        {savedThinkingExpanded ? (
                          <div className="reading-drawer-thinking-body">{answer.thinking}</div>
                        ) : null}
                      </div>
                    )}
                    {answer.text === '' ? null : (
                      <AnswerText text={answer.text} saved={{ id: answer.id, marks }} />
                    )}
                    {statusLabel(answer) === null ? null : (
                      <span className="status-chip">{statusLabel(answer)}</span>
                    )}
                    {answer.error === null ? null : (
                      <div className="reading-drawer-answer-error" role="alert">
                        <p>{describeChatError(answer.error).title}</p>
                        <p>{describeChatError(answer.error).detail}</p>
                        <button
                          type="button"
                          className="button button-small"
                          onClick={regenerateLastAnswer}
                        >
                          重试
                        </button>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>

      <div className="reading-drawer-composer">
        <textarea
          ref={inputRef}
          className="reading-drawer-input"
          rows={2}
          aria-label="轻问输入"
          placeholder="就着这篇原文问一句…"
          value={draft}
          disabled={view === null}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              if (canSend) submit()
            }
          }}
        />
        <div className="reading-drawer-composer-row">
          <p className="reading-drawer-hint">
            {generatingElsewhere || busyElsewhere
              ? '另一条对话正在生成，等它结束再发。'
              : generatingHere
                ? '正在回答这条 · 可停止'
                : 'Enter 发送 · Shift+Enter 换行 · Esc 收回'}
          </p>
          {generatingHere ? (
            <button
              type="button"
              className="send-button send-button-stop"
              aria-label="停止生成"
              onClick={stopChat}
            >
              <span className="stop-square" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="send-button"
              aria-label="发送"
              disabled={!canSend}
              onClick={submit}
            >
              <span aria-hidden="true">↑</span>
            </button>
          )}
        </div>
      </div>

      {selection === null ? null : (
        <SelectionCapsule
          anchor={{ top: selection.rect.top, left: selection.rect.left, width: selection.rect.width }}
          busy={busyPin}
          onPin={() =>
            setPinDialog({
              selection,
              initial: defaultTargetForThread(selection.text)
            })
          }
          onFollowUp={followUpSelection}
          onCopy={copySelection}
        />
      )}

      {pinDialog === null ? null : (
        <div
          className="pin-dialog-scrim"
          onClick={(event) => {
            if (event.target === event.currentTarget) setPinDialog(null)
          }}
        >
          <PinTargetDialog
            title="钉到哪儿"
            confirmLabel="钉住"
            initial={pinDialog.initial}
            busy={busyPin}
            onCancel={() => setPinDialog(null)}
            onConfirm={(target) => void confirmPin(target)}
          />
        </div>
      )}
    </aside>
  )
}
