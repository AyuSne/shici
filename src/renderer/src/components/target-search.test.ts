import { describe, expect, it } from 'vitest'
import { filterTargets, moveActiveIndex } from './target-search'

const targets = [
  { id: 'a', label: 'approach', detail: 'approached · approaches' },
  { id: 'b', label: 'Context', detail: '' },
  { id: 'c', label: 'a passage about learning', detail: '' }
]

describe('filterTargets', () => {
  it('空查询保留全部目标，输入后按主标签即时过滤', () => {
    expect(filterTargets(targets, '')).toEqual(targets)
    expect(filterTargets(targets, 'con').map((target) => target.id)).toEqual(['b'])
  })

  it('匹配忽略大小写与首尾空白，也匹配已收集变体说明', () => {
    expect(filterTargets(targets, '  APPROACHED ').map((target) => target.id)).toEqual(['a'])
  })

  it('没有匹配时返回空列表，不退回全部', () => {
    expect(filterTargets(targets, 'zebra')).toEqual([])
  })
})

describe('moveActiveIndex', () => {
  it('↓ 从无选中落到第一项，逐项下移并在末尾停住', () => {
    expect(moveActiveIndex(3, -1, 'down')).toBe(0)
    expect(moveActiveIndex(3, 0, 'down')).toBe(1)
    expect(moveActiveIndex(3, 2, 'down')).toBe(2)
  })

  it('↑ 从无选中落到最后一项，逐项上移并在开头停住', () => {
    expect(moveActiveIndex(3, -1, 'up')).toBe(2)
    expect(moveActiveIndex(3, 1, 'up')).toBe(0)
    expect(moveActiveIndex(3, 0, 'up')).toBe(0)
  })

  it('没有候选时保持无选中', () => {
    expect(moveActiveIndex(0, -1, 'down')).toBe(-1)
    expect(moveActiveIndex(0, 4, 'up')).toBe(-1)
  })
})
