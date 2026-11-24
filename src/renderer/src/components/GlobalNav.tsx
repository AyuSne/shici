import type { NavCountKey } from '../../../shared/counts'
import { BrandMark } from './brand-mark'
import { Icon } from './icons'
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
 * A+B 融合侧栏：同一个 DOM 在 224px 完整栏与 56px 图标轨道之间切换。
 * 收起态只隐藏文字与计数（保留节点），悬停图标浮出「页面名 + 计数」；
 * 有未归档钉住时，对话图标角上显示一颗克制的琥珀微点。
 */
export function GlobalNav({
  route,
  collapsed,
  onToggleCollapsed,
  onOpenSearch
}: {
  route: Route
  collapsed: boolean
  onToggleCollapsed: () => void
  onOpenSearch: () => void
}) {
  const counts = useNavCounts().counts
  const toggleLabel = collapsed ? '展开侧栏' : '收起侧栏'

  return (
    <aside
      className={collapsed ? 'globals is-collapsed' : 'globals'}
      data-sidebar-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className="nav-head">
        <div className="brand">
          <BrandMark />
          <span className="nav-text">拾词</span>
        </div>
        <button
          type="button"
          className="nav-collapse"
          aria-label={toggleLabel}
          title={`${toggleLabel} (Ctrl+B)`}
          onClick={onToggleCollapsed}
        >
          <Icon name="panel" />
        </button>
      </div>
      <button
        type="button"
        className="nav-item nav-search"
        aria-label="全局搜索"
        title="全局搜索 (Ctrl+K)"
        data-search-trigger="true"
        onClick={onOpenSearch}
      >
        <Icon name="search" />
        <span className="nav-label">搜索</span>
        <kbd className="nav-kbd">Ctrl K</kbd>
      </button>
      <nav className="nav" aria-label="全局导航">
        {NAV_ITEMS.map((item) => {
          const value = item.count === undefined || counts === null ? null : counts[item.count]
          const countText =
            item.count === undefined || value === null ? null : COUNT_TEXT[item.count](value)
          const tooltip = countText === null ? item.label : `${item.label} · ${countText}`
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
              <Icon name={item.icon} />
              <span className="nav-label">{item.label}</span>
              {value === null ? null : (
                <span className="nav-count" data-nav-count={item.count} aria-hidden="true">
                  {value}
                </span>
              )}
              {item.count === 'unfiled' && value !== null && value > 0 ? (
                <span className="nav-dot" data-nav-dot="true" aria-hidden="true" />
              ) : null}
              {collapsed ? (
                <span className="nav-tip" aria-hidden="true">
                  {tooltip}
                </span>
              ) : null}
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
      <div className="nav-foot">
        <span className="nav-text">离线可用 · 模型调用按设置</span>
      </div>
    </aside>
  )
}
