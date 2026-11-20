import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBackup } from '../data/backup'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate, migrations } from '../db/migrations'
import { readSettingsOverview } from './operations'
import type { SecretStore } from './secret-store'

let directory: string
let database: AppDatabase

const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (sealed) =>
    sealed.startsWith('sealed:')
      ? Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')
      : null
}

const now = '2026-11-18T09:00:00.000Z'

function overviewOptions() {
  return {
    secrets,
    env: {},
    fallbackModel: '',
    appVersion: '0.1.0',
    electronVersion: '45.0.0',
    dataDirectory: 'C:/data'
  }
}

function seedProfiles(): void {
  migrate(database, { migrations: migrations.filter((migration) => migration.version <= 13) })
  const insert = database.prepare(
    `INSERT INTO model_profile (
       id, name, base_url, model, api_key_secret, verification, last_error,
       last_checked_at, last_verified_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`
  )
  insert.run(
    'profile-deepseek',
    'DeepSeek 官方',
    'https://api.deepseek.com',
    'deepseek-flash',
    secrets.encrypt('sk-first-key-0001'),
    'verified',
    '2026-11-18T09:00:00.000Z',
    '2026-11-18T09:00:00.000Z'
  )
  insert.run(
    'profile-backup',
    '备用',
    'https://backup.example.com/v1',
    'backup-model',
    secrets.encrypt('sk-second-key-0002'),
    'unverified',
    '2026-11-18T09:01:00.000Z',
    '2026-11-18T09:01:00.000Z'
  )
  database
    .prepare(`INSERT INTO setting (key, value) VALUES ('chat.activeProfileId', 'profile-deepseek')`)
    .run()
  migrate(database)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-settings-ops-'))
  database = openDatabase(join(directory, 'test.db'))
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('readSettingsOverview', () => {
  it('汇总只读 provider 列表、使用中的 provider 与默认模型、阅读默认与主题', () => {
    seedProfiles()

    const overview = readSettingsOverview(database, overviewOptions())

    expect(overview.providers).toHaveLength(2)
    expect(overview.activeProviderId).toBe('profile-deepseek')
    expect(overview.defaultModelId).toBe(overview.providers[0]?.defaultModelId)
    expect(overview.activeModel).toBe('deepseek-flash')
    expect(overview.providers[0]).toMatchObject({
      displayName: 'DeepSeek 官方',
      protocol: 'openai-completions',
      active: true,
      verification: 'verified',
      defaultModel: 'deepseek-flash'
    })
    expect(overview.providers[1]).toMatchObject({
      displayName: '备用',
      active: false,
      defaultModel: 'backup-model'
    })
    expect(overview).toMatchObject({
      reading: {
        fontSize: 20,
        lineHeight: 1.8,
        annotationsVisible: true,
        weakHighlight: true
      },
      theme: 'light',
      appVersion: '0.1.0',
      electronVersion: '45.0.0',
      dataDirectory: 'C:/data'
    })
    // 设置页拿到的列表里没有密钥明文。
    expect(JSON.stringify(overview)).not.toContain('sk-first-key')
  })

  it('没有配置时模型名回落到环境变量里的那一份', () => {
    migrate(database)

    const overview = readSettingsOverview(database, {
      ...overviewOptions(),
      fallbackModel: 'deepseek-v4-pro'
    })

    expect(overview).toMatchObject({
      providers: [],
      activeProviderId: null,
      defaultModelId: null,
      activeModel: 'deepseek-v4-pro'
    })
  })

  it('读设置不写旧 model_profile 表', () => {
    seedProfiles()
    database.exec(`
      CREATE TRIGGER model_profile_read_only
      BEFORE UPDATE ON model_profile
      BEGIN
        SELECT RAISE(ABORT, 'model_profile is read-only after migration');
      END
    `)

    expect(() => readSettingsOverview(database, overviewOptions())).not.toThrow()
  })

  it('带上上次备份、恢复前快照与两个目录', async () => {
    migrate(database)
    const file = join(directory, 'chosen', 'backup.db')
    await createBackup(database, { file, now })

    const overview = readSettingsOverview(database, overviewOptions())

    expect(overview.lastBackup).toMatchObject({
      file,
      at: now,
      kind: 'manual',
      exists: true
    })
    expect(overview.lastSnapshot).toBeNull()
    expect(overview.backupDirectory).toBe(join('C:/data', 'backups'))
    expect(overview.snapshotDirectory).toBe(join('C:/data', 'snapshots'))
  })
})
