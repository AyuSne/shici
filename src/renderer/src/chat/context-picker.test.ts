import { describe, expect, it } from 'vitest'
import { matchesContextSearch } from './context-picker'

describe('上下文材料搜索', () => {
  it('忽略大小写，匹配标题、正文或出处', () => {
    const item = { label: 'Approach', text: 'A quiet counter', source: 'Reading one' }
    expect(matchesContextSearch(item, 'COUNTER')).toBe(true)
    expect(matchesContextSearch(item, 'reading')).toBe(true)
    expect(matchesContextSearch(item, 'missing')).toBe(false)
  })
})
