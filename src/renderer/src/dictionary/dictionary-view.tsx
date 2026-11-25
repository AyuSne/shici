import { useEffect, useState } from 'react'
import type { DictionaryLookup, DictionarySense } from '../../../shared/dictionary'
import {
  formText,
  lemmaText,
  phoneticText,
  posLabel,
  SENSE_PREVIEW,
  statusText,
  visibleSenses
} from './presentation'

/**
 * 只读的词典释义块：音标、按词性分条的中文释义（前三条展开，其余折起）。
 * 阅读划词卡、词条页右栏与对话浮卡共用这一块；给出 onDraft 时每条释义多一个
 * 「用这条起草」，只填编辑框，不自动保存。
 */
export function DictionaryView({
  lookup,
  loading = false,
  showHead = true,
  onDraft
}: {
  lookup: DictionaryLookup | null
  loading?: boolean
  /** 调用方已在卡头展示词形与音标时，词典块不再重复一遍。 */
  showHead?: boolean
  onDraft?: (sense: DictionarySense) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const query = lookup?.query ?? ''

  // 换一个词就重新折起；同一个词的重查不打断展开状态。
  useEffect(() => {
    setExpanded(false)
  }, [query])

  if (loading) {
    return (
      <p className="dictionary-loading" aria-busy="true">
        正在查词典…
      </p>
    )
  }
  if (lookup === null) return null
  if (lookup.status !== 'found') {
    return <p className="dictionary-status">{statusText(lookup)}</p>
  }

  const { shown, hidden } = visibleSenses(lookup.entry.senses, expanded)
  const phonetic = phoneticText(lookup.entry.phonetic)
  const lemma = lemmaText(lookup)

  return (
    <div className="dictionary" role="group" aria-label="词典">
      {showHead ? (
        <div className="dictionary-head">
          <span className="dictionary-word">{lookup.entry.word}</span>
          {phonetic === '' ? null : <span className="dictionary-phonetic">{phonetic}</span>}
        </div>
      ) : null}
      {lemma === '' ? null : <p className="dictionary-lemma">{lemma}</p>}

      <ul className="dictionary-senses">
        {shown.map((sense, index) => (
          <li className="dictionary-sense" key={`${sense.pos}-${index}`}>
            {sense.pos === '' ? null : (
              <span className="dictionary-pos">{posLabel(sense.pos)}</span>
            )}
            <span className="dictionary-sense-text">{sense.text}</span>
            {onDraft === undefined ? null : (
              <button
                type="button"
                className="dictionary-draft"
                onClick={() => onDraft(sense)}
              >
                用这条起草
              </button>
            )}
          </li>
        ))}
      </ul>

      {lookup.entry.senses.length <= SENSE_PREVIEW ? null : expanded ? (
        <button type="button" className="dictionary-toggle" onClick={() => setExpanded(false)}>
          收起
        </button>
      ) : (
        <button type="button" className="dictionary-toggle" onClick={() => setExpanded(true)}>
          展开其余 {hidden} 条
        </button>
      )}

      {lookup.entry.forms.length === 0 ? null : (
        <p className="dictionary-forms">词形变化：{formText(lookup.entry.forms)}</p>
      )}
    </div>
  )
}
