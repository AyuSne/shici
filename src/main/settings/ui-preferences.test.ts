import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupTo, restoreFrom } from '../data/operations'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { readSetting, writeSetting } from '../db/settings'
import type { SecretStore } from './secret-store'
import { readUiPreferences, saveSidebarPreference } from './ui-preferences'

/**
 * 侧栏折叠偏好是本票唯一的持久化状态：只写 setting 表、不升 schema，
 * 并且必须随整库备份 / 恢复一起往返。测试只走主进程公共服务，不直接查实现细节；
 * 唯一直接看 setting 的地方是为了证明「键名与值」这层跨版本契约本身。
 */

const SIDEBAR_KEY = 'ui.sidebarCollapsed'

let directory: string
let database: AppDatabase

const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${plain}`,
  decrypt: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null)
}

function dataOptions() {
  return {
    secrets,
    env: {},
    fallbackModel: '',
    appVersion: '0.2.0',
    electronVersion: '45.0.0',
    dataDirectory: directory
  }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-ui-preferences-'))
  database = openDatabase(join(directory, 'library.db'))
  migrate(database)
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('侧栏折叠偏好', () => {
  it('没有设置过时按展开处理', () => {
    expect(readUiPreferences(database)).toEqual({ sidebarCollapsed: false })
    expect(readSetting(database, SIDEBAR_KEY)).toBeNull()
  })

  it('保存后按 setting 键读回，且只写这一个键', () => {
    expect(saveSidebarPreference(database, { collapsed: true })).toEqual({
      saved: true,
      collapsed: true
    })

    expect(readSetting(database, SIDEBAR_KEY)).toBe('true')
    expect(readUiPreferences(database)).toEqual({ sidebarCollapsed: true })

    expect(saveSidebarPreference(database, { collapsed: false })).toEqual({
      saved: true,
      collapsed: false
    })
    expect(readSetting(database, SIDEBAR_KEY)).toBe('false')
    expect(readUiPreferences(database)).toEqual({ sidebarCollapsed: false })
  })

  it('库里是坏值或非布尔请求时不写坏数据，读回按展开处理', () => {
    writeSetting(database, SIDEBAR_KEY, 'collapsed-please')
    expect(readUiPreferences(database)).toEqual({ sidebarCollapsed: false })

    expect(saveSidebarPreference(database, { collapsed: 'yes' as never })).toEqual({
      saved: false,
      collapsed: false
    })
    expect(readSetting(database, SIDEBAR_KEY)).toBe('collapsed-please')
  })

  it('随整库备份 / 恢复往返保持，不升 schema 版本', async () => {
    const schemaBefore = database.pragma('user_version', { simple: true }) as number
    saveSidebarPreference(database, { collapsed: true })

    const backupFile = join(directory, 'backup', 'library.db')
    const saved = await backupTo(database, backupFile, dataOptions())
    expect(saved.status).toBe('saved')

    saveSidebarPreference(database, { collapsed: false })
    expect(readUiPreferences(database).sidebarCollapsed).toBe(false)

    const restored = await restoreFrom(database, backupFile, dataOptions())
    expect(restored.status).toBe('restored')
    expect(readUiPreferences(database).sidebarCollapsed).toBe(true)
    expect(database.pragma('user_version', { simple: true })).toBe(schemaBefore)
  })
})
