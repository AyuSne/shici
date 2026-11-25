/**
 * 界面偏好的跨层类型。它们都落在既有 `setting` 表里，不进任何业务表，
 * 因此整库备份 / 恢复天然带上，也不改变 schema 版本。
 */

/** 侧栏折叠偏好的 setting 键；值是 'true' / 'false'。 */
export const SIDEBAR_COLLAPSED_SETTING_KEY = 'ui.sidebarCollapsed'

/** 渲染层启动时读到的一组界面偏好。 */
export type UiPreferences = {
  /** 全局侧栏是否收成 56px 图标轨道；阅读页始终整栏隐藏，与这个偏好无关。 */
  sidebarCollapsed: boolean
}

/** 写入侧栏折叠偏好；只接受布尔值，坏输入原样返回当前值。 */
export type SaveSidebarPreferenceRequest = {
  collapsed: boolean
}

export type SaveSidebarPreferenceResult = {
  saved: boolean
  collapsed: boolean
}
