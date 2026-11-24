/** 可搜索目标选择器的纯逻辑：即时过滤与键盘在候选里的上下移动。 */

export type SearchableTarget = {
  id: string
  label: string
  /** 补充说明（如已收集变体、句数）；也参与关键词过滤。 */
  detail?: string
}

export type TargetMove = 'up' | 'down'

/** 大小写不敏感、忽略首尾空白的包含匹配；空查询保留全部。 */
export function filterTargets<T extends SearchableTarget>(
  targets: readonly T[],
  query: string
): T[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...targets]
  return targets.filter(
    (target) =>
      target.label.toLowerCase().includes(needle) ||
      (target.detail ?? '').toLowerCase().includes(needle)
  )
}

/** ↓/↑ 在候选列表里的下一个活动项；到头停住，没有候选时保持 -1。 */
export function moveActiveIndex(
  count: number,
  activeIndex: number,
  move: TargetMove
): number {
  if (count <= 0) return -1
  if (activeIndex < 0 || activeIndex >= count) {
    return move === 'down' ? 0 : count - 1
  }
  return move === 'down'
    ? Math.min(activeIndex + 1, count - 1)
    : Math.max(activeIndex - 1, 0)
}
