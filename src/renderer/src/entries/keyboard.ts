/** 词条页左栏的键盘翻阅落点；只在列表有内容时给出一个词条。 */

export type EntryMove = 'up' | 'down'

/**
 * ↑/↓ 在可见词条列表里的下一条。还没选时 ↓ 从第一条开始、↑ 从最后一条开始；
 * 到头就停在原处，不绕回。当前词条已经不在列表里（筛选或删除）时重新从边界开始。
 */
export function nextEntryId(
  ids: readonly string[],
  selectedId: string | null,
  move: EntryMove
): string | null {
  if (ids.length === 0) return null
  const index = selectedId === null ? -1 : ids.indexOf(selectedId)
  if (index < 0) return move === 'down' ? ids[0]! : ids[ids.length - 1]!
  const next = move === 'down' ? Math.min(index + 1, ids.length - 1) : Math.max(index - 1, 0)
  return ids[next]!
}
