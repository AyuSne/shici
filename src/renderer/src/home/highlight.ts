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
    .sort(
      (left, right) =>
        left.start - right.start ||
        right.end - left.end ||
        left.entryId.localeCompare(right.entryId)
    )

  // 同一句里允许同时收一个词和包含它的短语（不同词条键）。高亮按字符并集算：
  // 重叠区只输出一次，但绝不因为「短的那段先到」就丢掉较长短语的后半段。
  type Group = { start: number; end: number; entryId: string; bestEnd: number; bestLength: number }
  const groups: Group[] = []
  for (const range of ranges) {
    const length = range.end - range.start
    const current = groups.at(-1)
    if (current === undefined || range.start >= current.end) {
      groups.push({
        start: range.start,
        end: range.end,
        entryId: range.entryId,
        bestEnd: range.end,
        bestLength: length
      })
      continue
    }
    current.end = Math.max(current.end, range.end)
    // 标记的 id 只用于数据属性；取覆盖最远、最长、再按 id 稳定排序的一条，
    // 保证同一份输入永远得到同一结果，不随传参顺序抖动。
    if (
      range.end > current.bestEnd ||
      (range.end === current.bestEnd && length > current.bestLength) ||
      (range.end === current.bestEnd &&
        length === current.bestLength &&
        range.entryId.localeCompare(current.entryId) < 0)
    ) {
      current.entryId = range.entryId
      current.bestEnd = range.end
      current.bestLength = length
    }
  }

  const segments: HomeSentenceSegment[] = []
  let cursor = 0
  for (const group of groups) {
    if (group.start > cursor) {
      segments.push({ text: sentenceText.slice(cursor, group.start), entryId: null })
    }
    segments.push({
      text: sentenceText.slice(group.start, group.end),
      entryId: group.entryId
    })
    cursor = group.end
  }
  if (cursor < sentenceText.length) {
    segments.push({ text: sentenceText.slice(cursor), entryId: null })
  }
  return segments
}
