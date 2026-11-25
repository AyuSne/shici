import type { ImportReport } from './library'

/** 落到界面上的两套配色，取 interface token 表里的值。 */
export type Theme = 'light' | 'dark'

/**
 * 用户在设置页选的主题。`system` 跟着 Windows 的浅色 / 深色偏好走，
 * 主进程用 nativeTheme 解析，渲染层用 prefers-color-scheme 解析。
 */
export type ThemePreference = Theme | 'system'

export const THEME_PREFERENCES: readonly ThemePreference[] = ['light', 'dark', 'system']

export function isThemePreference(value: unknown): value is ThemePreference {
  return (THEME_PREFERENCES as readonly unknown[]).includes(value)
}

/** 跟随系统时按 Windows 的偏好取一套配色。 */
export function resolveTheme(preference: ThemePreference, systemDark: boolean): Theme {
  if (preference === 'system') {
    return systemDark ? 'dark' : 'light'
  }
  return preference
}

/**
 * 渲染层启动时经 bridge 从主进程读到的一份值。渲染层自己不碰数据库。
 */
export type AppBootstrap = {
  appVersion: string
  isPackaged: boolean
  schemaVersion: number
  /** 主题偏好；跟随系统时由渲染层解析成实际配色。 */
  theme: ThemePreference
  /** 全局侧栏是否收成 56px 图标轨道；阅读页仍整栏隐藏。 */
  sidebarCollapsed: boolean
  /** 当前配置的模型名；保存回答与钉住出处都记它。 */
  chatModel: string
  /** 本次启动的语料导入结果；失败项要在文章库里提示出来。 */
  corpusImport: ImportReport
}
