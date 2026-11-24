import { describe, expect, it } from 'vitest'
import type { ReadingParagraph } from '../../../shared/reading'
import { assembleExcerpt, locateSelection, locateWordAt } from './selection'

function paragraph(): ReadingParagraph {
  const text = 'First sentence here. Second sentence follows.'
  return {
    id: '1',
    ordinal: 0,
    letter: null,
    text,
    pageStart: 1,
    pageEnd: 1,
    sentences: [
      { ordinal: 0, text: 'First sentence here.', start: 0, end: 20, page: 1 },
      { ordinal: 1, text: 'Second sentence follows.', start: 21, end: 45, page: 1 }
    ],
    annotations: []
  }
}

describe('locateSelection', () => {
  it('段内选区落到所在句子，带段内字符区间与原样词形', () => {
    expect(locateSelection(paragraph(), 6, 14)).toEqual({
      paragraphId: '1',
      sentenceOrdinal: 0,
      start: 6,
      end: 14,
      surface: 'sentence'
    })

    expect(locateSelection(paragraph(), 28, 36)).toMatchObject({
      sentenceOrdinal: 1,
      surface: 'sentence'
    })
  })

  it('选区两端的空白收紧，词形仍与原文逐字一致', () => {
    expect(locateSelection(paragraph(), 5, 15)).toEqual({
      paragraphId: '1',
      sentenceOrdinal: 0,
      start: 6,
      end: 14,
      surface: 'sentence'
    })
  })

  it('圈到词内部时会吸成整词，不再留下半截词形', () => {
    expect(locateSelection(paragraph(), 6, 10)).toMatchObject({
      start: 6,
      end: 14,
      surface: 'sentence'
    })
  })

  it('跨句、落在句间空隙、空选区与越界都不收', () => {
    expect(locateSelection(paragraph(), 0, 30)).toBeNull()
    expect(locateSelection(paragraph(), 6, 22)).toBeNull()
    expect(locateSelection(paragraph(), 20, 21)).toBeNull()
    expect(locateSelection(paragraph(), 6, 6)).toBeNull()
    expect(locateSelection(paragraph(), 5, 6)).toBeNull()
    expect(locateSelection(paragraph(), 0, 999)).toBeNull()
    expect(locateSelection(paragraph(), -1, 4)).toBeNull()
  })
})


/**
 * 带连字符与首尾标点的段落。字符位置按原文列出，测试只按规格给字面量：
 * `A well-known author wrote this, quietly.`（句内 0..40）
 */
function punctuationParagraph(): ReadingParagraph {
  const text = 'A well-known author wrote this, quietly.'
  return {
    id: '2',
    ordinal: 0,
    letter: null,
    text,
    pageStart: 1,
    pageEnd: 1,
    sentences: [{ ordinal: 0, text, start: 0, end: text.length, page: 1 }],
    annotations: []
  }
}

/** 词被括号与逗号包着的一句，用来核对首尾标点。 */
function bracketedParagraph(): ReadingParagraph {
  const text = 'She read (quietly), then left.'
  return {
    id: '3',
    ordinal: 0,
    letter: null,
    text,
    pageStart: 1,
    pageEnd: 1,
    sentences: [{ ordinal: 0, text, start: 0, end: text.length, page: 1 }],
    annotations: []
  }
}

describe('拖选吸附英文词边界', () => {
  it('拖选落在英文单词内部时，两端向外吸附到完整词边界（连字符词也整词）', () => {
    expect(locateSelection(punctuationParagraph(), 4, 9)).toMatchObject({
      start: 2,
      end: 12,
      surface: 'well-known'
    })
    expect(locateSelection(punctuationParagraph(), 14, 17)).toMatchObject({
      start: 13,
      end: 19,
      surface: 'author'
    })
  })

  it('吸附后剥掉首尾的括号、逗号与空白，只留词本身', () => {
    expect(locateSelection(bracketedParagraph(), 9, 18)).toMatchObject({
      start: 10,
      end: 17,
      surface: 'quietly'
    })
    expect(locateSelection(bracketedParagraph(), 9, 19)).toMatchObject({
      start: 10,
      end: 17,
      surface: 'quietly'
    })
  })
})

describe('双击定位英文词', () => {
  it('落在单词任意字符上都落成完整词形，连字符词整词算一个', () => {
    expect(locateWordAt(punctuationParagraph(), 5)).toMatchObject({
      start: 2,
      end: 12,
      surface: 'well-known'
    })
    expect(locateWordAt(punctuationParagraph(), 15)).toMatchObject({
      start: 13,
      end: 19,
      surface: 'author'
    })
  })

  it('落在空白、标点或句外时不猜词', () => {
    expect(locateWordAt(punctuationParagraph(), 1)).toBeNull()
    expect(locateWordAt(punctuationParagraph(), 12)).toBeNull()
    expect(locateWordAt(punctuationParagraph(), 30)).toBeNull()
    expect(locateWordAt(punctuationParagraph(), -1)).toBeNull()
  })
})

describe('自由摘录', () => {
  it('按原文拼接跨句与跨段选区并保留段落出处', () => {
    const first = paragraph()
    const second = { ...paragraph(), id: '2', ordinal: 1, letter: 'B', text: 'A second paragraph.', sentences: [{ ordinal: 0, text: 'A second paragraph.', start: 0, end: 19, page: 1 }] }
    expect(assembleExcerpt([first, second], { paragraphId: '1', offset: 6 }, { paragraphId: '1', offset: 36 })).toMatchObject({ text: 'sentence here. Second sentence', paragraphIds: ['1'] })
    expect(assembleExcerpt([first, second], { paragraphId: '1', offset: 28 }, { paragraphId: '2', offset: 8 })).toMatchObject({ text: 'sentence follows.\n\nA second', paragraphIds: ['1', '2'] })
    expect(assembleExcerpt([first, second], { paragraphId: '1', offset: 6 }, { paragraphId: '1', offset: 14 })).toBeNull()
  })
})
