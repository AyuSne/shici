import type { Theme } from './types'

/**
 * 窗口首帧的底色，与 docs/ui-tokens.md 的 --paper 一致。
 * 渲染层加载 CSS 之前先用它兜底，避免闪白；其余颜色以 tokens.css 为准。
 */
export const THEME_PAPER: Record<Theme, string> = {
  light: '#FBFAF3',
  dark: '#1A1A1E'
}

/** 原生窗口控制区的符号色，取 token 表的 --ink。 */
export const THEME_INK: Record<Theme, string> = {
  light: '#1A1A17',
  dark: '#E8E4DA'
}

/** 融合标题栏高度：渲染层顶栏与原生覆盖控制区共用这个值。 */
export const TITLEBAR_HEIGHT = 34

/**
 * `titleBarOverlay` 的一份值：底色与符号色都随解析后的纸墨主题走。
 * 主进程只在主题真正变化时调用 setTitleBarOverlay，跟随系统时由 nativeTheme 的
 * updated 事件重新解析后再推给窗口。
 */
export type TitleBarOverlay = {
  color: string
  symbolColor: string
  height: number
}

export function titleBarOverlayFor(theme: Theme): TitleBarOverlay {
  return {
    color: THEME_PAPER[theme],
    symbolColor: THEME_INK[theme],
    height: TITLEBAR_HEIGHT
  }
}
