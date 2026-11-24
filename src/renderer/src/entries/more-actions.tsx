import { useState } from 'react'
import type { EntryListItem, EntryPage, EntrySentence } from '../../../shared/entries'
import {
  changeEntryMainForm,
  mergeEntries,
  moveEntrySentence,
  moveLearningNote
} from '../api'
import { SearchableTargetPicker } from '../components/searchable-target-picker'
import type { SearchableTarget } from '../components/target-search'
import { failureText } from '../errors'
import { noteExcerpt, sentenceSourceText } from './format'

export type MoreForm = 'merge' | 'split' | 'main-form' | 'move-note'

type SentenceChoice = { sentence: EntrySentence; articleTitle: string }

/**
 * 右栏顶部 `···` 里的四项维护动作。菜单只占一次点击，选中某项后才在原地铺开表单；
 * 目标词条统一用可搜索选择器，输入即时过滤，↑/↓ 移动、Enter 选中。
 */
export function MoreActions({
  page,
  entries,
  form,
  onPick,
  onClose,
  onChanged,
  onEntryGone
}: {
  page: EntryPage
  entries: readonly EntryListItem[]
  /** null 时渲染菜单；给具体表单时渲染那张表单。 */
  form: MoreForm | null
  /** 菜单里选了一项。 */
  onPick: (form: MoreForm) => void
  /** 取消当前表单。 */
  onClose: () => void
  onChanged: (message: string) => void
  onEntryGone: (entryId: string) => void
}) {
  const otherEntries = entries.filter((entry) => entry.id !== page.entry.id)
  const forms = [page.entry.mainForm, ...page.entry.variants]
  const sentences: SentenceChoice[] = page.groups.flatMap((group) =>
    group.sentences.map((sentence) => ({ sentence, articleTitle: group.articleTitle }))
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dropsEntry = page.entry.sentenceCount <= 1

  const [mergeTargetId, setMergeTargetId] = useState('')
  const [mergeMainForm, setMergeMainForm] = useState(page.entry.mainForm)
  const [splitSentenceId, setSplitSentenceId] = useState(sentences[0]?.sentence.id ?? '')
  const [splitTarget, setSplitTarget] = useState(defaultSplitTarget())
  const [mainForm, setMainForm] = useState(page.entry.mainForm)
  const [moveNoteId, setMoveNoteId] = useState(page.notes[0]?.id ?? '')
  const [moveTarget, setMoveTarget] = useState('')

  const mergeTarget = otherEntries.find((entry) => entry.id === mergeTargetId) ?? null
  const splitChoice = sentences.find((choice) => choice.sentence.id === splitSentenceId) ?? null
  const moveNote = page.notes.find((note) => note.id === moveNoteId) ?? null

  /** 已经属于本词条的词形不能再建新词条；默认挑一个能用的目标。 */
  function defaultSplitTarget(choice: SentenceChoice | null = sentences[0] ?? null): string {
    if (choice === null) return ''
    if (choice.sentence.canSplitToNew) return 'new'
    return otherEntries[0]?.id ?? ''
  }

  const entryTargets: SearchableTarget[] = otherEntries.map((entry) => ({
    id: entry.id,
    label: entry.mainForm,
    detail: [entry.variants.length > 0 ? entry.variants.join('、') : '', `${entry.sentenceCount} 句`]
      .filter(Boolean)
      .join(' · ')
  }))
  const splitTargets: SearchableTarget[] = [
    ...(splitChoice?.sentence.canSplitToNew ?? true
      ? [{ id: 'new', label: '新词条', detail: '按这条原句的词形新建' }]
      : []),
    ...entryTargets
  ]

  async function submitMerge(): Promise<void> {
    if (mergeTarget === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await mergeEntries({
        sourceEntryId: mergeTarget.id,
        targetEntryId: page.entry.id,
        mainForm: mergeMainForm
      })
      if (result.status === 'merged') {
        onClose()
        const repeated =
          result.repeatedSentences > 0 ? `，其中 ${result.repeatedSentences} 条并成一条` : ''
        onChanged(`已把「${mergeTarget.mainForm}」并进来，迁入 ${result.movedSentences} 条原句${repeated}。`)
        return
      }
      if (result.status === 'rejected') {
        setError(
          result.reason === 'main-form'
            ? '合并后的主词形不在已收集的词形里。'
            : '不能把词条并到自己。'
        )
        return
      }
      setError('要合并的词条已经不在了。')
    } catch (reason) {
      setError(failureText(reason, '这次没有提交成功，再点一次提交。'))
    } finally {
      setBusy(false)
    }
  }

  async function submitSplit(): Promise<void> {
    if (splitChoice === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await moveEntrySentence({
        entrySentenceId: splitChoice.sentence.id,
        target: splitTarget === 'new' ? { kind: 'new' } : { kind: 'entry', entryId: splitTarget }
      })
      if (result.status === 'moved') {
        onClose()
        onChanged(`原句已拆到「${result.to.mainForm}」。`)
        if (result.from === null) {
          onEntryGone(page.entry.id)
        }
        return
      }
      if (result.status === 'missing') {
        setError('这条原句或目标词条已经不在了。')
        return
      }
      setError(
        result.reason === 'duplicate'
          ? '目标词条已经有这条原句了。'
          : '这条原句已经在这个词条里。'
      )
    } catch (reason) {
      setError(failureText(reason, '这次没有提交成功，再点一次提交。'))
    } finally {
      setBusy(false)
    }
  }

  async function submitMainForm(): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await changeEntryMainForm({ entryId: page.entry.id, mainForm })
      if (result.status === 'changed') {
        onClose()
        onChanged(`主词形已换成「${mainForm}」。`)
        return
      }
      if (result.status === 'rejected') {
        setError('这个词形没有收集过。')
        return
      }
      onEntryGone(page.entry.id)
    } catch (reason) {
      setError(failureText(reason, '这次没有提交成功，再点一次提交。'))
    } finally {
      setBusy(false)
    }
  }

  async function submitMoveNote(): Promise<void> {
    if (moveNote === null || moveTarget === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await moveLearningNote({ noteId: moveNote.id, entryId: moveTarget })
      if (result.status === 'saved') {
        const target = entries.find((entry) => entry.id === result.note.entryId)
        onClose()
        onChanged(`学习内容已移到「${target?.mainForm ?? '另一个词条'}」。`)
        return
      }
      if (result.status === 'rejected') {
        setError(result.reason === 'same-entry' ? '已经在这个词条里了。' : '目标词条已经不在了。')
        return
      }
      setError('这条学习内容已经不在了。')
    } catch (reason) {
      setError(failureText(reason, '这次没有提交成功，再点一次提交。'))
    } finally {
      setBusy(false)
    }
  }

  if (form === null) {
    return (
      <div className="entry-menu entry-menu-maintenance" role="menu" aria-label="词条维护">
        <button type="button" role="menuitem" className="entry-menu-item" onClick={() => onPick('merge')}>
          合并词条…
        </button>
        <button
          type="button"
          role="menuitem"
          className="entry-menu-item"
          disabled={sentences.length === 0}
          onClick={() => onPick('split')}
        >
          拆分原句…
        </button>
        <button
          type="button"
          role="menuitem"
          className="entry-menu-item"
          disabled={forms.length <= 1}
          onClick={() => onPick('main-form')}
        >
          换主词形…
        </button>
        <button
          type="button"
          role="menuitem"
          className="entry-menu-item"
          disabled={page.notes.length === 0}
          onClick={() => onPick('move-note')}
        >
          移动学习内容…
        </button>
      </div>
    )
  }

  return (
    <div className="entry-more-form" role="group" aria-label={formName(form)}>
      {form === 'merge' ? (
        <>
          <label className="entry-more-field">
            <span>把哪个词条并进来</span>
            <SearchableTargetPicker
              label="要并进来的词条"
              targets={entryTargets}
              value={mergeTargetId === '' ? null : mergeTargetId}
              onChange={(entryId) => {
                setMergeTargetId(entryId)
                setMergeMainForm(page.entry.mainForm)
                setError(null)
              }}
              emptyText="没有匹配的词条"
              autoFocus
            />
          </label>
          {mergeTarget !== null && mergeTarget.mainForm !== page.entry.mainForm ? (
            <fieldset className="entry-more-forms">
              <legend>合并后的主词形</legend>
              {[page.entry.mainForm, mergeTarget.mainForm].map((candidate) => (
                <label key={candidate}>
                  <input
                    type="radio"
                    name="entry-merge-main-form"
                    value={candidate}
                    checked={mergeMainForm === candidate}
                    onChange={() => setMergeMainForm(candidate)}
                  />
                  {candidate}
                </label>
              ))}
            </fieldset>
          ) : null}
          <p className="entry-more-hint">
            并进来的原句与学习内容都会移到「{page.entry.mainForm}」下，另一个词条消失。
          </p>
          <div className="entries-rail-actions">
            <button type="button" className="button" disabled={mergeTarget === null || busy} onClick={() => void submitMerge()}>
              合并
            </button>
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
          </div>
        </>
      ) : form === 'split' ? (
        <>
          <label className="entry-more-field">
            <span>拆哪一条</span>
            <select
              aria-label="要拆的原句"
              value={splitSentenceId}
              onChange={(event) => {
                const choice =
                  sentences.find((candidate) => candidate.sentence.id === event.target.value) ??
                  null
                setSplitSentenceId(event.target.value)
                setSplitTarget(defaultSplitTarget(choice))
              }}
            >
              {sentences.map((choice) => (
                <option key={choice.sentence.id} value={choice.sentence.id}>
                  {choice.sentence.surface} · {sentenceSourceText(choice.sentence)} ·{' '}
                  {choice.articleTitle}
                </option>
              ))}
            </select>
          </label>
          <label className="entry-more-field">
            <span>拆到</span>
            <SearchableTargetPicker
              label="拆到哪个词条"
              targets={splitTargets}
              value={splitTarget === '' ? null : splitTarget}
              onChange={setSplitTarget}
              emptyText="没有匹配的目标"
              autoFocus
            />
          </label>
          {splitChoice !== null &&
          !splitChoice.sentence.canSplitToNew &&
          otherEntries.length === 0 ? (
            <p className="entry-more-hint">这个表达已经属于这个词条，现在没有别的词条可拆。</p>
          ) : null}
          <div className="entries-rail-actions">
            <button
              type="button"
              className="button"
              disabled={splitChoice === null || splitTarget === '' || busy}
              onClick={() => void submitSplit()}
            >
              {dropsEntry ? '拆走并删除词条' : '拆过去'}
            </button>
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
          </div>
          {dropsEntry ? (
            <p className="entry-more-warning" role="alert">
              这是最后一条原句：拆走后「{page.entry.mainForm}」词条
              {page.entry.noteCount > 0 ? `与 ${page.entry.noteCount} 条学习内容` : ''}
              会一起删除。
            </p>
          ) : null}
        </>
      ) : form === 'main-form' ? (
        <>
          <label className="entry-more-field">
            <span>新的主词形</span>
            <select
              aria-label="新的主词形"
              value={mainForm}
              onChange={(event) => setMainForm(event.target.value)}
            >
              {forms.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </label>
          <div className="entries-rail-actions">
            <button type="button" className="button" disabled={busy} onClick={() => void submitMainForm()}>
              换主词形
            </button>
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
          </div>
        </>
      ) : (
        <>
          <label className="entry-more-field">
            <span>移动哪一条</span>
            <select
              aria-label="要移动的学习内容"
              value={moveNoteId}
              onChange={(event) => setMoveNoteId(event.target.value)}
            >
              {page.notes.map((note) => (
                <option key={note.id} value={note.id}>
                  {noteExcerpt(note.body)}
                </option>
              ))}
            </select>
          </label>
          <label className="entry-more-field">
            <span>移到</span>
            <SearchableTargetPicker
              label="移动到词条"
              targets={entryTargets}
              value={moveTarget === '' ? null : moveTarget}
              onChange={setMoveTarget}
              emptyText="没有匹配的词条"
              autoFocus
            />
          </label>
          <div className="entries-rail-actions">
            <button
              type="button"
              className="button"
              disabled={moveNote === null || moveTarget === '' || busy}
              onClick={() => void submitMoveNote()}
            >
              移过去
            </button>
            <button type="button" className="button" onClick={onClose}>
              取消
            </button>
          </div>
        </>
      )}

      {error === null ? null : (
        <p className="entry-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function formName(form: MoreForm): string {
  if (form === 'merge') return '合并词条'
  if (form === 'split') return '拆分原句'
  if (form === 'main-form') return '换主词形'
  return '移动学习内容'
}
