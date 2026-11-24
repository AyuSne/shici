import type { NavCountKey } from '../../shared/counts'
import type { IconName } from './components/icons'
import type { Route } from './routes'

/**
 * 左侧全局栏的六项。顺序与产品说明一致。
 * `count` 指向全局栏要显示的计数：词条、文章库与对话（未归档钉住）。
 * `icon` 是 1.5px 单色线框图标；收起为 56px 轨道时只剩它。
 */
export const NAV_ITEMS: readonly {
  route: Route
  label: string
  icon: IconName
  count?: NavCountKey
}[] = [
  { route: 'home', label: '首页', icon: 'home' },
  { route: 'reading', label: '阅读', icon: 'reading' },
  { route: 'entries', label: '词条', icon: 'entries', count: 'entries' },
  { route: 'chat', label: '对话', icon: 'chat', count: 'unfiled' },
  { route: 'library', label: '文章库', icon: 'library', count: 'articles' },
  { route: 'settings', label: '设置', icon: 'settings' }
]

const NAV_LABELS: Record<Route, string> = Object.fromEntries(
  NAV_ITEMS.map((item) => [item.route, item.label])
) as Record<Route, string>

/** 页面在标题栏里的短名；与左栏标签同源，改一处不会两处对不上。 */
export function navLabel(route: Route): string {
  return NAV_LABELS[route]
}
