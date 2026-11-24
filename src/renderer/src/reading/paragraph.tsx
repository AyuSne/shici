import type { ReadingParagraph } from '../../../shared/reading'
import type { ReadingBlock, ReadingPart } from './content'

/** 页边眉批里的「我的拾词」一行：词条主词形与置顶学习内容摘要。 */
export type ReadingMarginNote = {
  entryId: string
  mainForm: string
  excerpt: string
}

/**
 * 一段正文的渲染：句子块、原文注释、页边眉批，以及已收集/本次选中的词状态。
 * 所有字符都来自块结构，组件不加工正文文字。
 */
export function ReadingParagraphView({
  paragraph,
  blocks,
  focusedSentenceOrdinal = null,
  focusedParagraph = false,
  showAnnotationRows = false,
  marginNotes = []
}: {
  paragraph: ReadingParagraph
  blocks: readonly ReadingBlock[]
  /** 从词条跳过来或搜索命中一句时，这一句整句底色高亮。 */
  focusedSentenceOrdinal?: number | null
  /**
   * 全局搜索跨句命中：没有单一句可定位，但段落是真实目标。
   * 整段标出来，不冒充某一句，也不写进原句定位 state。
   */
  focusedParagraph?: boolean
  /** 原卷注释是否出现在页边眉批里（眉批模式「全部」且注释可见）。 */
  showAnnotationRows?: boolean
  /** 本段已拾词里带置顶学习内容的那几条。 */
  marginNotes?: readonly ReadingMarginNote[]
}) {
  const marginVisible = marginNotes.length > 0 || (showAnnotationRows && paragraph.annotations.length > 0)
  return (
    <div className="reading-row">
      {paragraph.letter === null ? null : (
        <span className="reading-letter" aria-hidden="true">
          {paragraph.letter}
        </span>
      )}
      <p
        className={
          focusedParagraph ? 'reading-paragraph reading-paragraph-focused' : 'reading-paragraph'
        }
        data-paragraph-id={paragraph.id}
      >
        {blocks.map((block, index) =>
          block.kind === 'gap' ? (
            <span key={index}>{block.text}</span>
          ) : (
            <span
              key={index}
              className={
                block.ordinal === focusedSentenceOrdinal
                  ? 'reading-sentence reading-sentence-focused'
                  : 'reading-sentence'
              }
              data-paragraph-id={paragraph.id}
              data-paragraph-ordinal={paragraph.ordinal}
              data-sentence-ordinal={block.ordinal}
            >
              {block.parts.map((part, partIndex) => (
                <ReadingPartView key={partIndex} part={part} />
              ))}
            </span>
          )
        )}
      </p>
      {marginVisible ? (
        <aside className="reading-notes" aria-label="原文注释">
          {showAnnotationRows
            ? paragraph.annotations.map((annotation) => (
                <p className="reading-note" key={`${annotation.start}-${annotation.end}`}>
                  <span className="reading-note-word">{annotation.surface}</span>
                  <span className="reading-note-gloss">{annotation.gloss}</span>
                </p>
              ))
            : null}
          {marginNotes.map((note) => (
            <p className="reading-note reading-note-pinned" key={note.entryId}>
              <span className="reading-note-word">{note.mainForm}</span>
              <span className="reading-note-gloss">{note.excerpt}</span>
            </p>
          ))}
        </aside>
      ) : null}
    </div>
  )
}

function ReadingPartView({ part }: { part: ReadingPart }) {
  const mark = part.mark
  const className = [
    part.kind === 'annotation' ? 'reading-annotated' : '',
    mark === undefined ? '' : mark.selected ? 'reading-selected' : 'reading-collected',
    mark?.ink === true ? 'reading-ink' : '',
    mark?.masked === true ? 'reading-masked' : '',
    mark?.maskRevealed === true ? 'reading-mask-revealed' : ''
  ]
    .filter(Boolean)
    .join(' ')

  const entryId = mark?.entryId ?? null
  const markProps = {
    ...(mark?.markId === null || mark?.markId === undefined
      ? {}
      : { 'data-mark-id': mark.markId }),
    ...(entryId === null
      ? {}
      : {
          'data-entry-id': entryId,
          role: 'button',
          tabIndex: 0,
          'aria-label': `查看词条 ${mark?.label ?? ''}`
        }),
    ...(mark?.ink === true ? { 'data-ink': 'true' } : {}),
    ...(mark?.maskRevealed === true ? { 'data-revealed': 'true' } : {})
  }

  if (part.kind === 'annotation') {
    return (
      <span className={className || undefined} data-gloss={part.gloss} {...markProps}>
        <ReadingPartText text={part.text} masked={mark?.masked === true} />
      </span>
    )
  }
  return (
    <span className={className || undefined} {...markProps}>
      <ReadingPartText text={part.text} masked={mark?.masked === true} />
    </span>
  )
}

/** 轻遮重读只遮已收集词的词身；首字母作为线索留着，全文仍可被复制与读屏。 */
function ReadingPartText({ text, masked }: { text: string; masked: boolean }) {
  if (!masked) {
    return <>{text}</>
  }
  const characters = Array.from(text)
  if (characters.length === 0) {
    return null
  }
  return (
    <>
      <span className="reading-mask-hint">{characters[0]}</span>
      <span className="reading-mask-rest">{characters.slice(1).join('')}</span>
    </>
  )
}
