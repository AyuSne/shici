import type { ReadingParagraph } from '../../../shared/reading'

/**
 * 把一段正文切成「句子块」与句间空隙，句子块里再按原文注释与已收集标记切成文字片段。
 * 渲染层只认这些块：正文文字一个不多一个不少，注释单独成段，绝不把注释
 * 拼回正文——复制与交给模型的文本因此天然是剥离注释后的英文。
 */

/** 一处已收集或本次选中的标记，落在段内字符区间上。 */
export type ReadingHighlight = {
  /** 已收集的词条 id；本次选中还没落库时为 null。 */
  entryId: string | null
  /** 已收集关联 id；悬停一瞥靠它找到对应标记。 */
  markId?: string
  /** 词条主词形，点击时用作无障碍标签。 */
  label: string
  start: number
  end: number
  /** 本次选中用麦色底；缺省是已收集的弱高亮。 */
  selected?: boolean
  /** 刚收下时在正文落墨扫过；只影响这一处，不常驻。 */
  ink?: boolean
  /** 轻遮重读：已收集词只露首字母。 */
  masked?: boolean
  /** 这一处已经被轻点揭开。 */
  maskRevealed?: boolean
}

/** 渲染到片段上的标记；同一片段只保留优先级最高的一个。 */
export type ReadingMark = {
  entryId: string | null
  markId: string | null
  label: string
  selected: boolean
  ink: boolean
  masked: boolean
  maskRevealed: boolean
}

export type ReadingTextPart = {
  kind: 'text'
  text: string
  mark?: ReadingMark
}

export type ReadingAnnotationPart = {
  kind: 'annotation'
  /** 原词/短语本身。 */
  text: string
  gloss: string
  /** 段内字符区间。 */
  start: number
  end: number
  mark?: ReadingMark
}

export type ReadingPart = ReadingTextPart | ReadingAnnotationPart

export type ReadingBlock =
  | {
      kind: 'sentence'
      /** 段内句序，0 起。 */
      ordinal: number
      parts: ReadingPart[]
    }
  | {
      kind: 'gap'
      /** 句与句之间（以及段首段尾）的空隙，原样保留。 */
      text: string
    }

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(value)))
}

function sameMark(left: ReadingMark | undefined, right: ReadingMark | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right
  }
  return (
    left.entryId === right.entryId &&
    left.markId === right.markId &&
    left.selected === right.selected &&
    left.ink === right.ink &&
    left.masked === right.masked &&
    left.maskRevealed === right.maskRevealed &&
    left.label === right.label
  )
}

function appendPart(parts: ReadingPart[], part: ReadingPart): void {
  const previous = parts.at(-1)
  if (previous === undefined || previous.kind !== part.kind) {
    parts.push(part)
    return
  }
  if (!sameMark(previous.mark, part.mark)) {
    parts.push(part)
    return
  }
  if (previous.kind === 'text' && part.kind === 'text') {
    previous.text += part.text
    return
  }
  if (
    previous.kind === 'annotation' &&
    part.kind === 'annotation' &&
    previous.gloss === part.gloss &&
    previous.start === part.start &&
    previous.end === part.end
  ) {
    previous.text += part.text
    return
  }
  parts.push(part)
}

/**
 * 把一段正文切成阅读页要渲染的块。`highlights` 里已收集的词与本次选中的词
 * 都会在句子内切开；同一段文字重叠时本次选中优先，其次是已收集。
 */
export function buildReadingBlocks(
  paragraph: ReadingParagraph,
  highlights: readonly ReadingHighlight[] = []
): ReadingBlock[] {
  const { text } = paragraph
  const annotations = [...paragraph.annotations].sort((left, right) => left.start - right.start)
  const sentences = [...paragraph.sentences].sort((left, right) => left.ordinal - right.ordinal)
  const marks = highlights
    .filter((highlight) => highlight.end > highlight.start)
    .sort((left, right) => left.start - right.start || left.end - right.end)

  const blocks: ReadingBlock[] = []
  let cursor = 0

  for (const sentence of sentences) {
    const start = clamp(sentence.start, text.length)
    const end = clamp(sentence.end, text.length)
    if (end <= start || start < cursor) {
      continue
    }

    if (start > cursor) {
      blocks.push({ kind: 'gap', text: text.slice(cursor, start) })
    }

    const sentenceAnnotations = annotations.filter(
      (annotation) => annotation.end > start && annotation.start < end
    )
    const sentenceMarks = marks.filter((mark) => mark.end > start && mark.start < end)

    const boundaries = new Set<number>([start, end])
    for (const annotation of sentenceAnnotations) {
      boundaries.add(clamp(annotation.start, end))
      boundaries.add(clamp(annotation.end, end))
    }
    for (const mark of sentenceMarks) {
      boundaries.add(clamp(mark.start, end))
      boundaries.add(clamp(mark.end, end))
    }
    const points = [...boundaries].sort((left, right) => left - right)

    const parts: ReadingPart[] = []
    for (let index = 0; index < points.length - 1; index += 1) {
      const segmentStart = points[index] as number
      const segmentEnd = points[index + 1] as number
      if (segmentEnd <= segmentStart) {
        continue
      }

      const annotation = sentenceAnnotations.find(
        (candidate) => candidate.start <= segmentStart && candidate.end >= segmentEnd
      )
      const selected = sentenceMarks.find(
        (candidate) => candidate.selected === true && candidate.start <= segmentStart && candidate.end >= segmentEnd
      )
      const collected = sentenceMarks.find(
        (candidate) => candidate.selected !== true && candidate.start <= segmentStart && candidate.end >= segmentEnd
      )
      const mark =
        selected !== undefined
          ? {
              entryId: selected.entryId,
              markId: selected.markId ?? null,
              label: selected.label,
              selected: true,
              ink: selected.ink === true,
              masked: false,
              maskRevealed: false
            }
          : collected !== undefined
            ? {
                entryId: collected.entryId,
                markId: collected.markId ?? null,
                label: collected.label,
                selected: false,
                ink: collected.ink === true,
                masked: collected.masked === true,
                maskRevealed: collected.maskRevealed === true
              }
            : undefined

      if (annotation) {
        appendPart(parts, {
          kind: 'annotation',
          text: text.slice(segmentStart, segmentEnd),
          gloss: annotation.gloss,
          start: annotation.start,
          end: annotation.end,
          ...(mark === undefined ? {} : { mark })
        })
      } else {
        appendPart(parts, {
          kind: 'text',
          text: text.slice(segmentStart, segmentEnd),
          ...(mark === undefined ? {} : { mark })
        })
      }
    }

    blocks.push({ kind: 'sentence', ordinal: sentence.ordinal, parts })
    cursor = end
  }

  if (cursor < text.length) {
    blocks.push({ kind: 'gap', text: text.slice(cursor) })
  }

  return blocks
}

/** 块拼回来的纯正文，与段落原文逐字一致。 */
export function paragraphText(blocks: readonly ReadingBlock[]): string {
  return blocks
    .map((block) =>
      block.kind === 'gap' ? block.text : block.parts.map((part) => part.text).join('')
    )
    .join('')
}
