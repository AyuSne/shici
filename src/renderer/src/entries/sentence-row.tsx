import { useEffect, useRef, useState } from 'react'
import type { EntrySentence } from '../../../shared/entries'
import { sentenceSourceText } from './format'

/**
 * 一条原句：原句文字里把当时圈下的词形标出来，下面写清楚它出处的段、句、页。
 * 高频动作只留「回到原文 / 前后句 / 问模型」；低频的重新圈定与删除收进 `···`。
 * 没有前后句时不渲染灰置按钮；有邻句时用 200ms 的 grid 拉帘原地展开。
 */
export function SentenceRow({
  sentence,
  focused = false,
  busy,
  onBack,
  onReselect,
  onAsk,
  onRequestDelete
}: {
  sentence: EntrySentence
  focused?: boolean
  busy: boolean
  onBack: () => void
  onReselect: () => void
  onAsk: () => void
  onRequestDelete: () => void
}) {
  const [neighborsOpen, setNeighborsOpen] = useState(false)
  /** 第一次展开才把邻句挂进 DOM：收起时不留一份重复正文给读取与定位添乱。 */
  const [neighborsMounted, setNeighborsMounted] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const hasNeighbors = sentence.previousSentence !== null || sentence.nextSentence !== null

  useEffect(() => {
    if (!menuOpen) return
    const onMouseDown = (event: MouseEvent): void => {
      if (menuRef.current?.contains(event.target as Node)) return
      setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

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
        {hasNeighbors ? (
          <button
            type="button"
            className="entry-action"
            aria-label="前后句"
            aria-expanded={neighborsOpen}
            onClick={() => {
              if (!neighborsOpen) setNeighborsMounted(true)
              setNeighborsOpen((open) => !open)
            }}
          >
            <span className="entry-action-icon" aria-hidden="true">
              ⋯
            </span>
            <span className="entry-action-label">前后句</span>
          </button>
        ) : null}
        <button type="button" className="entry-action" aria-label="问模型" onClick={onAsk}>
          <span className="entry-action-icon" aria-hidden="true">
            ✎
          </span>
          <span className="entry-action-label">问模型</span>
        </button>
        <div className="entry-sentence-more" ref={menuRef}>
          <button
            type="button"
            className="entry-action entry-action-more"
            aria-label="更多原句操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
          >
            ···
          </button>
          {menuOpen ? (
            <div className="entry-menu" role="menu" aria-label="原句操作">
              <button
                type="button"
                role="menuitem"
                className="entry-menu-item"
                onClick={() => {
                  setMenuOpen(false)
                  onReselect()
                }}
              >
                重新圈定
              </button>
              <button
                type="button"
                role="menuitem"
                className="entry-menu-item entry-action-danger"
                disabled={busy}
                onClick={() => {
                  setMenuOpen(false)
                  onRequestDelete()
                }}
              >
                删除
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div
        className="entry-neighbors-curtain"
        data-open={neighborsOpen ? 'true' : 'false'}
        aria-hidden={neighborsOpen ? undefined : true}
      >
        <div className="entry-neighbors-curtain-inner">
          {neighborsMounted && hasNeighbors ? (
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
        </div>
      </div>
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
