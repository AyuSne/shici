import { describe, expect, it } from 'vitest'
import type { ReadingParagraph } from '../../../shared/reading'
import { buildReadingBlocks, paragraphText } from './content'

function paragraph(overrides: Partial<ReadingParagraph> = {}): ReadingParagraph {
  const text = 'Reading widely makes hard sentences easier. Context carries most of the meaning.'
  return {
    id: '1',
    ordinal: 0,
    letter: null,
    text,
    pageStart: 1,
    pageEnd: 1,
    sentences: [
      { ordinal: 0, text: text.slice(0, 43), start: 0, end: 43, page: 1 },
      { ordinal: 1, text: text.slice(44), start: 44, end: text.length, page: 1 }
    ],
    annotations: [],
    ...overrides
  }
}

describe('buildReadingBlocks', () => {
  it('按句切块，段落里的空格留在句间，拼回去与原文逐字一致', () => {
    const source = paragraph()
    const blocks = buildReadingBlocks(source)

    expect(blocks.map((block) => block.kind)).toEqual(['sentence', 'gap', 'sentence'])
    expect(blocks[1]).toEqual({ kind: 'gap', text: ' ' })
    expect(paragraphText(blocks)).toBe(source.text)
  })

  it('注释从句子正文里切出来，带词形与释义', () => {
    const source = paragraph({
      annotations: [
        { surface: 'Context', gloss: '语境', start: 44, end: 51, sentenceOrdinal: 1 }
      ]
    })

    const sentence = buildReadingBlocks(source)[2]
    expect(sentence).toMatchObject({
      kind: 'sentence',
      ordinal: 1,
      parts: [
        {
          kind: 'annotation',
          text: 'Context',
          gloss: '语境',
          start: 44,
          end: 51
        },
        { kind: 'text', text: ' carries most of the meaning.' }
      ]
    })
  })

  it('一句里多条注释按位置切开，注释在句首或句尾也不丢正文', () => {
    const source = paragraph({
      annotations: [
        { surface: 'meaning', gloss: '意思', start: 72, end: 79, sentenceOrdinal: 1 },
        { surface: 'Context', gloss: '语境', start: 44, end: 51, sentenceOrdinal: 1 }
      ]
    })

    const sentence = buildReadingBlocks(source)[2]
    expect(sentence?.kind === 'sentence' ? sentence.parts : []).toEqual([
      { kind: 'annotation', text: 'Context', gloss: '语境', start: 44, end: 51 },
      { kind: 'text', text: ' carries most of the ' },
      { kind: 'annotation', text: 'meaning', gloss: '意思', start: 72, end: 79 },
      { kind: 'text', text: '.' }
    ])
    expect(paragraphText(buildReadingBlocks(source))).toBe(source.text)
  })

  it('句首之前与末句之后的内容作为间隙保留', () => {
    const source = paragraph({
      text: '  Leading space stays. Trailing stays.  ',
      sentences: [
        { ordinal: 0, text: 'Leading space stays.', start: 2, end: 22, page: 1 },
        { ordinal: 1, text: 'Trailing stays.', start: 23, end: 38, page: 1 }
      ]
    })

    const blocks = buildReadingBlocks(source)
    expect(blocks[0]).toEqual({ kind: 'gap', text: '  ' })
    expect(blocks.at(-1)).toEqual({ kind: 'gap', text: '  ' })
    expect(paragraphText(blocks)).toBe(source.text)
  })

  it('没有注释时整段就是句子原文', () => {
    const source = paragraph({ annotations: [] })
    expect(paragraphText(buildReadingBlocks(source))).toBe(source.text)
  })

  it('已收集的词在句子里切成标记，前后文字一字不少', () => {
    const text = 'Reading widely makes hard sentences easier.'
    const source = paragraph({
      text,
      sentences: [{ ordinal: 0, text, start: 0, end: text.length, page: 1 }]
    })

    const blocks = buildReadingBlocks(source, [
      { entryId: 'entry-1', label: 'hard', start: 21, end: 25 }
    ])

    expect(blocks).toEqual([
      {
        kind: 'sentence',
        ordinal: 0,
        parts: [
          { kind: 'text', text: 'Reading widely makes ' },
          {
            kind: 'text',
            text: 'hard',
            mark: {
              entryId: 'entry-1',
              markId: null,
              label: 'hard',
              selected: false,
              ink: false,
              masked: false,
              maskRevealed: false
            }
          },
          { kind: 'text', text: ' sentences easier.' }
        ]
      }
    ])
    expect(paragraphText(blocks)).toBe(text)
  })

  it('本次选中压在已收集标记上时以本次选中为准', () => {
    const text = 'Reading widely makes hard sentences easier.'
    const source = paragraph({
      text,
      sentences: [{ ordinal: 0, text, start: 0, end: text.length, page: 1 }]
    })

    const blocks = buildReadingBlocks(source, [
      { entryId: 'entry-1', label: 'hard', start: 21, end: 25 },
      { entryId: 'entry-1', label: 'hard', start: 21, end: 25, selected: true }
    ])

    expect(blocks[0]).toMatchObject({
      kind: 'sentence',
      parts: [
        { kind: 'text', text: 'Reading widely makes ' },
        {
          kind: 'text',
          text: 'hard',
          mark: { entryId: 'entry-1', label: 'hard', selected: true }
        },
        { kind: 'text', text: ' sentences easier.' }
      ]
    })
  })

  it('原文注释与已收集标记落在同一个词上时，释义与标记都保留', () => {
    const source = paragraph({
      annotations: [
        { surface: 'Context', gloss: '语境', start: 44, end: 51, sentenceOrdinal: 1 }
      ]
    })

    const sentence = buildReadingBlocks(source, [
      { entryId: 'entry-1', label: 'Context', start: 44, end: 51 }
    ])[2]

    expect(sentence).toMatchObject({
      kind: 'sentence',
      parts: [
        {
          kind: 'annotation',
          text: 'Context',
          gloss: '语境',
          start: 44,
          end: 51,
          mark: { entryId: 'entry-1', label: 'Context', selected: false }
        },
        { kind: 'text', text: ' carries most of the meaning.' }
      ]
    })
    expect(paragraphText(buildReadingBlocks(source))).toBe(source.text)
  })

  it('相邻的两个已收集标记各自切开，不并成一块', () => {
    const text = 'Reading widely makes hard sentences easier.'
    const source = paragraph({
      text,
      sentences: [{ ordinal: 0, text, start: 0, end: text.length, page: 1 }]
    })

    const blocks = buildReadingBlocks(source, [
      { entryId: 'entry-1', label: 'hard', start: 21, end: 25 },
      { entryId: 'entry-2', label: 'sentences', start: 26, end: 35 }
    ])

    expect(blocks[0]).toMatchObject({
      parts: [
        { kind: 'text', text: 'Reading widely makes ' },
        { kind: 'text', text: 'hard', mark: { entryId: 'entry-1' } },
        { kind: 'text', text: ' ' },
        { kind: 'text', text: 'sentences', mark: { entryId: 'entry-2' } },
        { kind: 'text', text: ' easier.' }
      ]
    })
  })
})
