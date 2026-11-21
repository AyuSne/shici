import { useEffect, useRef, useState } from 'react'
import type { DictionarySense } from '../../../shared/dictionary'
import type { EntryListItem, EntryPage, LearningNote } from '../../../shared/entries'
import {
  createLearningNote,
  deleteLearningNote,
  pinLearningNote,
  updateLearningNote
} from '../api'
import { pinSourceIssueText } from '../chat/pin-text'
import { focusablesIn, trapTabTarget } from '../components/focus-trap'
import { DictionaryView } from '../dictionary/dictionary-view'
import { useDictionaryLookup } from '../dictionary/lookup'
import { draftFromSense } from '../dictionary/presentation'
import { failureText } from '../errors'
import { navigate } from '../navigate'
import { entryHeadlineText, EMPTY_LEARNING_NOTES_TEXT, noteSourceText } from './format'
import { searchUiOwns } from '../search/ownership'
import { LearningBody } from './learning-body'
import { MoreActions } from './more-actions'

/**
 * 词条页右栏。收窄时只留一条竖着的「学习内容」入口；点开才是主词形、词典、
 * 学习内容与「更多」。学习内容只保留最终稿：编辑直接覆盖，不存历史版本；
 * 置顶一条，其余按写下的时间排。
 */
export function NoteRail({
  id,
  page,
  entries,
  open,
  overlay,
  focusedNoteId = null,
  focusRevision = 0,
  onToggle,
  onClose,
  onChanged,
  onEntryGone
}: {
  id: string
  page: EntryPage
  /** 全部词条，给「更多」里的合并、拆分与移动挑目标。 */
  entries: readonly EntryListItem[]
  open: boolean
  /** 覆盖抽屉模式：有遮罩、焦点进入并限制在抽屉里、Esc 关闭。 */
  overlay: boolean
  /** 从全局搜索点进来的学习内容：滚到那一条并标出来。 */
  focusedNoteId?: string | null
  /** 点同一条搜索结果时递增：即使已经开着也重新滚到那一条。 */
  focusRevision?: number
  onToggle: () => void
  onClose: () => void
  onChanged: (message: string) => void
  /** 词条在异步操作后消失；带上发起操作的那一条，页面据此判断是否仍停在那里。 */
  onEntryGone: (entryId: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [savingDraft, setSavingDraft] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [savingEdit, setSavingEdit] = useState(false)
  const [busyNoteId, setBusyNoteId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)
  const railRef = useRef<HTMLElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // 覆盖抽屉：打开时把焦点放到明确标了名的关闭按钮上，Tab 只在抽屉里循环，
  // Esc 关闭并把焦点还给打开它的按钮。焦点行为只属于窄屏抽屉，内联栏不抢焦点。
  useEffect(() => {
    if (!open || !overlay) return
    const node = railRef.current
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    node?.querySelector<HTMLElement>('.entries-rail-close')?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      // 全局搜索盖在右栏上时焦点与 Tab 归搜索覆盖层管，抽屉不再抢。
      if (searchUiOwns(event.target)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || node === null) return
      const active = document.activeElement
      const target = trapTabTarget(
        focusablesIn(node),
        active,
        event.shiftKey,
        node.contains(active)
      )
      if (target === null) return
      event.preventDefault()
      target.focus()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const restore = restoreFocusRef.current
      restoreFocusRef.current = null
      if (restore !== null && restore.isConnected) restore.focus()
    }
  }, [open, overlay, onClose])

  // 全局搜索点学习内容命中：等右栏挂上再把那一条滚到眼前，窄屏覆盖抽屉里同样可见。
  useEffect(() => {
    if (!open || focusedNoteId === null) return
    const frame = window.requestAnimationFrame(() => {
      railRef.current
        ?.querySelector<HTMLElement>(`[data-note-id="${focusedNoteId}"]`)
        ?.scrollIntoView({ block: 'center' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, focusedNoteId, page.entry.id, focusRevision])

  // 右栏的词典只读：按主词形查一次；查不到就明说，不影响下面写学习内容。
  const { lookup: dictionaryLookup, loading: dictionaryLoading } = useDictionaryLookup(
    page.entry.mainForm
  )

  /** 「用这条起草」只把词形、音标与那条释义填进编辑框，保存仍由学习者点。 */
  function draftFromDictionary(sense: DictionarySense): void {
    if (dictionaryLookup === null || dictionaryLookup.status !== 'found') return
    setDraft(
      draftFromSense({
        word: page.entry.mainForm,
        phonetic: dictionaryLookup.entry.phonetic,
        sense
      })
    )
    setError(null)
    draftRef.current?.focus()
  }

  if (!open) {
    return (
      <aside id={id} className="entries-rail entries-rail-closed" aria-label="学习内容">
        <button
          type="button"
          className="entries-rail-tab"
          aria-label="展开学习内容"
          aria-expanded={false}
          aria-controls={id}
          onClick={onToggle}
        >
          <span className="entries-rail-tab-label">学习内容</span>
          <span className="entries-rail-count">{page.entry.noteCount}</span>
        </button>
      </aside>
    )
  }

  async function saveDraft(): Promise<void> {
    const body = draft.trim()
    if (body === '' || savingDraft) return
    setSavingDraft(true)
    setError(null)
    try {
      const result = await createLearningNote({ entryId: page.entry.id, body })
      if (result.status === 'saved') {
        setDraft('')
        onChanged('学习内容已保存。')
        return
      }
      if (result.status === 'rejected') {
        if (result.reason === 'entry') {
          onEntryGone(page.entry.id)
          return
        }
        setError('学习内容不能是空的。')
        return
      }
      setError('学习内容没有保存成功，再试一次。')
    } catch (reason) {
      setError(failureText(reason, '学习内容没有保存成功，再点一次保存。'))
    } finally {
      setSavingDraft(false)
    }
  }

  async function saveEdit(note: LearningNote): Promise<void> {
    const body = editDraft.trim()
    if (body === '' || savingEdit) return
    setSavingEdit(true)
    setEditError(null)
    try {
      const result = await updateLearningNote({ noteId: note.id, body })
      if (result.status === 'saved') {
        setEditingId(null)
        onChanged('学习内容已更新，旧稿不保留。')
        return
      }
      if (result.status === 'rejected') {
        setEditError('学习内容不能是空的。')
        return
      }
      setEditError('这条学习内容已经不在了。')
    } catch (reason) {
      setEditError(failureText(reason, '没有保存成功，再点一次保存。'))
    } finally {
      setSavingEdit(false)
    }
  }

  async function togglePin(note: LearningNote): Promise<void> {
    setBusyNoteId(note.id)
    setError(null)
    try {
      const result = await pinLearningNote({ noteId: note.id, pinned: !note.pinned })
      if (result.status === 'saved') {
        onChanged(note.pinned ? '已取消置顶。' : '已置顶这一条。')
        return
      }
      setError('这条学习内容已经不在了。')
    } catch (reason) {
      setError(failureText(reason, '没有置顶成功，再点一次。'))
    } finally {
      setBusyNoteId(null)
    }
  }

  async function removeNote(note: LearningNote): Promise<void> {
    setBusyNoteId(note.id)
    setError(null)
    try {
      const result = await deleteLearningNote(note.id)
      if (result.status === 'deleted') {
        onChanged('学习内容已删除。')
        return
      }
      setError('这条学习内容已经不在了。')
    } catch (reason) {
      setError(failureText(reason, '没有删除成功，再点一次。'))
    } finally {
      setBusyNoteId(null)
    }
  }

  return (
    <aside
      id={id}
      ref={railRef}
      className="entries-rail entries-rail-open"
      role={overlay ? 'dialog' : 'complementary'}
      aria-modal={overlay ? true : undefined}
      aria-label="学习内容"
    >
      <header className="entries-rail-head">
        <p className="section-label">学习内容</p>
        <button
          type="button"
          className="entries-rail-close"
          aria-label="收起学习内容"
          onClick={onClose}
        >
          ×
        </button>
      </header>

      <h2 className="entries-rail-title">{page.entry.mainForm}</h2>
      <p className="entries-rail-meta">{entryHeadlineText(page.entry)}</p>

      <section className="entries-rail-section" aria-label="主词形">
        <p className="section-label">主词形</p>
        <div className="entry-forms">
          <span className="entry-form entry-form-current" aria-current="true">
            {page.entry.mainForm}
          </span>
          {page.entry.variants.map((variant) => (
            <span className="entry-form" key={variant}>
              {variant}
            </span>
          ))}
        </div>
      </section>

      <section className="entries-rail-section" aria-label="词典">
        <p className="section-label">词典</p>
        <DictionaryView
          lookup={dictionaryLookup}
          loading={dictionaryLoading}
          onDraft={draftFromDictionary}
        />
      </section>

      <section className="entries-rail-section" aria-label="学习内容">
        {page.notes.length === 0 ? (
          <p className="empty-line">{EMPTY_LEARNING_NOTES_TEXT}</p>
        ) : (
          <div className="entry-notes">
            {page.notes.map((note) => {
              const sourcePin = note.sourcePin
              return (
                <article
                  className="entry-note"
                  data-note-id={note.id}
                  data-focused={focusedNoteId === note.id ? 'true' : undefined}
                  key={note.id}
                >
                  <header className="entry-note-head">
                    {note.pinned ? <span className="entry-note-pin">已置顶</span> : null}
                    <div className="entry-note-actions">
                      <button
                        type="button"
                        className="entry-action"
                        disabled={busyNoteId === note.id}
                        onClick={() => void togglePin(note)}
                      >
                        {note.pinned ? '取消置顶' : '置顶'}
                      </button>
                      <button
                        type="button"
                        className="entry-action"
                        onClick={() => {
                          setEditingId(note.id)
                          setEditDraft(note.body)
                          setEditError(null)
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="entry-action entry-action-danger"
                        disabled={busyNoteId === note.id}
                        onClick={() => void removeNote(note)}
                      >
                        删除
                      </button>
                    </div>
                  </header>

                  {editingId === note.id ? (
                    <div className="entry-note-editor">
                      <textarea
                        aria-label="编辑学习内容"
                        rows={4}
                        value={editDraft}
                        onChange={(event) => setEditDraft(event.target.value)}
                      />
                      <div className="entries-rail-actions">
                        <button
                          type="button"
                          className="button"
                          disabled={savingEdit || editDraft.trim() === ''}
                          onClick={() => void saveEdit(note)}
                        >
                          保存修改
                        </button>
                        <button
                          type="button"
                          className="button"
                          onClick={() => setEditingId(null)}
                        >
                          取消
                        </button>
                      </div>
                      {editError === null ? null : (
                        <p className="entry-error" role="alert">
                          {editError}
                        </p>
                      )}
                    </div>
                  ) : (
                    <LearningBody body={note.body} />
                  )}

                  <p className="entry-note-source">
                    <span>{noteSourceText(note)}</span>
                    {sourcePin === null ? null : sourcePin.sourceStatus === 'available' ? (
                      <button
                        type="button"
                        className="entry-source-link"
                        aria-label="看原对话（来源）"
                        onClick={() =>
                          navigate('chat', {
                            threadId: sourcePin.threadId,
                            pinId: sourcePin.id,
                            fromEntryId: page.entry.id
                          })
                        }
                      >
                        来源
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="entry-source-link"
                        aria-label="看原对话（来源）"
                        title={`${pinSourceIssueText(sourcePin.sourceStatus)}`}
                        disabled
                      >
                        来源
                      </button>
                    )}
                  </p>
                </article>
              )
            })}
          </div>
        )}

        <form
          className="entry-note-form"
          onSubmit={(event) => {
            event.preventDefault()
            void saveDraft()
          }}
        >
          <textarea
            ref={draftRef}
            aria-label="写学习内容"
            placeholder="写释义、例句、辨析、助记…"
            rows={3}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="button"
            disabled={savingDraft || draft.trim() === ''}
          >
            保存学习内容
          </button>
        </form>
        {error === null ? null : (
          <p className="entry-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="entries-rail-section" aria-label="更多">
        <p className="section-label">更多</p>
        <MoreActions
          page={page}
          entries={entries}
          onChanged={onChanged}
          onEntryGone={onEntryGone}
        />
      </section>
    </aside>
  )
}
