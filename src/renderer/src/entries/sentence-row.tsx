import { useState } from 'react'
import type { EntrySentence } from '../../../shared/entries'
import { sentenceSourceText } from './format'

/**
 * 一条原句：原句文字里把当时圈下的词形标出来，下面写清楚它出处的段、句、页。
 * 回到原文 / 重新圈定 / 前后句 / 删除 在悬停与键盘聚焦时出现，<900px 改成常驻小图标行。
 * 拆分原句与换主词形在右栏「更多」里。
 */
export function SentenceRow({
  sentence,
  focused = false,
  busy,
  onBack,
  onReselect,
  onAsk,
  onAskNew,
  onRequestDelete
}: {
  sentence: EntrySentence
  focused?: boolean
  busy: boolean
  onBack: () => void
  onReselect: () => void
  onAsk: () => void
  onAskNew: () => void
  onRequestDelete: () => void
}) {
  const [neighborsOpen, setNeighborsOpen] = useState(false)
  const hasNeighbors = sentence.previousSentence !== null || sentence.nextSentence !== null

  return (
    <li className="entry-sentence" data-entry-sentence-id={sentence.id} data-focused={focused ? 'true' : undefined}>
      <blockquote className="entry-sentence-text">
        <SentenceText sentence={sentence} />
      </blockquote>
      <p className="entry-sentence-source">{sentenceSourceText(sentence)}</p>

      <div className="entry-sentence-actions">
        <button type="button" className="entry-action" aria-label="回到原文" onClick={onBack}>
          <span className="entry-action-icon" aria-hidden="true">
            ↗
          </span>
          <span className="entry-action-label">回到原文</span>
        </button>
        <button type="button" className="entry-action" aria-label="重新圈定" onClick={onReselect}>
          <span className="entry-action-icon" aria-hidden="true">
            ⟳
          </span>
          <span className="entry-action-label">重新圈定</span>
        </button>
        <button type="button" className="entry-action" aria-label="用这句提问" onClick={onAsk}>
          <span className="entry-action-icon" aria-hidden="true">
            ✎
          </span>
          <span className="entry-action-label">提问</span>
        </button>
        <button type="button" className="entry-action" aria-label="为这句新建对话" title="为这句新建对话" onClick={onAskNew}>
          <span className="entry-action-icon" aria-hidden="true">＋</span>
          <span className="entry-action-label">新建对话</span>
        </button>
        <button
          type="button"
          className="entry-action"
          aria-label="前后句"
          aria-expanded={neighborsOpen}
          disabled={!hasNeighbors}
          onClick={() => setNeighborsOpen((open) => !open)}
        >
          <span className="entry-action-icon" aria-hidden="true">
            ⋯
          </span>
          <span className="entry-action-label">前后句</span>
        </button>
        <button
          type="button"
          className="entry-action entry-action-danger"
          aria-label="删除"
          disabled={busy}
          onClick={onRequestDelete}
        >
          <span className="entry-action-icon" aria-hidden="true">
            ×
          </span>
          <span className="entry-action-label">删除</span>
        </button>
      </div>

      {neighborsOpen ? (
        <div className="entry-neighbors" role="group" aria-label="同篇前后句">
          {sentence.previousSentence === null ? null : (
            <p className="entry-neighbor">
              <span className="entry-neighbor-label">上一句</span>
              {sentence.previousSentence}
            </p>
          )}
          {sentence.nextSentence === null ? null : (
            <p className="entry-neighbor">
              <span className="entry-neighbor-label">下一句</span>
              {sentence.nextSentence}
            </p>
          )}
        </div>
      ) : null}
    </li>
  )
}

/** 原句里把当时圈下的词形标出来；位置对不上就退化成整句。 */
function SentenceText({ sentence }: { sentence: EntrySentence }) {
  const start = sentence.surfaceOffset
  const end = start + sentence.surface.length
  if (start < 0 || end > sentence.sentenceText.length) {
    return <>{sentence.sentenceText}</>
  }
  return (
    <>
      {sentence.sentenceText.slice(0, start)}
      <mark className="entry-surface">{sentence.surface}</mark>
      {sentence.sentenceText.slice(end)}
    </>
  )
}
