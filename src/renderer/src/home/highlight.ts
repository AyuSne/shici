import type { HomeSentenceHighlight } from '../../../shared/library'

/**
 * 首页续读原句的精确切片：主进程给的是这一句里真实收下的句内区间，
 * 这里只按区间切文字，不拿 mainForm 去正则猜。原文一个字不改。
 */
export type HomeSentenceSegment = {
  text: string
  entryId: string | null
}

function validRange(
  highlight: HomeSentenceHighlight,
  length: number
): highlight is HomeSentenceHighlight {
  return (
    Number.isInteger(highlight.start) &&
    Number.isInteger(highlight.end) &&
    highlight.start >= 0 &&
    highlight.end <= length &&
    highlight.end > highlight.start
  )
}

export function homeSentenceSegments(
  sentenceText: string,
  highlights: readonly HomeSentenceHighlight[]
): HomeSentenceSegment[] {
  if (sentenceText === '') return []
  const ranges = highlights
    .filter((highlight) => validRange(highlight, sentenceText.length))
    .sort((left, right) => left.start - right.start || left.end - right.end)

  const segments: HomeSentenceSegment[] = []
  let cursor = 0
  for (const range of ranges) {
    // 重叠区间只认先给出的那一段（排序后靠前、较窄）；不重复输出文字。
    if (range.start < cursor) continue
    if (range.start > cursor) {
      segments.push({ text: sentenceText.slice(cursor, range.start), entryId: null })
    }
    segments.push({ text: sentenceText.slice(range.start, range.end), entryId: range.entryId })
    cursor = range.end
  }
  if (cursor < sentenceText.length) {
    segments.push({ text: sentenceText.slice(cursor), entryId: null })
  }
  return segments
}
