import { describe, expect, it } from 'vitest'
import { nextEntryId } from './keyboard'

const ids = ['a', 'b', 'c']

describe('nextEntryId', () => {
  it('↓ 从当前词条走到下一条，最后一条停住', () => {
    expect(nextEntryId(ids, 'a', 'down')).toBe('b')
    expect(nextEntryId(ids, 'c', 'down')).toBe('c')
  })

  it('↑ 从当前词条走到上一条，第一条停住', () => {
    expect(nextEntryId(ids, 'c', 'up')).toBe('b')
    expect(nextEntryId(ids, 'a', 'up')).toBe('a')
  })

  it('还没选词条时 ↓ 选第一条、↑ 选最后一条', () => {
    expect(nextEntryId(ids, null, 'down')).toBe('a')
    expect(nextEntryId(ids, null, 'up')).toBe('c')
  })

  it('列表为空或当前词条已不在列表里时给出可继续的落点', () => {
    expect(nextEntryId([], null, 'down')).toBeNull()
    expect(nextEntryId([], 'a', 'up')).toBeNull()
    expect(nextEntryId(ids, 'gone', 'down')).toBe('a')
  })
})
