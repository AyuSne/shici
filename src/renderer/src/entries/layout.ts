/**
 * 词条页三栏的宽度预算。右栏内联还是改为覆盖抽屉只看真实可用容器宽度：
 * 左列表 240、中栏至少能读 420、右栏 320，再加上两处 24 的栏间距。
 * 全局导航 238 与页面左右 32 已经在「容器宽度」里扣掉了，所以这里不再写窗口断点。
 */
export const ENTRY_LIST_WIDTH = 240
export const ENTRY_MAIN_MIN_WIDTH = 420
export const ENTRY_RAIL_WIDTH = 320
export const ENTRY_COLUMN_GAP = 24

export type EntryLayout = 'inline' | 'drawer'

/** 容器宽到 1028 才够三栏同时张开；差一点都不内联。 */
export const ENTRY_INLINE_MIN_WIDTH =
  ENTRY_LIST_WIDTH + ENTRY_MAIN_MIN_WIDTH + ENTRY_RAIL_WIDTH + ENTRY_COLUMN_GAP * 2

export function entryLayoutForWidth(availableWidth: number): EntryLayout {
  return availableWidth >= ENTRY_INLINE_MIN_WIDTH ? 'inline' : 'drawer'
}

/**
 * 切换词条时右栏是否保持展开：
 * 宽屏三栏（inline）没有遮罩，连续查词典与学习内容时保持展开态；
 * 窄屏抽屉（drawer）盖在正文上方，切词条时顺手收起以免挡住内容。
 */
export function nextRailOpenOnEntrySelect(
  currentlyOpen: boolean,
  layout: EntryLayout
): boolean {
  return layout === 'inline' ? currentlyOpen : false
}
