import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from './database'
import {
  LATEST_SCHEMA_VERSION,
  SchemaTooNewError,
  migrate,
  migrations,
  readSchemaVersion,
  type Migration
} from './migrations'

let directory: string
let database: AppDatabase

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-db-'))
  database = openDatabase(join(directory, 'test.db'))
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('migrate', () => {
  it('空库首启迁移到最新 schema 版本', () => {
    const outcome = migrate(database)

    expect(outcome.from).toBe(0)
    expect(outcome.to).toBe(LATEST_SCHEMA_VERSION)
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
  })

  it('已是最新版本时不再执行迁移', () => {
    let runs = 0
    const plan: readonly Migration[] = [
      {
        version: 1,
        up: () => {
          runs += 1
        }
      }
    ]

    const first = migrate(database, { migrations: plan })
    const second = migrate(database, { migrations: plan })

    expect(first.applied).toEqual([1])
    expect(second.applied).toEqual([])
    expect(runs).toBe(1)
  })

  it('按版本顺序执行待应用的迁移', () => {
    const executed: number[] = []
    const plan: readonly Migration[] = [
      { version: 1, up: () => executed.push(1) },
      { version: 2, up: () => executed.push(2) }
    ]

    const outcome = migrate(database, { migrations: plan })

    expect(executed).toEqual([1, 2])
    expect(outcome.applied).toEqual([1, 2])
    expect(readSchemaVersion(database)).toBe(2)
  })

  it('迁移失败时整体回滚，版本不前进', () => {
    const plan: readonly Migration[] = [
      {
        version: 1,
        up: (target) => target.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY)')
      },
      {
        version: 2,
        up: () => {
          throw new Error('boom')
        }
      }
    ]

    expect(() => migrate(database, { migrations: plan })).toThrow('boom')
    expect(readSchemaVersion(database)).toBe(0)
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'probe'").get()
    ).toBeUndefined()
  })

  it('拒绝版本高于本程序的数据库', () => {
    database.pragma('user_version = 99')

    expect(() => migrate(database)).toThrow(SchemaTooNewError)
    expect(readSchemaVersion(database)).toBe(99)
  })

  it('迁移出学习内容表：同一个词条只能置顶一条', () => {
    migrate(database)

    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'learning_note'")
      .get()
    expect(table).toBeDefined()

    const insert = database.prepare(
      `INSERT INTO word_entry (id, main_form, normalized_key, created_at, last_collected_at)
       VALUES ('entry-1', 'approach', 'approach', '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`
    )
    insert.run()
    const insertNote = database.prepare(
      `INSERT INTO learning_note (id, entry_id, body, pinned, created_at, updated_at)
       VALUES (?, 'entry-1', '写法', ?, '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`
    )
    insertNote.run('note-1', 1)

    expect(() => insertNote.run('note-2', 1)).toThrow(/UNIQUE/)
    expect(() => insertNote.run('note-3', 0)).not.toThrow()
  })

  it('把旧库的 article.position 换成 ordinal，已导入的文章一条不丢', () => {
    // 先造一份真正停在 8 版的旧库：只跑 1–8 的迁移，不能先升到最新再倒回版本号，
    // 否则后面的迁移会在已经升级过的 schema 上再跑一次。
    migrate(database, {
      migrations: migrations.filter((migration) => migration.version <= 8)
    })
    // 还原早期构建留下的库：列名是 position，但 user_version 已经走到 8。
    database.exec('ALTER TABLE article RENAME COLUMN ordinal TO position')
    database
      .prepare(
        `INSERT INTO article (
           id, title, kind, kind_label, session_key, session_label, set_label,
           exam_year, exam_month, exam_set, word_count, body_text, source_pdf,
           source_sha256, page_start, page_end, position
         ) VALUES (
           'cet6-2023-06-s1-b', '2023年6月 · 第1套 · 长篇匹配', 'long_match', '长篇匹配',
           '2023-06', '2023年6月', '第1套', 2023, 6, 1, 3, 'Body text.', 'a.pdf',
           'sha', 1, 2, 7
         )`
      )
      .run()

    const outcome = migrate(database)

    expect(outcome.from).toBe(8)
    // 后缀按实际排在 position→ordinal 之后的迁移逐条写出来，不靠「迁到最新」一句带过：
    // 10 是稍后看表，11 是完成时间列，12 是学习指令表，13 是生成文章来源，14 是模型提供商。
    expect(outcome.applied).toEqual([9, 10, 11, 12, 13, 14])
    const columns = (database.pragma('table_info(article)') as { name: string }[]).map(
      (column) => column.name
    )
    expect(columns).toContain('ordinal')
    expect(columns).not.toContain('position')
    expect(columns).toContain('completed_at')
    // 旧记录原样保留，新列默认 NULL 而不是随便补一个「已读完」。
    expect(database.prepare('SELECT id, ordinal, completed_at FROM article').get()).toEqual({
      id: 'cet6-2023-06-s1-b',
      ordinal: 7,
      completed_at: null
    })
    // 已经迁到最新的库不会再跑一遍；不重置 user_version 去看迁移副作用。
    expect(migrate(database).applied).toEqual([])
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
  })

  it('完成时间只增列：旧库已有的阅读位置与设置原样保留', () => {
    // 先迁到 v9（既没有稍后看表、也没有完成时间列的一版），写入一篇读过的文章。
    migrate(database, { migrations: migrations.filter((migration) => migration.version <= 9) })
    database
      .prepare(
        `INSERT INTO article (
           id, title, kind, kind_label, session_key, session_label, set_label,
           exam_year, exam_month, exam_set, word_count, body_text, source_pdf,
           source_sha256, ordinal
         ) VALUES ('a', 'A', 'careful_reading', '仔细阅读', '2026-06', '2026年6月', '第1套',
           2026, 6, 1, 3, 'Body.', 'a.pdf', 'sha', 1)`
      )
      .run()
    database
      .prepare(
        `UPDATE article
            SET last_opened_at = '2026-11-18T08:00:00.000Z',
                last_paragraph_id = '1',
                last_sentence_index = 0
          WHERE id = 'a'`
      )
      .run()
    database
      .prepare(
        `INSERT INTO article_reading_setting
           (article_id, font_size, line_height_tenths, annotations_visible, weak_highlight)
         VALUES ('a', 22, 20, 0, 0)`
      )
      .run()

    const outcome = migrate(database)

    expect(outcome.from).toBe(9)
    // 10 先建稍后看表，11 再给文章补完成时间，12 最后建学习指令表；三笔都只增不改。
    expect(outcome.applied).toEqual([10, 11, 12, 13, 14])
    // 稍后看表跟着建起来，已有的词条数据不受影响。
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entry_later'")
        .get()
    ).toBeDefined()
    expect(
      database
        .prepare(
          `SELECT last_opened_at, last_paragraph_id, last_sentence_index, completed_at
             FROM article WHERE id = 'a'`
        )
        .get()
    ).toEqual({
      last_opened_at: '2026-11-18T08:00:00.000Z',
      last_paragraph_id: '1',
      last_sentence_index: 0,
      completed_at: null
    })
    expect(
      database
        .prepare(
          `SELECT font_size, line_height_tenths, annotations_visible, weak_highlight
             FROM article_reading_setting WHERE article_id = 'a'`
        )
        .get()
    ).toEqual({ font_size: 22, line_height_tenths: 20, annotations_visible: 0, weak_highlight: 0 })
  })

  it('把停在 9 版的旧库升到最新：新建稍后看表并补完成时间列，原有词条照常可读', () => {
    // 版本 10 加一张独立的「稍后看」表，版本 11 给文章补可空的完成时间；
    // 老库升级后标记从空开始、完成时间全为 NULL，旧数据不动。
    migrate(database, {
      migrations: migrations.filter((migration) => migration.version <= 9)
    })
    database
      .prepare(
        `INSERT INTO word_entry (id, main_form, normalized_key, created_at, last_collected_at)
         VALUES ('entry-old', 'approach', 'approach', '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`
      )
      .run()
    expect(readSchemaVersion(database)).toBe(9)
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entry_later'")
        .get()
    ).toBeUndefined()

    const outcome = migrate(database)

    expect(outcome.applied).toEqual([10, 11, 12, 13, 14])
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
    expect(
      (database.pragma('table_info(article)') as { name: string }[]).map((column) => column.name)
    ).toContain('completed_at')
    // 新表默认是空的；旧的词条一条不丢。
    expect(database.prepare('SELECT COUNT(*) AS count FROM entry_later').get()).toEqual({
      count: 0
    })
    expect(database.prepare('SELECT id, main_form FROM word_entry').get()).toEqual({
      id: 'entry-old',
      main_form: 'approach'
    })
  })

  it('12 版追加学习指令表、13 版追加来源列：停在 11 的旧库升级后旧数据原样保留，表从空开始', () => {
    // 学习指令是独立表，不借 setting、也不动文章 / 词条 / 线程；示例只在前端常量里。
    migrate(database, {
      migrations: migrations.filter((migration) => migration.version <= 11)
    })
    database
      .prepare(
        `INSERT INTO setting (key, value) VALUES ('reading.font-size', '22')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO word_entry (id, main_form, normalized_key, created_at, last_collected_at)
         VALUES ('entry-old', 'approach', 'approach', '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO article (
           id, title, kind, kind_label, session_key, session_label, set_label,
           exam_year, exam_month, exam_set, word_count, body_text, source_pdf,
           source_sha256, ordinal
         ) VALUES ('a', 'A', 'careful_reading', '仔细阅读', '2026-06', '2026年6月', '第1套',
           2026, 6, 1, 3, 'Body.', 'a.pdf', 'sha', 1)`
      )
      .run()
    expect(readSchemaVersion(database)).toBe(11)
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'learning_instruction'"
        )
        .get()
    ).toBeUndefined()

    const outcome = migrate(database)

    expect(outcome.from).toBe(11)
    expect(outcome.applied).toEqual([12, 13, 14])
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
    expect(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'learning_instruction_updated'"
        )
        .get()
    ).toBeDefined()
    // 新表默认是空的，内置示例没有被写成用户记录。
    expect(database.prepare('SELECT COUNT(*) AS count FROM learning_instruction').get()).toEqual({
      count: 0
    })
    // 旧数据一条不丢。
    expect(database.prepare("SELECT value FROM setting WHERE key = 'reading.font-size'").get()).toEqual({
      value: '22'
    })
    expect(database.prepare('SELECT id, main_form FROM word_entry').get()).toEqual({
      id: 'entry-old',
      main_form: 'approach'
    })
    expect(database.prepare('SELECT id, ordinal FROM article').get()).toEqual({ id: 'a', ordinal: 1 })
    expect(migrate(database).applied).toEqual([])
  })

  it('13 版只给文章补来源类型与来源词条：停在 12 的旧库升级后旧数据原样保留', () => {
    // 生成文章需要记录「AI 生成」与来源词条；两个新列都可空，老行保持 NULL（视为真题）。
    // 不改 v1–12，也不在同一笔迁移里重写任何既有数据。
    migrate(database, {
      migrations: migrations.filter((migration) => migration.version <= 12)
    })
    database
      .prepare(
        `INSERT INTO article (
           id, title, kind, kind_label, session_key, session_label, set_label,
           exam_year, exam_month, exam_set, word_count, body_text, source_pdf,
           source_sha256, ordinal, completed_at
         ) VALUES ('exam-1', '2024年6月 · 第1套 · 仔细阅读 Passage One', 'careful_reading',
           '仔细阅读 Passage One', '2024-06', '2024年6月', '第1套', 2024, 6, 1, 3,
           'Old body.', 'a.pdf', 'sha', 1, '2026-11-18T09:00:00.000Z')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO word_entry (id, main_form, normalized_key, created_at, last_collected_at)
         VALUES ('entry-old', 'approach', 'approach', '2026-11-18T08:00:00.000Z',
                 '2026-11-18T08:00:00.000Z')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO learning_note (id, entry_id, body, pinned, created_at, updated_at)
         VALUES ('note-old', 'entry-old', '旧的学习内容', 0, '2026-11-18T08:00:00.000Z',
                 '2026-11-18T08:00:00.000Z')`
      )
      .run()
    database
      .prepare(`INSERT INTO entry_later (entry_id, marked_at) VALUES ('entry-old', '2026-11-18T08:30:00.000Z')`)
      .run()
    database
      .prepare(
        `INSERT INTO learning_instruction (id, name, body, created_at, updated_at)
         VALUES ('instruction-old', '旧指令', '照我的问法解释', '2026-11-18T08:00:00.000Z',
                 '2026-11-18T08:00:00.000Z')`
      )
      .run()

    const columnsBefore = (database.pragma('table_info(article)') as { name: string }[]).map(
      (column) => column.name
    )
    expect(columnsBefore).not.toContain('source_type')
    expect(columnsBefore).not.toContain('source_entry_ids')

    const outcome = migrate(database)

    expect(outcome.from).toBe(12)
    expect(outcome.applied).toEqual([13, 14])
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
    const columns = (database.pragma('table_info(article)') as { name: string }[]).map(
      (column) => column.name
    )
    expect(columns).toContain('source_type')
    expect(columns).toContain('source_entry_ids')
    // 旧文章是真题：来源类型留空，读取时按 NULL 处理，不在迁移里补写。
    expect(
      database.prepare('SELECT source_type, source_entry_ids FROM article WHERE id = ?').get('exam-1')
    ).toEqual({ source_type: null, source_entry_ids: null })
    // 既有文章、完成时间、词条、稍后看、学习内容与学习指令一条不丢。
    expect(
      database
        .prepare('SELECT completed_at, body_text FROM article WHERE id = ?')
        .get('exam-1')
    ).toEqual({ completed_at: '2026-11-18T09:00:00.000Z', body_text: 'Old body.' })
    expect(database.prepare('SELECT entry_id FROM entry_later').get()).toEqual({
      entry_id: 'entry-old'
    })
    expect(database.prepare('SELECT body FROM learning_note WHERE id = ?').get('note-old')).toEqual({
      body: '旧的学习内容'
    })
    expect(
      database.prepare('SELECT name FROM learning_instruction WHERE id = ?').get('instruction-old')
    ).toEqual({ name: '旧指令' })
    // 重复迁移无操作。
    expect(migrate(database).applied).toEqual([])
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
  })

  it('14 版把多套旧模型配置迁成 custom provider 与模型，密文、状态、使用中与历史都保留', () => {
    migrate(database, {
      migrations: migrations.filter((migration) => migration.version <= 13)
    })
    const insertProfile = database.prepare(
      `INSERT INTO model_profile (
         id, name, base_url, model, api_key_secret, verification, last_error,
         last_checked_at, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insertProfile.run(
      'profile-deepseek',
      'DeepSeek 官方',
      'https://api.deepseek.com',
      'deepseek-flash',
      'sealed:key-one',
      'verified',
      null,
      '2026-11-18T09:30:00.000Z',
      '2026-11-18T09:30:00.000Z',
      '2026-11-18T09:00:00.000Z',
      '2026-11-18T09:30:00.000Z'
    )
    insertProfile.run(
      'profile-backup',
      '备用',
      'https://backup.example.com/v1',
      'backup-model',
      'sealed:key-two',
      'unverified',
      'network',
      '2026-11-18T09:10:00.000Z',
      null,
      '2026-11-18T09:05:00.000Z',
      '2026-11-18T09:10:00.000Z'
    )
    insertProfile.run(
      'profile-third',
      'DeepSeek 官方',
      'https://third.example.com',
      'third-model',
      null,
      'unverified',
      null,
      null,
      null,
      '2026-11-18T09:06:00.000Z',
      '2026-11-18T09:06:00.000Z'
    )
    database
      .prepare(`INSERT INTO setting (key, value) VALUES ('chat.activeProfileId', ?)`)
      .run('profile-backup')
    database
      .prepare(
        `INSERT INTO thread (id, title, main_kind, main_id, context_json, leaf_entry_id, created_at, updated_at)
         VALUES ('thread-old', '旧线程', 'none', NULL, '[]', NULL,
                 '2026-11-18T08:00:00.000Z', '2026-11-18T08:00:00.000Z')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO pin (
           id, thread_id, thread_title, answer_id, turn_index, model, captured_text,
           char_start, char_end, source_sentence_id, source_sentence_text, target_kind,
           target_id, created_at
         ) VALUES ('pin-old', 'thread-old', '旧线程', 'answer-old', 0, 'deepseek-flash',
                   '钉住的一段', 0, 5, NULL, NULL, 'unfiled', NULL,
                   '2026-11-18T08:10:00.000Z')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO word_entry (id, main_form, normalized_key, created_at, last_collected_at)
         VALUES ('entry-old', 'approach', 'approach', '2026-11-18T08:00:00.000Z',
                 '2026-11-18T08:00:00.000Z')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO learning_note (id, entry_id, body, pinned, created_at, updated_at)
         VALUES ('note-old', 'entry-old', '旧的学习内容', 0, '2026-11-18T08:00:00.000Z',
                 '2026-11-18T08:00:00.000Z')`
      )
      .run()
    expect(readSchemaVersion(database)).toBe(13)

    const outcome = migrate(database)

    expect(outcome.from).toBe(13)
    expect(outcome.applied).toEqual([14])
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)

    const providers = database
      .prepare(
        `SELECT id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
                secret_ciphertext, retry_policy, verification, last_error, last_checked_at,
                last_verified_at, source, default_model_id
           FROM model_provider ORDER BY created_at, rowid`
      )
      .all() as {
      id: string
      provider_key: string
      display_name: string
      protocol: string
      base_url: string
      auth_mode: string
      env_var: string | null
      secret_ciphertext: string | null
      retry_policy: string
      verification: string
      last_error: string | null
      last_checked_at: string | null
      last_verified_at: string | null
      source: string
      default_model_id: string | null
    }[]
    expect(providers).toHaveLength(3)
    expect(providers.map((provider) => provider.id)).toEqual([
      'profile-deepseek',
      'profile-backup',
      'profile-third'
    ])
    expect(providers.map((provider) => [provider.provider_key, provider.display_name])).toEqual([
      ['deepseek', 'DeepSeek 官方'],
      // 名称没有可用的拉丁字母时从地址派生，仍以小写字母开头。
      ['backup-example-com', '备用'],
      // 重名时加后缀，不让 provider_key 撞车。
      ['deepseek-2', 'DeepSeek 官方']
    ])
    for (const provider of providers) {
      expect(provider.provider_key).toMatch(/^[a-z][a-z0-9-]*$/)
      expect(provider.protocol).toBe('openai-completions')
      expect(provider.auth_mode).toBe('stored')
      expect(provider.env_var).toBeNull()
      expect(provider.retry_policy).toBe('{"mode":"normal"}')
      expect(provider.source).toBe('custom')
    }
    expect(providers[0]).toMatchObject({
      base_url: 'https://api.deepseek.com',
      secret_ciphertext: 'sealed:key-one',
      verification: 'verified',
      last_checked_at: '2026-11-18T09:30:00.000Z',
      last_verified_at: '2026-11-18T09:30:00.000Z'
    })
    expect(providers[1]).toMatchObject({
      secret_ciphertext: 'sealed:key-two',
      verification: 'unverified',
      last_error: 'network',
      last_checked_at: '2026-11-18T09:10:00.000Z',
      last_verified_at: null
    })
    expect(providers[2]?.secret_ciphertext).toBeNull()

    const models = database
      .prepare(
        `SELECT provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
                input, reasoning, source, sort, id
           FROM model_provider_model ORDER BY rowid`
      )
      .all() as {
      id: string
      provider_id: string
      model_id: string
      display_name: string
      api: string
      base_url: string | null
      context_window: number | null
      max_tokens: number | null
      input: string
      reasoning: number
      source: string
      sort: number
    }[]
    expect(models).toHaveLength(3)
    expect(models.map((model) => [model.provider_id, model.model_id])).toEqual([
      ['profile-deepseek', 'deepseek-flash'],
      ['profile-backup', 'backup-model'],
      ['profile-third', 'third-model']
    ])
    expect(models[0]).toMatchObject({
      display_name: 'deepseek-flash',
      api: 'openai-completions',
      base_url: null,
      context_window: null,
      max_tokens: null,
      input: 'text',
      reasoning: 0,
      source: 'manual',
      sort: 0
    })
    for (const provider of providers) {
      const model = models.find((candidate) => candidate.provider_id === provider.id)
      expect(provider.default_model_id).toBe(model?.id)
    }

    // 使用中的旧配置变成使用中的 provider；旧键迁走后不再留着。
    expect(
      database.prepare(`SELECT value FROM setting WHERE key = 'chat.activeProviderId'`).get()
    ).toEqual({ value: 'profile-backup' })
    expect(
      database.prepare(`SELECT value FROM setting WHERE key = 'chat.activeProfileId'`).get()
    ).toBeUndefined()

    // 历史记录原样保留。
    expect(database.prepare(`SELECT title FROM thread WHERE id = 'thread-old'`).get()).toEqual({
      title: '旧线程'
    })
    expect(database.prepare(`SELECT captured_text FROM pin WHERE id = 'pin-old'`).get()).toEqual({
      captured_text: '钉住的一段'
    })
    expect(database.prepare(`SELECT body FROM learning_note WHERE id = 'note-old'`).get()).toEqual({
      body: '旧的学习内容'
    })
    // 旧表只留作回滚，不再由迁移删掉。
    expect(database.prepare('SELECT COUNT(*) AS count FROM model_profile').get()).toEqual({
      count: 3
    })
    // 重复迁移无操作。
    expect(migrate(database).applied).toEqual([])
  })

  it('provider_key 始终以小写字母开头：数字开头或全中文的名字退到地址', () => {
    migrate(database, {
      migrations: migrations.filter((migration) => migration.version <= 13)
    })
    const insert = database.prepare(
      `INSERT INTO model_profile (
         id, name, base_url, model, api_key_secret, verification, last_error,
         last_checked_at, last_verified_at, created_at, updated_at
       ) VALUES (?, ?, ?, 'm', NULL, 'unverified', NULL, NULL, NULL, ?, ?)`
    )
    insert.run('p-numeric', '3rd Party', 'https://api.example.com/v1', '2026-11-18T09:00:00.000Z', '2026-11-18T09:00:00.000Z')
    insert.run('p-chinese', '第一套', 'https://gateway.example.org', '2026-11-18T09:00:00.000Z', '2026-11-18T09:00:00.000Z')

    migrate(database)

    expect(
      database
        .prepare(`SELECT id, provider_key FROM model_provider ORDER BY id`)
        .all()
    ).toEqual([
      { id: 'p-chinese', provider_key: 'gateway-example-org' },
      { id: 'p-numeric', provider_key: 'api-example-com' }
    ])
  })

  it('14 版迁移中途失败时整笔回滚，并给出带版本与对象的可读错误', () => {
    migrate(database, {
      migrations: migrations.filter((migration) => migration.version <= 13)
    })
    database
      .prepare(
        `INSERT INTO model_profile (
           id, name, base_url, model, api_key_secret, verification, last_error,
           last_checked_at, last_verified_at, created_at, updated_at
         ) VALUES ('profile-old', '旧配置', 'https://api.deepseek.com', 'deepseek-flash',
                   'sealed:keep', 'verified', NULL, NULL, NULL,
                   '2026-11-18T09:00:00.000Z', '2026-11-18T09:00:00.000Z')`
      )
      .run()
    // 制造一次「建到一半才失败」：provider 表能建，模型表被同名旧对象占住。
    database.exec('CREATE TABLE model_provider_model (id TEXT PRIMARY KEY)')

    expect(() => migrate(database)).toThrow(/版本 14/)
    expect(readSchemaVersion(database)).toBe(13)
    expect(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_provider'")
        .get()
    ).toBeUndefined()
    expect(database.prepare('SELECT COUNT(*) AS count FROM model_profile').get()).toEqual({
      count: 1
    })
    expect(database.prepare('SELECT api_key_secret FROM model_profile').get()).toEqual({
      api_key_secret: 'sealed:keep'
    })
  })

  it('11 版的旧库直接升到最新：学习内容、完成状态、稍后看与文章都在', () => {
    migrate(database, {
      migrations: migrations.filter((migration) => migration.version <= 11)
    })
    database
      .prepare(
        `INSERT INTO article (
           id, title, kind, kind_label, session_key, session_label, set_label,
           exam_year, exam_month, exam_set, word_count, body_text, source_pdf,
           source_sha256, ordinal
         ) VALUES ('exam-11', '2023年12月 · 第2套 · 长篇匹配', 'long_match', '长篇匹配',
           '2023-12', '2023年12月', '第2套', 2023, 12, 2, 5, 'Old eleven body.', 'b.pdf',
           'sha-11', 2)`
      )
      .run()
    database
      .prepare(
        `INSERT INTO word_entry (id, main_form, normalized_key, created_at, last_collected_at)
         VALUES ('entry-11', 'context', 'context', '2026-11-18T08:00:00.000Z',
                 '2026-11-18T08:00:00.000Z')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO learning_note (id, entry_id, body, pinned, created_at, updated_at)
         VALUES ('note-11', 'entry-11', '保留的内容', 1, '2026-11-18T08:00:00.000Z',
                 '2026-11-18T08:00:00.000Z')`
      )
      .run()
    database
      .prepare(`INSERT INTO entry_later (entry_id, marked_at) VALUES ('entry-11', '2026-11-18T08:20:00.000Z')`)
      .run()
    expect(readSchemaVersion(database)).toBe(11)

    const outcome = migrate(database)

    expect(outcome.from).toBe(11)
    expect(outcome.applied).toEqual([12, 13, 14])
    expect(readSchemaVersion(database)).toBe(LATEST_SCHEMA_VERSION)
    expect(
      (database.pragma('table_info(article)') as { name: string }[]).map((column) => column.name)
    ).toEqual(expect.arrayContaining(['completed_at', 'source_type', 'source_entry_ids']))
    expect(
      database
        .prepare('SELECT completed_at, source_type, source_entry_ids FROM article WHERE id = ?')
        .get('exam-11')
    ).toEqual({ completed_at: null, source_type: null, source_entry_ids: null })
    expect(database.prepare('SELECT body, pinned FROM learning_note WHERE id = ?').get('note-11')).toEqual({
      body: '保留的内容',
      pinned: 1
    })
    expect(database.prepare('SELECT entry_id FROM entry_later').get()).toEqual({
      entry_id: 'entry-11'
    })
    expect(migrate(database).applied).toEqual([])
  })
})
