import { SIDEBAR_COLLAPSED_SETTING_KEY } from '../../shared/ui-preferences'
import type { ThemePreference } from '../../shared/types'
import { isThemePreference } from '../../shared/types'
import type { AppDatabase } from './database'

export function readSetting(database: AppDatabase, key: string): string | null {
  const row = database.prepare('SELECT value FROM setting WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

export function writeSetting(database: AppDatabase, key: string, value: string): void {
  database
    .prepare(
      `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .run(key, value)
}

/**
 * 主题偏好：没设置过或值不认识时用浅色，与产品说明里的默认一致。
 * 「跟随系统」只在用户明确选过之后才生效。
 */
export function readThemePreference(database: AppDatabase): ThemePreference {
  const stored = readSetting(database, 'theme')
  return isThemePreference(stored) ? stored : 'light'
}

export function writeThemePreference(database: AppDatabase, theme: ThemePreference): void {
  writeSetting(database, 'theme', theme)
}

/**
 * 侧栏折叠偏好：没设置过或值不是 'true' / 'false' 时按展开处理。
 * 只认这两种字面值，不把 '1'、'yes' 之类猜成折叠。
 */
export function readSidebarCollapsed(database: AppDatabase): boolean {
  return readSetting(database, SIDEBAR_COLLAPSED_SETTING_KEY) === 'true'
}

export function writeSidebarCollapsed(database: AppDatabase, collapsed: boolean): void {
  writeSetting(database, SIDEBAR_COLLAPSED_SETTING_KEY, collapsed ? 'true' : 'false')
}
