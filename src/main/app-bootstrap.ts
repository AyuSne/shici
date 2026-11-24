import { app } from 'electron'
import type { ImportReport } from '../shared/library'
import type { AppBootstrap } from '../shared/types'
import type { AppDatabase } from './db/database'
import { readSchemaVersion } from './db/migrations'
import { readThemePreference } from './db/settings'
import { readUiPreferences } from './settings/ui-preferences'

/**
 * 渲染层启动时读到的那一份值：全部来自主进程与已迁移的本机资料库。
 * 语料导入结果一并带上，文章库据此提示哪几篇没导进来。
 */
export function createBootstrap(
  database: AppDatabase,
  corpusImport: ImportReport,
  chatModel: string
): AppBootstrap {
  return {
    appVersion: app.getVersion(),
    isPackaged: app.isPackaged,
    schemaVersion: readSchemaVersion(database),
    theme: readThemePreference(database),
    sidebarCollapsed: readUiPreferences(database).sidebarCollapsed,
    chatModel,
    corpusImport
  }
}
