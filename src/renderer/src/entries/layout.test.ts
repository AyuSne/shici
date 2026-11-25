import { describe, expect, it } from 'vitest'
import {
  ENTRY_INLINE_MIN_WIDTH,
  entryLayoutForWidth,
  nextRailOpenOnEntrySelect
} from './layout'

describe('entryLayoutForWidth', () => {
  it('三栏内联的最小容器宽度是独立的 1028px', () => {
    expect(ENTRY_INLINE_MIN_WIDTH).toBe(1028)
  })

  it('差 1px 不够三栏就不内联，正好够才内联', () => {
    expect(entryLayoutForWidth(ENTRY_INLINE_MIN_WIDTH - 1)).toBe('drawer')
    expect(entryLayoutForWidth(ENTRY_INLINE_MIN_WIDTH)).toBe('inline')
  })

  it('1101 / 1200 / 1280 窗口扣掉全局栏与页面留白后仍是抽屉，1440 才内联', () => {
    const available = (windowWidth: number): number => windowWidth - 238 - 64
    expect(entryLayoutForWidth(available(1101))).toBe('drawer')
    expect(entryLayoutForWidth(available(1200))).toBe('drawer')
    expect(entryLayoutForWidth(available(1280))).toBe('drawer')
    expect(entryLayoutForWidth(available(1440))).toBe('inline')
  })
})

describe('nextRailOpenOnEntrySelect', () => {
  it('宽屏三栏切换词条时保持右栏当前的展开或收起状态', () => {
    expect(nextRailOpenOnEntrySelect(true, 'inline')).toBe(true)
    expect(nextRailOpenOnEntrySelect(false, 'inline')).toBe(false)
  })

  it('窄屏抽屉切换词条时收起抽屉以免盖住列表和正文', () => {
    expect(nextRailOpenOnEntrySelect(true, 'drawer')).toBe(false)
    expect(nextRailOpenOnEntrySelect(false, 'drawer')).toBe(false)
  })
})
