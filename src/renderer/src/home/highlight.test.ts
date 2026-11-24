import { describe, expect, it } from 'vitest'
import { homeSentenceSegments } from './highlight'

/**
 * 首页续读原句的精确高亮：主进程给的是这一句里真实收下的区间，渲染层只按区间切，
 * 不按词形正则猜。没被收的相同词、区间外的内容、越界脏数据都不能误亮。
 */

describe('homeSentenceSegments', () => {
  it('按真实区间切出可标记片段，原文一字不改', () => {
    const text = 'Reading keeps reading alive and reading well.'
    const segments = homeSentenceSegments(text, [
      { entryId: 'e-1', mainForm: 'reading', surface: 'Reading', start: 0, end: 7 }
    ])
    expect(segments.map((segment) => segment.text).join('')).toBe(text)
    expect(segments).toEqual([
      { text: 'Reading', entryId: 'e-1' },
      { text: ' keeps reading alive and reading well.', entryId: null }
    ])
  })

  it('多个区间按位置切开；区间外的重复词保持普通文本', () => {
    const text = 'Reading keeps reading alive and reading well.'
    const segments = homeSentenceSegments(text, [
      { entryId: 'e-1', mainForm: 'reading', surface: 'Reading', start: 0, end: 7 },
      { entryId: 'e-2', mainForm: 'alive', surface: 'alive', start: 22, end: 27 }
    ])
    expect(segments).toEqual([
      { text: 'Reading', entryId: 'e-1' },
      { text: ' keeps reading ', entryId: null },
      { text: 'alive', entryId: 'e-2' },
      { text: ' and reading well.', entryId: null }
    ])
  })

  it('重叠区间取先给出的那一段，不重复输出文字', () => {
    const segments = homeSentenceSegments('alpha bravo', [
      { entryId: 'e-1', mainForm: 'alpha', surface: 'alpha', start: 0, end: 5 },
      { entryId: 'e-2', mainForm: 'alpha bravo', surface: 'alpha bravo', start: 0, end: 11 }
    ])
    expect(segments.map((segment) => segment.text).join('')).toBe('alpha bravo')
    expect(segments.filter((segment) => segment.entryId !== null)).toHaveLength(1)
    expect(segments[0]).toEqual({ text: 'alpha', entryId: 'e-1' })
  })

  it('越界、倒序、非整数区间与空文本都按普通文本处理', () => {
    const text = 'short sentence'
    expect(
      homeSentenceSegments(text, [
        { entryId: 'bad', mainForm: 'x', surface: 'x', start: -1, end: 3 },
        { entryId: 'bad', mainForm: 'x', surface: 'x', start: 5, end: 99 },
        { entryId: 'bad', mainForm: 'x', surface: 'x', start: 4, end: 2 },
        { entryId: 'bad', mainForm: 'x', surface: 'x', start: 1.5, end: 3 }
      ])
    ).toEqual([{ text, entryId: null }])
    expect(homeSentenceSegments('', [])).toEqual([])
  })
})
