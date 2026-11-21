import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { writeSetting } from '../db/settings'
import type { SecretStore } from '../settings/secret-store'
import { backupTo, restoreFrom } from './operations'

let directory: string
let database: AppDatabase

const now = '2026-11-18T11:00:00.000Z'
const later = '2026-11-18T12:00:00.000Z'

const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${plain}`,
  decrypt: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null)
}

function options() {
  return {
    secrets,
    env: {},
    fallbackModel: '',
    appVersion: '0.1.0',
    electronVersion: '45.0.0',
    dataDirectory: directory,
    now
  }
}

function backupFile(): string {
  return join(directory, 'chosen', 'backup.db')
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-data-ops-'))
  database = openDatabase(join(directory, 'library.db'))
  migrate(database)
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('backupTo', () => {
  it('备份成功后带回新的概览与上次备份', async () => {
    const result = await backupTo(database, backupFile(), options())

    expect(result.status).toBe('saved')
    if (result.status !== 'saved') {
      throw new Error('备份没有成功')
    }
    expect(result.backup).toMatchObject({
      file: backupFile(),
      at: now,
      kind: 'manual',
      exists: true
    })
    expect(result.overview.lastBackup).toMatchObject({ file: backupFile(), at: now })
  })

  it('目标就是正在用的库时给出 same-file，而不是把库覆盖掉', async () => {
    const result = await backupTo(database, database.name, options())

    expect(result).toMatchObject({ status: 'failed', reason: 'same-file' })
    expect(result.overview.lastBackup).toBeNull()
  })
})

describe('restoreFrom', () => {
  it('恢复成功后概览读到恢复后的那份库，并带上恢复前快照', async () => {
    writeSetting(database, 'theme', 'dark')
    await backupTo(database, backupFile(), options())
    writeSetting(database, 'theme', 'light')

    const result = await restoreFrom(database, backupFile(), {
      ...options(),
      now: later
    })

    expect(result.status).toBe('restored')
    expect(result.overview.theme).toBe('dark')
    expect(result.overview.lastBackup).toMatchObject({ file: backupFile(), exists: true })
    expect(result.overview.lastSnapshot).toMatchObject({
      kind: 'before-restore',
      at: later,
      exists: true
    })
    if (result.status === 'restored') {
      expect(result.snapshot.file.startsWith(join(directory, 'snapshots'))).toBe(true)
      expect(existsSync(result.snapshot.file)).toBe(true)
    }
  })

  it('拒绝时把原因交回界面，本机数据不动', async () => {
    const result = await restoreFrom(database, join(directory, 'no-such.db'), options())

    expect(result).toMatchObject({ status: 'rejected', reason: 'missing' })
    expect(result.overview.theme).toBe('light')
  })
})
