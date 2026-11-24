import type { ReadingParagraph } from '../../../shared/reading'

/**
 * 选词的纯逻辑：把一次段内字符选区对到所在的句子，收紧两端空白，得到原样的词形。
 * 一次只收一句之内的词或短语；跨句、落在句间空隙、空选区都不收。
 */

export type ReadingSelection = {
  paragraphId: string
  /** 段内句序，0 起。 */
  sentenceOrdinal: number
  /** 段内字符区间，两端已去空白。 */
  start: number
  end: number
  /** 原文切片，逐字一致。 */
  surface: string
}

function isWhitespace(character: string | undefined): boolean {
  return character !== undefined && /\s/u.test(character)
}

/**
 * 英文词的字符：字母、数字，以及词内部的连字符与撇号。
 * 拖选落在词内部时，正是靠它把两端向外吸到完整词边界。
 */
function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}'’-]/u.test(character)
}

/** 真正的文字字符（字母或数字）；首尾标点都按它判断。 */
function isContentCharacter(character: string | undefined): boolean {
  return character !== undefined && /[\p{L}\p{N}]/u.test(character)
}

/**
 * 把一段与词的起止位置向外吸到完整英文词的边界，再剥掉首尾标点与空白。
 * 只在句子区间内吸附与剥离；两端越界时由调用方先收紧选区。
 */
export function snapWordBounds(
  text: string,
  start: number,
  end: number,
  limits: { start: number; end: number }
): { start: number; end: number } | null {
  let from = Math.max(start, limits.start)
  let to = Math.min(end, limits.end)
  if (to <= from) {
    return null
  }

  while (from < to && isWhitespace(text[from])) from += 1
  while (to > from && isWhitespace(text[to - 1])) to -= 1
  if (to <= from) {
    return null
  }

  // 起止落在单词内部：只要相邻字符仍是词字符就继续向外，连字符与撇号一起带上。
  while (from > limits.start && isWordCharacter(text[from - 1]) && isWordCharacter(text[from])) {
    from -= 1
  }
  while (to < limits.end && isWordCharacter(text[to - 1]) && isWordCharacter(text[to])) {
    to += 1
  }

  // 首尾的括号、引号、逗号、句号等标点不属于词形。
  while (from < to && !isContentCharacter(text[from])) from += 1
  while (to > from && !isContentCharacter(text[to - 1])) to -= 1
  if (to <= from) {
    return null
  }

  return { start: from, end: to }
}

export function locateSelection(
  paragraph: ReadingParagraph,
  start: number,
  end: number
): ReadingSelection | null {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    return null
  }
  if (start < 0 || end > paragraph.text.length || end <= start) {
    return null
  }

  const sentence = paragraph.sentences.find(
    (candidate) => start >= candidate.start && start < candidate.end
  )
  if (!sentence) {
    return null
  }
  // 跨句的选区可能只是想把整句抄走，不该留下一条原句记录。
  // 句尾标点之后多拖了一两个字符（常是空白）仍算这一句，吸附后再定。
  if (end > sentence.end && /[\p{L}\p{N}]/u.test(paragraph.text.slice(sentence.end, end))) {
    return null
  }

  const snapped = snapWordBounds(paragraph.text, start, end, {
    start: sentence.start,
    end: sentence.end
  })
  if (snapped === null) {
    return null
  }

  return {
    paragraphId: paragraph.id,
    sentenceOrdinal: sentence.ordinal,
    start: snapped.start,
    end: snapped.end,
    surface: paragraph.text.slice(snapped.start, snapped.end)
  }
}

/**
 * 双击落点的英文词：从光标所在字符向两端吸附，得到完整词形。
 * 落在空白、标点或句外时为 null，交给界面保持原样。
 */
export function locateWordAt(
  paragraph: ReadingParagraph,
  offset: number
): ReadingSelection | null {
  if (!Number.isInteger(offset) || offset < 0 || offset >= paragraph.text.length) {
    return null
  }
  if (!isWordCharacter(paragraph.text[offset])) {
    return null
  }
  return locateSelection(paragraph, offset, offset + 1)
}

/**
 * 把浏览器选区落到段落里的某一段字符上。双击时用它把浏览器可能只选中半个
 * 连字符词的范围换成完整词形，再走同一套收词流程。
 */
export function selectParagraphRange(
  paragraph: HTMLElement,
  start: number,
  end: number
): boolean {
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
  const nodes: { node: Text; start: number }[] = []
  let length = 0
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    nodes.push({ node, start: length })
    length += node.textContent?.length ?? 0
  }
  if (start < 0 || end > length || end <= start) {
    return false
  }
  const locate = (offset: number): [Text, number] | null => {
    for (const entry of nodes) {
      const nodeLength = entry.node.textContent?.length ?? 0
      if (offset >= entry.start && offset <= entry.start + nodeLength) {
        return [entry.node, offset - entry.start]
      }
    }
    return null
  }
  const from = locate(start)
  const to = locate(end)
  if (from === null || to === null) {
    return false
  }
  const range = document.createRange()
  range.setStart(from[0], from[1])
  range.setEnd(to[0], to[1])
  const selection = window.getSelection()
  if (selection === null) {
    return false
  }
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

/**
 * 当前浏览器选区相对所在段落正文的起止字符位置。选区跨出这一段落时返回 null，
 * 交给界面给出「一次圈一个词或短语」的提示。
 */
export function selectionOffsets(paragraph: HTMLElement): { start: number; end: number } | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null
  }

  const range = selection.getRangeAt(0)
  if (
    !paragraph.contains(range.startContainer) ||
    !paragraph.contains(range.endContainer)
  ) {
    return null
  }

  const prefix = document.createRange()
  prefix.selectNodeContents(paragraph)
  prefix.setEnd(range.startContainer, range.startOffset)
  const start = prefix.toString().length
  return { start, end: start + range.toString().length }
}

export type ParagraphSelection = {
  paragraph: ReadingParagraph
  selection: ReadingSelection
}

/**
 * 把浏览器里当前的选区落成「哪一段、哪一句、哪几个字符」。选区不存在、
 * 跨段或落在句间空隙时返回 null；段落解析留在这里，阅读页只负责拿结果。
 */
export function readParagraphSelection(
  paragraphs: readonly ReadingParagraph[]
): ParagraphSelection | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null
  }

  const range = selection.getRangeAt(0)
  const startElement =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement
  const paragraphElement = startElement?.closest<HTMLElement>('.reading-paragraph') ?? null
  if (paragraphElement === null) {
    return null
  }
  const paragraphId = paragraphElement.dataset.paragraphId
  const paragraph = paragraphs.find((candidate) => candidate.id === paragraphId)
  if (!paragraph) {
    return null
  }
  const offsets = selectionOffsets(paragraphElement)
  if (offsets === null) {
    return null
  }
  const located = locateSelection(paragraph, offsets.start, offsets.end)
  return located === null ? null : { paragraph, selection: located }
}

export type ReadingExcerpt = { text: string; paragraphIds: string[]; source: string }
type ExcerptPoint = { paragraphId: string; offset: number }

/** 从原文而不是 DOM 的附加文字拼出摘录；单句选区仍交给选词流程。 */
export function assembleExcerpt(
  paragraphs: readonly ReadingParagraph[], start: ExcerptPoint, end: ExcerptPoint
): ReadingExcerpt | null {
  const first = paragraphs.findIndex((p) => p.id === start.paragraphId)
  const last = paragraphs.findIndex((p) => p.id === end.paragraphId)
  if (first < 0 || last < first || !Number.isInteger(start.offset) || !Number.isInteger(end.offset)) return null
  const startParagraph = paragraphs[first]!
  const endParagraph = paragraphs[last]!
  if (start.offset < 0 || start.offset > startParagraph.text.length || end.offset < 0 || end.offset > endParagraph.text.length || (first === last && end.offset <= start.offset)) return null
  const pieces = paragraphs.slice(first, last + 1).map((p, index) => {
    const from = index === 0 ? start.offset : 0
    const to = index === last - first ? end.offset : p.text.length
    return { paragraph: p, from, to, text: p.text.slice(from, to).trim() }
  }).filter((piece) => piece.text !== '')
  const sentences = pieces.reduce((count, piece) => count + piece.paragraph.sentences.filter((sentence) => piece.from < sentence.end && piece.to > sentence.start).length, 0)
  if (pieces.length === 0 || (pieces.length === 1 && sentences < 2)) return null
  const labels = pieces.map(({ paragraph }) => `段 ${paragraph.letter ?? paragraph.ordinal + 1}`)
  return { text: pieces.map((piece) => piece.text).join('\n\n'), paragraphIds: pieces.map((piece) => piece.paragraph.id), source: labels.join('、') }
}

/** 选区两端必须落在正文段落里，避免把页边注或其他控件带进去。 */
export function readReadingExcerpt(paragraphs: readonly ReadingParagraph[]): (ReadingExcerpt & { rect: DOMRect }) | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const point = (node: Node, offset: number): ExcerptPoint | null => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
    const paragraph = element?.closest<HTMLElement>('.reading-paragraph')
    if (!paragraph?.dataset.paragraphId) return null
    const prefix = document.createRange()
    prefix.selectNodeContents(paragraph)
    prefix.setEnd(node, offset)
    return { paragraphId: paragraph.dataset.paragraphId, offset: prefix.toString().length }
  }
  const start = point(range.startContainer, range.startOffset)
  const end = point(range.endContainer, range.endOffset)
  if (!start || !end) return null
  const excerpt = assembleExcerpt(paragraphs, start, end)
  return excerpt ? { ...excerpt, rect: range.getBoundingClientRect() } : null
}
