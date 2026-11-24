import type { ArticleWordsEntry } from '../../../shared/article-words'
import type { DictionarySense } from '../../../shared/dictionary'
import { DictionaryView } from '../dictionary/dictionary-view'
import { useDictionaryLookup } from '../dictionary/lookup'
import { phoneticText, posLabel } from '../dictionary/presentation'
import { splitSentenceSurface } from './article-words-format'

/**
 * 工作台里的一张词条卡：首屏直接给离线词典音标、首义与「有没有学习内容」；
 * 点词条原地展开完整词典，任一条释义可「用这条起草」。草稿、展开与稍后看都由
 * 页面按词条 id 持有，所以同一个词条在本篇几段出现时状态一致。
 */
export function ArticleWordsEntryCard({
  group,
  expanded,
  draft,
  draftError,
  saving,
  laterBusy,
  onToggle,
  onDraftChange,
  onSave,
  onToggleLater,
  onOpenEntry
}: {
  group: ArticleWordsEntry
  expanded: boolean
  draft: string
  draftError: string | null
  saving: boolean
  laterBusy: boolean
  onToggle: () => void
  onDraftChange: (value: string) => void
  onSave: () => void
  onToggleLater: () => void
  onOpenEntry: () => void
}) {
  const { entry, sentences } = group
  const { lookup, loading } = useDictionaryLookup(entry.mainForm)
  const found = lookup?.status === 'found' ? lookup.entry : null
  const phonetic = found === null ? '' : phoneticText(found.phonetic)
  const firstSense = found?.senses[0]
  const firstSenseText =
    firstSense === undefined ? '' : `${posLabel(firstSense.pos)} ${firstSense.text}`.trim()

  function draftFromDictionary(sense: DictionarySense): void {
    if (lookup === null || lookup.status !== 'found') return
    onDraftChange(
      [
        lookup.entry.phonetic === ''
          ? entry.mainForm
          : `${entry.mainForm} /${lookup.entry.phonetic}/`,
        `${posLabel(sense.pos)} ${sense.text}`.trim()
      ].join('\n')
    )
  }

  return (
    <li className="article-words-entry" data-entry-id={entry.id}>
      <button
        type="button"
        className="article-words-entry-link"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="article-words-entry-form">{entry.mainForm}</span>
        {phonetic === '' ? null : (
          <span className="article-words-entry-phonetic">{phonetic}</span>
        )}
        {firstSenseText === '' ? null : (
          <span className="article-words-entry-sense">{firstSenseText}</span>
        )}
        <span
          className="article-words-entry-status"
          data-has-notes={entry.noteCount > 0 ? 'true' : 'false'}
        >
          {entry.noteCount > 0 ? '有学习内容' : '没有学习内容'}
        </span>
      </button>

      <ul className="article-words-sentences">
        {sentences.map((sentence) => {
          const parts = splitSentenceSurface(sentence)
          return (
            <li key={sentence.id} className="article-words-sentence">
              {parts.before}
              {parts.surface === '' ? null : (
                <mark className="article-words-surface">{parts.surface}</mark>
              )}
              {parts.after}
            </li>
          )
        })}
      </ul>

      <div className="article-words-entry-actions">
        <button type="button" className="article-words-open-entry" onClick={onOpenEntry}>
          打开词条
        </button>
        <button
          type="button"
          className="article-words-later"
          aria-pressed={entry.laterMarkedAt !== null}
          disabled={laterBusy}
          onClick={onToggleLater}
        >
          {entry.laterMarkedAt !== null ? '取消稍后看' : '稍后看'}
        </button>
        <span className="article-words-entry-meta">
          {entry.sentenceCount} 条原句 · {entry.articleCount} 篇
        </span>
      </div>

      {expanded ? (
        <div className="article-words-dictionary">
          <DictionaryView lookup={lookup} loading={loading} onDraft={draftFromDictionary} />
        </div>
      ) : null}

      {draft === '' && draftError === null ? null : (
        <div className="article-words-draft-box">
          {draftError === null ? null : (
            <p className="article-words-draft-error" role="alert">
              {draftError}
            </p>
          )}
          <textarea
            className="article-words-draft"
            aria-label={`为 ${entry.mainForm} 写学习内容`}
            rows={4}
            value={draft}
            disabled={saving}
            onChange={(event) => onDraftChange(event.target.value)}
          />
          <div className="article-words-draft-actions">
            <button
              type="button"
              className="button button-primary article-words-save"
              disabled={saving || draft.trim() === ''}
              onClick={onSave}
            >
              {saving ? '正在保存…' : '保存学习内容'}
            </button>
            <button
              type="button"
              className="button article-words-draft-clear"
              disabled={saving}
              onClick={() => onDraftChange('')}
            >
              清掉草稿
            </button>
            <span className="article-words-draft-hint">草稿不会自动保存</span>
          </div>
        </div>
      )}
    </li>
  )
}
