/**
 * 最后一次全局搜索的去向：查询词与「打开搜索时所在的地址」。
 *
 * 从搜索结果点进阅读页后，返回箭头写「搜索结果」，点它要把搜索覆盖层按原来的查询
 * 重新打开，并回到搜索前的那一页——不能只把标签写成「搜索结果」却跳去首页。
 * 这些信息放在本窗口的 localStorage 里：刷新阅读页后仍能回到同一份结果。
 */

export type SearchSession = {
  /** 产生这批结果的查询词。 */
  query: string
  /** 打开搜索覆盖层时所在的地址（含 hash）。 */
  originHash: string
}

const SESSION_KEY = 'search.session'

/** 当前地址；首次启动时 hash 可能为空，按首页记，返回时仍是同一个可见页面。 */
export function currentLocationHash(): string {
  return window.location.hash === '' ? '#/home' : window.location.hash
}

export function rememberSearchSession(session: SearchSession): void {
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session))
  } catch {
    // 存储不可用时仍能靠当前窗口里的行为返回；不阻止搜索。
  }
}

/** 从空态直接跳去最近文章时清掉旧查询，返回搜索时给一张空面板而不是旧结果。 */
export function clearSearchSession(): void {
  try {
    window.localStorage.removeItem(SESSION_KEY)
  } catch {
    // 存储不可用时返回仍会打开空搜索；不阻止导航。
  }
}

export function readSearchSession(): SearchSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { query, originHash } = parsed as { query?: unknown; originHash?: unknown }
    if (typeof query !== 'string' || typeof originHash !== 'string') return null
    if (query.trim() === '' || originHash === '') return null
    return { query, originHash }
  } catch {
    return null
  }
}
