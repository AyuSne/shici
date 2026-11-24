import type { Route } from '../routes'
import { BrandMark } from './brand-mark'

const PAGE_TITLES: Record<Route, string> = {
  home: '首页',
  reading: '阅读',
  entries: '词条',
  chat: '对话',
  library: '文章库',
  settings: '设置'
}

/**
 * 融合式原生覆盖标题栏在渲染层的顶栏：34px 高、整条可拖动窗口。
 * 右上角约 138px 留给原生最小化 / 最大化 / 关闭按钮，所以这里不放控件，
 * 只用 CSS padding-right 让开；页面里的按钮都在顶栏下方，不会盖住系统按钮。
 */
export function TitleBar({ route }: { route: Route }) {
  return (
    <header className="titlebar" data-titlebar="true">
      <span className="titlebar-brand">
        <BrandMark />
        <span>拾词</span>
      </span>
      <span className="titlebar-crumb">/ {PAGE_TITLES[route]}</span>
    </header>
  )
}
