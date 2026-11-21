import type { NavCountKey } from '../../../shared/counts'
import { navigateFromGlobal } from '../navigate'
import { NAV_ITEMS } from '../navigation'
import { useNavCounts } from '../nav-counts/use-nav-counts'
import type { Route } from '../routes'

/**
 * 计数说明用词各按对象来：对话页那个数字是未归档的钉住，不是线程数。
 * 单词写清楚，读屏与悬停都用同一句，不把「对话 N 个」拼给用户。
 */
const COUNT_TEXT: Record<NavCountKey, (value: number) => string> = {
  entries: (value) => `词条 ${value} 个`,
  articles: (value) => `文章 ${value} 篇`,
  unfiled: (value) => `未归档 ${value} 条`
}

/**
 * 侧栏品牌标志：与桌面图标同源的「拾光行」微缩矢量版（深墨底座 + 暖纸内页 + 琥珀选词块）。
 */
function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
    >
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" className="brand-mark-frame" />
      <rect x="4.5" y="4.5" width="15" height="15" rx="3.2" fill="#FBFAF3" />
      <rect x="6.5" y="7.4" width="11" height="1.9" rx="0.95" fill="#524D43" />
      <rect x="6.5" y="10.9" width="7.2" height="2.4" rx="1.15" fill="#D9A441" />
      <rect x="14.7" y="11.15" width="2.8" height="1.9" rx="0.95" fill="#524D43" />
      <rect x="6.5" y="14.9" width="8.2" height="1.9" rx="0.95" fill="#524D43" />
    </svg>
  )
}

export function GlobalNav({
  route,
  onOpenSearch
}: {
  route: Route
  onOpenSearch: () => void
}) {
  const counts = useNavCounts().counts
  return (
    <aside className="globals">
      <div className="brand">
        <BrandMark />
        拾词
      </div>
      <button
        type="button"
        className="nav-item nav-search"
        aria-label="全局搜索"
        data-search-trigger="true"
        onClick={onOpenSearch}
      >
        搜索
      </button>
      <nav className="nav" aria-label="全局导航">
        {NAV_ITEMS.map((item) => {
          const value = item.count === undefined || counts === null ? null : counts[item.count]
          const countText = item.count === undefined || value === null
            ? null
            : COUNT_TEXT[item.count](value)
          return (
            <button
              key={item.route}
              type="button"
              className="nav-item"
              aria-label={item.label}
              title={countText ?? undefined}
              aria-current={item.route === route ? 'page' : undefined}
              aria-describedby={value === null ? undefined : `nav-count-${item.count}`}
              onClick={() => navigateFromGlobal(item.route)}
            >
              <span className="nav-label">{item.label}</span>
              {value === null ? null : (
                <span className="nav-count" data-nav-count={item.count} aria-hidden="true">
                  {value}
                </span>
              )}
            </button>
          )
        })}
        {/* 数字本身对读屏用户有意义，但不要把「词条 12」并进按钮的可访问名称。 */}
        {NAV_ITEMS.map((item) => {
          if (item.count === undefined || counts === null) return null
          return (
            <span
              key={item.count}
              id={`nav-count-${item.count}`}
              className="visually-hidden"
            >
              {COUNT_TEXT[item.count](counts[item.count])}
            </span>
          )
        })}
      </nav>
      <div className="nav-foot">离线可用 · 模型调用按设置</div>
    </aside>
  )
}
