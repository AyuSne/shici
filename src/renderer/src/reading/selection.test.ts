import { describe, expect, it } from 'vitest'
import type { ReadingParagraph } from '../../../shared/reading'
import { assembleExcerpt, locateSelection } from './selection'

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

  it('只按圈到的字符收，不自动扩成整词', () => {
    expect(locateSelection(paragraph(), 6, 10)).toMatchObject({ surface: 'sent' })
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


describe('自由摘录', () => {
  it('按原文拼接跨句与跨段选区并保留段落出处', () => {
    const first = paragraph()
    const second = { ...paragraph(), id: '2', ordinal: 1, letter: 'B', text: 'A second paragraph.', sentences: [{ ordinal: 0, text: 'A second paragraph.', start: 0, end: 19, page: 1 }] }
    expect(assembleExcerpt([first, second], { paragraphId: '1', offset: 6 }, { paragraphId: '1', offset: 36 })).toMatchObject({ text: 'sentence here. Second sentence', paragraphIds: ['1'] })
    expect(assembleExcerpt([first, second], { paragraphId: '1', offset: 28 }, { paragraphId: '2', offset: 8 })).toMatchObject({ text: 'sentence follows.\n\nA second', paragraphIds: ['1', '2'] })
    expect(assembleExcerpt([first, second], { paragraphId: '1', offset: 6 }, { paragraphId: '1', offset: 14 })).toBeNull()
  })
})
