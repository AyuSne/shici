import type {
  SaveSidebarPreferenceRequest,
  SaveSidebarPreferenceResult,
  UiPreferences
} from '../../shared/ui-preferences'
import type { AppDatabase } from '../db/database'
import { readSidebarCollapsed, writeSidebarCollapsed } from '../db/settings'

/**
 * 界面偏好的读写入口。写只接受布尔值：渲染层传来坏值时原样返回当前值，
 * 不让一次坏输入把用户的选择清成默认。
 */
export function readUiPreferences(database: AppDatabase): UiPreferences {
  return { sidebarCollapsed: readSidebarCollapsed(database) }
}

export function saveSidebarPreference(
  database: AppDatabase,
  request: SaveSidebarPreferenceRequest
): SaveSidebarPreferenceResult {
  if (typeof request?.collapsed !== 'boolean') {
    return { saved: false, collapsed: readSidebarCollapsed(database) }
  }
  writeSidebarCollapsed(database, request.collapsed)
  return { saved: true, collapsed: request.collapsed }
}
