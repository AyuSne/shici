import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askQuestion, createThread, readThreadView } from '../chat/threads'
import { openDatabase, type AppDatabase } from '../db/database'
import {
  LATEST_SCHEMA_VERSION,
  migrate,
  migrations,
  readSchemaVersion
} from '../db/migrations'
import { readThemePreference, writeSetting } from '../db/settings'
import { readArticleDetail } from '../library/queries'
import { addBuiltinProvider } from '../settings/provider-writes'
import { listModelProviders, readProviderModels } from '../settings/providers'
import type { SecretStore } from '../settings/secret-store'
import {
  BackupTargetError,
  createBackup,
  inspectBackupFile,
  readLastBackup,
  readLastSnapshot,
  restoreBackup
} from './backup'

let directory: string
let database: AppDatabase

const now = '2026-11-18T11:00:00.000Z'
const later = '2026-11-18T12:00:00.000Z'
const evenLater = '2026-11-18T13:00:00.000Z'

function startThread(text: string): string {
  const created = createThread(database, { main: { kind: 'none' } })
  if (created.status !== 'created') {
    throw new Error('线程没有建起来')
  }
  const asked = askQuestion(database, { threadId: created.thread.id, text })
  if (asked.status !== 'asked') {
    throw new Error('问题没有落库')
  }
  return created.thread.id
}

function snapshots(): string {
  return join(directory, 'snapshots')
}

const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${plain}`,
  decrypt: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null)
}

function providerOptions() {
  return { secrets, env: {} }
}

function insertLegacyProfile(
  target: AppDatabase,
  input: { id: string; apiKey: string | null; model?: string; name?: string }
): void {
  target
    .prepare(
      `INSERT INTO model_profile (
         id, name, base_url, model, api_key_secret, verification, last_error,
         last_checked_at, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, 'https://api.deepseek.com', ?, ?, 'verified', NULL, ?, ?, ?, ?)`
    )
    .run(
      input.id,
      input.name ?? 'DeepSeek 官方',
      input.model ?? 'deepseek-flash',
      input.apiKey === null ? null : secrets.encrypt(input.apiKey),
      now,
      now,
      now,
      now
    )
}

/**
 * 造一份「升级前」的库并执行 v14 迁移：provider 与旧表同时存在，
 * 之后所有运行时动作都不该再写旧表。
 */
function saveProfile(apiKey: string, id = 'profile-deepseek'): string {
  if (readSchemaVersion(database) < 13) {
    migrate(database, { migrations: migrations.filter((migration) => migration.version <= 13) })
  }
  insertLegacyProfile(database, { id, apiKey })
  database
    .prepare(
      `INSERT INTO setting (key, value) VALUES ('chat.activeProfileId', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`
    )
    .run(id)
  if (readSchemaVersion(database) < LATEST_SCHEMA_VERSION) {
    migrate(database)
  }
  return id
}

function backupFile(name = 'backup.db'): string {
  return join(directory, 'chosen', name)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-backup-'))
  database = openDatabase(join(directory, 'library.db'))
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('createBackup', () => {
  it('备份是一份独立的整库副本，路径不必事先存在', async () => {
    migrate(database)
    writeSetting(database, 'theme', 'dark')
    const file = backupFile()

    const backup = await createBackup(database, { file, now })

    expect(backup).toMatchObject({ file, at: now, kind: 'manual', exists: true })
    expect(backup.bytes).toBe(statSync(file).size)
    expect(backup.bytes).toBeGreaterThan(0)
    expect(existsSync(`${file}-wal`)).toBe(false)
    expect(existsSync(`${file}-shm`)).toBe(false)

    const copy = openDatabase(file)
    try {
      expect(readThemePreference(copy)).toBe('dark')
      expect(readSchemaVersion(copy)).toBe(LATEST_SCHEMA_VERSION)
    } finally {
      copy.close()
    }
  })

  it('备份带新 provider 表与模型目录，但不含任何密钥（连空闲页也不留）', async () => {
    saveProfile('sk-secret-9999')
    const file = backupFile()

    await createBackup(database, { file, now })

    const copy = openDatabase(file)
    try {
      const providers = listModelProviders(copy, providerOptions())
      expect(providers).toHaveLength(1)
      expect(providers[0]).toMatchObject({
        providerKey: 'deepseek',
        displayName: 'DeepSeek 官方',
        protocol: 'openai-completions',
        apiKeyMask: null,
        keyState: 'missing',
        verification: 'unverified',
        lastVerifiedAt: null
      })
      // 模型目录随 provider 一起进备份。
      expect(providers[0]?.models.map((model) => model.modelId)).toEqual(['deepseek-flash'])
      expect(
        copy.prepare('SELECT secret_ciphertext FROM model_provider').get()
      ).toEqual({ secret_ciphertext: null })
      expect(
        copy
          .prepare('SELECT api_key_secret, verification, last_verified_at FROM model_profile')
          .get()
      ).toEqual({ api_key_secret: null, verification: 'unverified', last_verified_at: null })
    } finally {
      copy.close()
    }
    // 明文与密文都不该留在副本里（否则从空闲页里还能捞出来）。
    const bytes = readFileSync(file)
    expect(bytes.includes('sk-secret-9999')).toBe(false)
    expect(bytes.includes('sealed:sk-secret-9999')).toBe(false)
  })

  it('环境变量引用进备份，密钥密文不进', async () => {
    migrate(database)
    database
      .prepare(
        `INSERT INTO model_provider (
           id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
           secret_ciphertext, retry_policy, verification, last_error, last_checked_at,
           last_verified_at, source, default_model_id, created_at, updated_at
         ) VALUES ('provider-env', 'env-provider', '环境配置', 'anthropic-messages',
                   'https://env.example.com', 'env', 'MY_PROVIDER_KEY', NULL,
                   '{"mode":"always"}', 'verified', NULL, NULL, NULL, 'builtin', NULL, ?, ?)`
      )
      .run(now, now)
    database
      .prepare(
        `INSERT INTO model_provider_model (
           id, provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
           input, reasoning, source, sort, created_at, updated_at
         ) VALUES ('model-env', 'provider-env', 'claude-sonnet-4', 'Claude Sonnet 4',
                   'anthropic-messages', NULL, 200000, 8192, 'text', 1, 'catalog', 0, ?, ?)`
      )
      .run(now, now)
    database.prepare(`UPDATE model_provider SET default_model_id = 'model-env'`).run()
    const file = backupFile()

    await createBackup(database, { file, now })

    const copy = openDatabase(file)
    try {
      const provider = listModelProviders(copy, {
        secrets,
        env: { MY_PROVIDER_KEY: 'env-secret' }
      })[0]
      expect(provider).toMatchObject({
        providerKey: 'env-provider',
        authMode: 'env',
        envVar: 'MY_PROVIDER_KEY',
        keyState: 'env',
        apiKeyMask: null,
        verification: 'verified',
        retryPolicy: { mode: 'always' }
      })
      expect(provider?.models[0]?.modelId).toBe('claude-sonnet-4')
      expect(provider?.models[0]).toMatchObject({
        api: 'anthropic-messages',
        contextWindow: 200000,
        maxTokens: 8192,
        reasoning: true,
        source: 'catalog'
      })
      expect(
        copy.prepare('SELECT secret_ciphertext FROM model_provider').get()
      ).toEqual({ secret_ciphertext: null })
    } finally {
      copy.close()
    }
  })

  it('内置 provider 的目录身份、思考元数据与容量随备份保留，密钥照旧清空；恢复后仍可用', async () => {
    migrate(database)
    const added = addBuiltinProvider(database, secrets, {
      catalogProviderId: 'deepseek',
      apiKey: 'sk-builtin-secret-8888'
    })
    if (added.status !== 'saved') throw new Error('内置 provider 没存上')
    const file = backupFile('builtin-provider.db')
    await createBackup(database, { file, now })

    const copy = openDatabase(file)
    try {
      const provider = listModelProviders(copy, providerOptions())[0]
      expect(provider).toMatchObject({
        providerKey: 'deepseek',
        catalogProviderId: 'deepseek',
        source: 'builtin',
        keyState: 'missing',
        apiKeyMask: null,
        verification: 'unverified'
      })
      const models = readProviderModels(copy, added.providerId)
      expect(models.map((model) => model.modelId)).toEqual([
        'deepseek-flash',
        'deepseek-v4-pro'
      ])
      expect(models[0]).toMatchObject({
        contextWindow: 1000000,
        maxTokens: 384000,
        reasoning: true
      })
      expect(models[0]?.thinkingLevelMap).toMatchObject({ high: 'high', max: 'max' })
      expect(models[0]?.compat).toMatchObject({ thinkingFormat: 'deepseek' })
      expect(
        copy.prepare('SELECT secret_ciphertext FROM model_provider').get()
      ).toEqual({ secret_ciphertext: null })
      expect(readFileSync(file).includes('sk-builtin-secret-8888')).toBe(false)
    } finally {
      copy.close()
    }

    const outcome = await restoreBackup(database, {
      file,
      snapshotDirectory: snapshots(),
      now: later
    })
    expect(outcome.status).toBe('restored')
    const restored = listModelProviders(database, providerOptions())[0]
    expect(restored).toMatchObject({
      catalogProviderId: 'deepseek',
      apiKeyMask: null,
      verification: 'unverified'
    })
    expect(readProviderModels(database, added.providerId)[0]?.thinkingLevelMap).toMatchObject({
      high: 'high'
    })
  })

  it('当前版本备份缺了 v14 新列时不会被当成可恢复的备份', async () => {
    migrate(database)
    const file = backupFile('missing-columns.db')
    await createBackup(database, { file, now })
    const copy = openDatabase(file)
    try {
      copy.exec('ALTER TABLE model_provider DROP COLUMN catalog_provider_id')
      copy.exec('ALTER TABLE model_provider_model DROP COLUMN thinking_level_map')
    } finally {
      copy.close()
    }

    expect(inspectBackupFile(file)).toEqual({ ok: false, reason: 'not-a-library' })
  })

  it('记下上次备份的时间、路径与体积', async () => {
    migrate(database)
    const file = backupFile()
    const backup = await createBackup(database, { file, now })

    expect(readLastBackup(database)).toMatchObject({
      at: now,
      file,
      bytes: backup.bytes,
      kind: 'manual',
      exists: true
    })
  })

  it('备份文件被挪走后，仍记得时间，但标出文件已不在原处', async () => {
    migrate(database)
    const file = backupFile()
    await createBackup(database, { file, now })
    rmSync(file)

    const last = readLastBackup(database)

    expect(last).toMatchObject({ at: now, exists: false })
  })

  it('没有备份过时不编造一份', () => {
    migrate(database)
    expect(readLastBackup(database)).toBeNull()
  })
})

describe('restoreBackup', () => {
  it('恢复用备份内容整体替换本机资料库，并先留一份恢复前快照', async () => {
    saveProfile('sk-snapshot-9999')
    writeSetting(database, 'theme', 'dark')
    const keptThread = startThread('备份前的问题')
    const file = backupFile()
    await createBackup(database, { file, now })

    writeSetting(database, 'theme', 'light')
    const laterThread = startThread('备份之后的问题')

    const outcome = await restoreBackup(database, {
      file,
      snapshotDirectory: snapshots(),
      now: later
    })

    expect(outcome.status).toBe('restored')
    expect(readThemePreference(database)).toBe('dark')
    expect(readThreadView(database, keptThread)?.title).toBe('备份前的问题')
    expect(readThreadView(database, laterThread)).toBeNull()
    // 恢复的是备份，所以密钥没了，要重填。
    expect(listModelProviders(database, providerOptions())[0]?.apiKeyMask).toBeNull()

    if (outcome.status !== 'restored') {
      throw new Error('恢复没有成功')
    }
    expect(outcome.snapshot).toMatchObject({ kind: 'before-restore', at: later, exists: true })
    expect(existsSync(outcome.snapshot.file)).toBe(true)
    // 恢复动作本身也记进「上次备份」：界面上的时间与体积不会因为恢复而消失。
    expect(readLastBackup(database)).toMatchObject({ file, exists: true })

    // 快照里是恢复前那份库：备份之后新建的线程还在，本机加密的密钥也在。
    const snapshot = openDatabase(outcome.snapshot.file)
    try {
      expect(readThreadView(snapshot, laterThread)).not.toBeNull()
      expect(listModelProviders(snapshot, providerOptions())[0]?.apiKeyMask).not.toBeNull()
    } finally {
      snapshot.close()
    }
  })

  it('快照本身也能再换回来，恢复错了还有退路', async () => {
    saveProfile('sk-snapshot-0002')
    const original = startThread('恢复前的问题')
    const file = backupFile()
    await createBackup(database, { file, now })
    const added = startThread('备份之后的问题')
    const first = await restoreBackup(database, {
      file,
      snapshotDirectory: snapshots(),
      now: later
    })
    if (first.status !== 'restored') {
      throw new Error('第一次恢复没有成功')
    }
    expect(readThreadView(database, added)).toBeNull()

    const back = await restoreBackup(database, {
      file: first.snapshot.file,
      snapshotDirectory: snapshots(),
      now: evenLater
    })

    expect(back.status).toBe('restored')
    expect(readThreadView(database, added)).not.toBeNull()
    expect(readThreadView(database, original)).not.toBeNull()
    // 快照是本机回退副本：从它换回来，密钥也跟着回来，不用重填。
    expect(listModelProviders(database, providerOptions())[0]?.apiKeyMask).not.toBeNull()
    expect(readLastSnapshot(database)).toMatchObject({ at: evenLater, exists: true })
  })

  it('同一秒里恢复两次，快照不互相覆盖', async () => {
    migrate(database)
    const file = backupFile()
    await createBackup(database, { file, now })

    const first = await restoreBackup(database, {
      file,
      snapshotDirectory: snapshots(),
      now: later
    })
    const second = await restoreBackup(database, {
      file,
      snapshotDirectory: snapshots(),
      now: later
    })

    if (first.status !== 'restored' || second.status !== 'restored') {
      throw new Error('恢复没有成功')
    }
    expect(second.snapshot.file).not.toBe(first.snapshot.file)
    expect(existsSync(first.snapshot.file)).toBe(true)
    expect(existsSync(second.snapshot.file)).toBe(true)
  })

  it('恢复后密钥为空：备份里没有它，得重新填', async () => {
    saveProfile('sk-restore-0001')
    const file = backupFile()
    await createBackup(database, { file, now })

    const outcome = await restoreBackup(database, {
      file,
      snapshotDirectory: snapshots(),
      now: later
    })

    expect(outcome.status).toBe('restored')
    const providers = listModelProviders(database, providerOptions())
    expect(providers).toHaveLength(1)
    expect(providers[0]?.apiKeyMask).toBeNull()
    expect(providers[0]?.verification).toBe('unverified')
  })

  it('从 v13 备份恢复后自动迁移：provider、密钥、使用中与历史都回来', async () => {
    const oldFile = join(directory, 'v13-backup.db')
    const oldDatabase = openDatabase(oldFile)
    try {
      migrate(oldDatabase, { migrations: migrations.filter((migration) => migration.version <= 13) })
      insertLegacyProfile(oldDatabase, {
        id: 'profile-old',
        apiKey: 'sk-old-backup-0003',
        name: 'Old Backup',
        model: 'deepseek-v4-pro'
      })
      oldDatabase
        .prepare(`INSERT INTO setting (key, value) VALUES ('chat.activeProfileId', 'profile-old')`)
        .run()
      oldDatabase
        .prepare(
          `INSERT INTO thread (id, title, main_kind, main_id, context_json, leaf_entry_id,
                               created_at, updated_at)
           VALUES ('thread-old', '旧线程', 'none', NULL, '[]', NULL, ?, ?)`
        )
        .run(now, now)
      oldDatabase.pragma('journal_mode = DELETE')
    } finally {
      oldDatabase.close()
    }
    expect(inspectBackupFile(oldFile)).toMatchObject({ ok: true, schemaVersion: 13 })

    const outcome = await restoreBackup(database, {
      file: oldFile,
      snapshotDirectory: snapshots(),
      now: later
    })

    expect(outcome.status).toBe('restored')
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
    const providers = listModelProviders(database, providerOptions())
    expect(providers).toHaveLength(1)
    expect(providers[0]).toMatchObject({
      providerKey: 'old-backup',
      displayName: 'Old Backup',
      protocol: 'openai-completions',
      active: true,
      verification: 'verified',
      apiKeyMask: 'sk-·············0003'
    })
    expect(providers[0]?.models[0]?.modelId).toBe('deepseek-v4-pro')
    // 历史线程一并回来；旧表保留但不再参与运行时。
    expect(readThreadView(database, 'thread-old')?.title).toBe('旧线程')
    expect(database.prepare('SELECT COUNT(*) AS count FROM model_profile').get()).toEqual({
      count: 1
    })
  })

  it('带完成时间的当前版本备份恢复后仍是已读完，进度读出 100%', async () => {
    migrate(database)
    database
      .prepare(
        `INSERT INTO article (
           id, title, kind, kind_label, session_key, session_label, set_label,
           exam_year, exam_month, exam_set, word_count, body_text, source_pdf,
           source_sha256, ordinal, completed_at
         ) VALUES ('a', 'A', 'careful_reading', '仔细阅读', '2026-06', '2026年6月', '第1套',
           2026, 6, 1, 3, 'Body.', 'a.pdf', 'sha', 1, ?)`
      )
      .run(now)
    const file = backupFile()
    await createBackup(database, { file, now })

    // 恢复到本机前先抹掉完成时间：恢复该把它带回来。
    database.prepare('UPDATE article SET completed_at = NULL').run()
    const outcome = await restoreBackup(database, {
      file,
      snapshotDirectory: snapshots(),
      now: later
    })

    expect(outcome.status).toBe('restored')
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
    expect(readArticleDetail(database, 'a')?.progress).toEqual({
      state: 'completed',
      percent: 100
    })
  })

  it('旧版本（还没有完成时间列）的备份恢复后就地补上可空列，旧数据不丢', async () => {
    const oldFile = join(directory, 'v9-schema.db')
    const oldDatabase = openDatabase(oldFile)
    try {
      migrate(oldDatabase, { migrations: migrations.filter((migration) => migration.version <= 9) })
      oldDatabase
        .prepare(
          `INSERT INTO article (
             id, title, kind, kind_label, session_key, session_label, set_label,
             exam_year, exam_month, exam_set, word_count, body_text, source_pdf,
             source_sha256, ordinal, last_opened_at, last_paragraph_id, last_sentence_index
           ) VALUES ('old', 'Old', 'careful_reading', '仔细阅读', '2026-06', '2026年6月', '第1套',
             2026, 6, 1, 3, 'Body.', 'a.pdf', 'sha', 1, '2026-11-18T08:00:00.000Z', '1', 0)`
        )
        .run()
      oldDatabase
        .prepare(
          `INSERT INTO paragraph (article_id, id, ordinal, text, page_start, page_end)
           VALUES ('old', '1', 0, 'One. Two.', 1, 1)`
        )
        .run()
      oldDatabase
        .prepare(
          `INSERT INTO sentence (article_id, paragraph_id, ordinal, text, char_start, char_end, page)
           VALUES ('old', '1', 0, 'One.', 0, 4, 1), ('old', '1', 1, ' Two.', 4, 9, 1)`
        )
        .run()
      // 应用写出的备份都是单文件（DELETE 日志）；夹具也收成单文件，避开 WAL 残余。
      oldDatabase.pragma('journal_mode = DELETE')
    } finally {
      oldDatabase.close()
    }

    const outcome = await restoreBackup(database, {
      file: oldFile,
      snapshotDirectory: snapshots(),
      now: later
    })

    expect(outcome.status).toBe('restored')
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
    expect(
      (database.pragma('table_info(article)') as { name: string }[]).map((column) => column.name)
    ).toContain('completed_at')
    expect(readArticleDetail(database, 'old')?.progress).toEqual({ state: 'reading', percent: 50 })
    expect(
      database.prepare('SELECT completed_at FROM article WHERE id = ?').get('old')
    ).toEqual({ completed_at: null })
  })

  it('旧版本的备份恢复后就地升到当前 schema，数据照常可读', async () => {
    const oldFile = join(directory, 'old-schema.db')
    const oldDatabase = openDatabase(oldFile)
    try {
      migrate(oldDatabase, { migrations: migrations.slice(0, 3) })
      writeSetting(oldDatabase, 'theme', 'dark')
    } finally {
      oldDatabase.close()
    }

    const outcome = await restoreBackup(database, {
      file: oldFile,
      snapshotDirectory: snapshots(),
      now: later
    })

    expect(outcome.status).toBe('restored')
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
    expect(readThemePreference(database)).toBe('dark')
    // 旧备份就地升级时会补上这一版新增的表。
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entry_later'")
        .get()
    ).toBeDefined()
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_provider'")
        .get()
    ).toBeDefined()
  })

  it('当前版本的备份缺了 provider 表时不会被当成可恢复的备份', async () => {
    migrate(database)
    const file = backupFile('missing-provider.db')
    await createBackup(database, { file, now })
    // 版本号写着最新、表却不齐：只看 setting 一张表就会把它当成好备份。
    const copy = openDatabase(file)
    try {
      copy.exec('DROP TABLE model_provider_model')
    } finally {
      copy.close()
    }

    expect(inspectBackupFile(file)).toEqual({ ok: false, reason: 'not-a-library' })
    expect(
      await restoreBackup(database, {
        file,
        snapshotDirectory: snapshots(),
        now: later
      })
    ).toEqual({ status: 'rejected', reason: 'not-a-library' })
  })

  it('版本高于当前程序的备份拒绝恢复，本机数据不动', async () => {
    migrate(database)
    const thread = startThread('还在的问题')
    writeSetting(database, 'theme', 'dark')
    const futureFile = join(directory, 'future.db')
    const future = openDatabase(futureFile)
    try {
      future.exec('CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      future.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 1}`)
    } finally {
      future.close()
    }

    const outcome = await restoreBackup(database, {
      file: futureFile,
      snapshotDirectory: snapshots(),
      now: later
    })

    expect(outcome).toEqual({ status: 'rejected', reason: 'too-new' })
    expect(readThreadView(database, thread)).not.toBeNull()
    expect(readThemePreference(database)).toBe('dark')
    expect(existsSync(snapshots())).toBe(false)
  })

  it('不是本程序的库拒绝恢复', async () => {
    migrate(database)
    const foreignFile = join(directory, 'foreign.db')
    const foreign = openDatabase(foreignFile)
    try {
      foreign.exec('CREATE TABLE notes (body TEXT)')
    } finally {
      foreign.close()
    }

    expect(
      await restoreBackup(database, {
        file: foreignFile,
        snapshotDirectory: snapshots(),
        now: later
      })
    ).toEqual({ status: 'rejected', reason: 'not-a-library' })
  })

  it('根本不是数据库的文件拒绝恢复', async () => {
    migrate(database)
    const textFile = join(directory, 'not-a-database.db')
    writeFileSync(textFile, '这不是数据库')

    expect(
      await restoreBackup(database, {
        file: textFile,
        snapshotDirectory: snapshots(),
        now: later
      })
    ).toEqual({ status: 'rejected', reason: 'not-a-database' })
  })

  it('找不到备份文件时说找不到', async () => {
    migrate(database)
    expect(
      await restoreBackup(database, {
        file: join(directory, 'no-such-backup.db'),
        snapshotDirectory: snapshots(),
        now: later
      })
    ).toEqual({ status: 'rejected', reason: 'missing' })
  })

  it('不能拿正在用的库文件当备份来源', async () => {
    migrate(database)
    expect(
      await restoreBackup(database, {
        file: database.name,
        snapshotDirectory: snapshots(),
        now: later
      })
    ).toEqual({ status: 'rejected', reason: 'same-file' })
  })

  it('备份不能写到正在用的库文件上', async () => {
    migrate(database)
    await expect(createBackup(database, { file: database.name, now })).rejects.toBeInstanceOf(
      BackupTargetError
    )
    expect(readLastBackup(database)).toBeNull()
  })
})

describe('inspectBackupFile', () => {
  it('挑选备份文件时先看清版本、体积与时间，不动本机数据', async () => {
    migrate(database)
    const file = backupFile()
    await createBackup(database, { file, now })

    const inspection = inspectBackupFile(file)

    expect(inspection).toMatchObject({
      ok: true,
      schemaVersion: LATEST_SCHEMA_VERSION,
      bytes: statSync(file).size
    })
    if (inspection.ok) {
      expect(Number.isNaN(Date.parse(inspection.createdAt))).toBe(false)
    }
  })

  it('不是本程序的库不会被当成备份', () => {
    const foreignFile = join(directory, 'foreign-inspect.db')
    const foreign = openDatabase(foreignFile)
    try {
      foreign.exec('CREATE TABLE notes (body TEXT)')
    } finally {
      foreign.close()
    }

    expect(inspectBackupFile(foreignFile)).toEqual({ ok: false, reason: 'not-a-library' })
  })

  it('版本号写着本程序、表却不齐的文件不会被当成备份', () => {
    const fakeFile = join(directory, 'fake-library.db')
    const fake = openDatabase(fakeFile)
    try {
      fake.exec('CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
      fake.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`)
    } finally {
      fake.close()
    }

    expect(inspectBackupFile(fakeFile)).toEqual({ ok: false, reason: 'not-a-library' })
  })

  it('版本号写着最新、表也齐但没有完成时间列的文件不会被当成备份', () => {
    // 停在加完成时间列之前（v10）的库：表全在，只差 article.completed_at；
    // 把版本号谎报成最新时，列检查必须把它拦下。
    const fakeFile = join(directory, 'fake-columns.db')
    const fake = openDatabase(fakeFile)
    try {
      migrate(fake, { migrations: migrations.filter((migration) => migration.version <= 10) })
      fake.pragma(`user_version = ${LATEST_SCHEMA_VERSION}`)
    } finally {
      fake.close()
    }

    expect(inspectBackupFile(fakeFile)).toEqual({ ok: false, reason: 'not-a-library' })
  })

  it('读不了的目标（比如目录）说不是数据库，不把异常抛给界面', () => {
    expect(inspectBackupFile(directory)).toEqual({ ok: false, reason: 'not-a-database' })
  })
})
