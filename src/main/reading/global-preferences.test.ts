import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupTo, restoreFrom } from '../data/operations'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { readSetting, writeSetting } from '../db/settings'
import type { SecretStore } from '../settings/secret-store'
import {
  readReadingGlobalPreferences,
  saveReadingGlobalPreferences
} from './global-preferences'

/**
 * 静默圈词、页边眉批与轻遮重读都是全局偏好：只写 setting 表，不碰
 * article_reading_setting，也不能改任何表结构。测试走主进程公共服务；
 * 直接读 setting 的两处是为了锁定跨版本的键名与值，不是验证内部实现。
 */

const SILENT_KEY = 'reading.silentCollection'
const MARGIN_KEY = 'reading.marginNotes'
const LIGHT_MASK_KEY = 'reading.lightMask'

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
  directory = mkdtempSync(join(tmpdir(), 'english-learning-reading-globals-'))
  database = openDatabase(join(directory, 'library.db'))
  migrate(database)
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('阅读全局偏好', () => {
  it('没设置过时静默圈词关、眉批全部、轻遮重读关', () => {
    expect(readReadingGlobalPreferences(database)).toEqual({
      silentCollection: false,
      marginNoteMode: 'all',
      lightMask: false
    })
    expect(readSetting(database, SILENT_KEY)).toBeNull()
  })

  it('保存后按 setting 键读回，并随整库备份 / 恢复往返，不升 schema 版本', async () => {
    const schemaBefore = database.pragma('user_version', { simple: true }) as number
    expect(
      saveReadingGlobalPreferences(database, {
        silentCollection: true,
        marginNoteMode: 'mine',
        lightMask: true
      })
    ).toEqual({
      saved: true,
      preferences: { silentCollection: true, marginNoteMode: 'mine', lightMask: true }
    })

    expect(readSetting(database, SILENT_KEY)).toBe('1')
    expect(readSetting(database, MARGIN_KEY)).toBe('mine')
    expect(readSetting(database, LIGHT_MASK_KEY)).toBe('1')

    const backupFile = join(directory, 'backup', 'library.db')
    expect((await backupTo(database, backupFile, dataOptions())).status).toBe('saved')

    saveReadingGlobalPreferences(database, {
      silentCollection: false,
      marginNoteMode: 'hidden',
      lightMask: false
    })
    expect(readReadingGlobalPreferences(database)).toEqual({
      silentCollection: false,
      marginNoteMode: 'hidden',
      lightMask: false
    })

    expect((await restoreFrom(database, backupFile, dataOptions())).status).toBe('restored')
    expect(readReadingGlobalPreferences(database)).toEqual({
      silentCollection: true,
      marginNoteMode: 'mine',
      lightMask: true
    })
    expect(database.pragma('user_version', { simple: true })).toBe(schemaBefore)
  })

  it('库里的坏值与不合法请求都不写坏数据，逐项回落到默认', () => {
    writeSetting(database, SILENT_KEY, 'maybe')
    writeSetting(database, MARGIN_KEY, 'some-day')
    writeSetting(database, LIGHT_MASK_KEY, '2')

    expect(readReadingGlobalPreferences(database)).toEqual({
      silentCollection: false,
      marginNoteMode: 'all',
      lightMask: false
    })

    expect(
      saveReadingGlobalPreferences(database, {
        silentCollection: 'yes' as never,
        marginNoteMode: 'all',
        lightMask: false
      })
    ).toEqual({ saved: false, preferences: readReadingGlobalPreferences(database) })
    expect(readSetting(database, SILENT_KEY)).toBe('maybe')
  })
})
