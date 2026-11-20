import { randomUUID } from 'node:crypto'
import type { AppDatabase } from './database'
import { deriveProviderKey } from './provider-key'

export type Migration = {
  version: number
  up: (database: AppDatabase) => void
}

/**
 * 显式版本号迁移：版本只增不减，启动时只在落后时执行，不在加载旧数据时原地改写。
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    up: (database) => {
      database.exec(`
        CREATE TABLE setting (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)
    }
  },
  {
    version: 2,
    up: (database) => {
      // 文章、段落、句子与原文注释是阅读、选词与出处的共同底座：
      // 句子持久化段内字符区间，原文注释按词挂在段落内的字符区间上。
      database.exec(`
        CREATE TABLE article (
          id                TEXT PRIMARY KEY,
          title             TEXT NOT NULL,
          kind              TEXT NOT NULL,
          kind_label        TEXT NOT NULL,
          session_key       TEXT NOT NULL,
          session_label     TEXT NOT NULL,
          set_label         TEXT NOT NULL,
          exam_year         INTEGER NOT NULL,
          exam_month        INTEGER NOT NULL,
          exam_set          INTEGER NOT NULL,
          word_count        INTEGER NOT NULL,
          body_text         TEXT NOT NULL,
          source_pdf        TEXT NOT NULL,
          source_sha256     TEXT NOT NULL,
          page_start        INTEGER,
          page_end          INTEGER,
          ordinal           INTEGER NOT NULL,
          last_opened_at    TEXT,
          last_paragraph_id TEXT,
          last_sentence_index INTEGER,
          created_at        TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX article_session ON article (session_key, ordinal);

        CREATE TABLE paragraph (
          article_id TEXT NOT NULL REFERENCES article(id) ON DELETE CASCADE,
          id         TEXT NOT NULL,
          ordinal    INTEGER NOT NULL,
          text       TEXT NOT NULL,
          page_start INTEGER,
          page_end   INTEGER,
          PRIMARY KEY (article_id, id)
        );

        CREATE TABLE sentence (
          article_id   TEXT NOT NULL,
          paragraph_id TEXT NOT NULL,
          ordinal      INTEGER NOT NULL,
          text         TEXT NOT NULL,
          char_start   INTEGER NOT NULL,
          char_end     INTEGER NOT NULL,
          page         INTEGER,
          PRIMARY KEY (article_id, paragraph_id, ordinal),
          FOREIGN KEY (article_id, paragraph_id)
            REFERENCES paragraph(article_id, id) ON DELETE CASCADE
        );

        CREATE TABLE annotation (
          article_id       TEXT NOT NULL,
          paragraph_id     TEXT NOT NULL,
          sentence_ordinal INTEGER NOT NULL,
          ordinal          INTEGER NOT NULL,
          surface          TEXT NOT NULL,
          gloss            TEXT NOT NULL,
          char_start       INTEGER NOT NULL,
          char_end         INTEGER NOT NULL,
          PRIMARY KEY (article_id, paragraph_id, char_start),
          FOREIGN KEY (article_id, paragraph_id)
            REFERENCES paragraph(article_id, id) ON DELETE CASCADE
        );
      `)
    }
  },
  {
    version: 3,
    up: (database) => {
      // 阅读页的字号、行距与注释开关按篇记住；没有这一行时整份用全局默认。
      // 行距存十分之一，避免 1.6 / 1.8 / 2.0 的浮点比较。
      database.exec(`
        CREATE TABLE article_reading_setting (
          article_id          TEXT PRIMARY KEY REFERENCES article(id) ON DELETE CASCADE,
          font_size           INTEGER NOT NULL,
          line_height_tenths  INTEGER NOT NULL,
          annotations_visible INTEGER NOT NULL,
          updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `)
    }
  },
  {
    version: 4,
    up: (database) => {
      // 选词的落点：一个词或短语归到一个词条，词条下挂着每条来自阅读的原句。
      // 同篇同句重复圈同一个词条只保留一条关联；句子没了，关联跟着删。
      database.exec(`
        CREATE TABLE word_entry (
          id                TEXT PRIMARY KEY,
          main_form         TEXT NOT NULL,
          normalized_key    TEXT NOT NULL UNIQUE,
          created_at        TEXT NOT NULL,
          last_collected_at TEXT NOT NULL
        );

        CREATE TABLE entry_sentence (
          id               TEXT PRIMARY KEY,
          entry_id         TEXT NOT NULL REFERENCES word_entry(id) ON DELETE CASCADE,
          article_id       TEXT NOT NULL,
          paragraph_id     TEXT NOT NULL,
          sentence_ordinal INTEGER NOT NULL,
          surface          TEXT NOT NULL,
          char_start       INTEGER NOT NULL,
          char_end         INTEGER NOT NULL,
          collected_at     TEXT NOT NULL,
          UNIQUE (entry_id, article_id, paragraph_id, sentence_ordinal),
          FOREIGN KEY (article_id, paragraph_id, sentence_ordinal)
            REFERENCES sentence(article_id, paragraph_id, ordinal) ON DELETE CASCADE
        );

        CREATE INDEX entry_sentence_article
          ON entry_sentence (article_id, paragraph_id, sentence_ordinal);
        CREATE INDEX entry_sentence_entry ON entry_sentence (entry_id);

        -- 重读时给已收集的词做弱高亮，可单独关掉；默认开。
        ALTER TABLE article_reading_setting
          ADD COLUMN weak_highlight INTEGER NOT NULL DEFAULT 1;
      `)
    }
  },
  {
    version: 5,
    up: (database) => {
      // 学习内容：词条下的一段材料，可以由对话钉进来，也可以就地手写。
      // 只保留最终稿，不存历史版本；同一个词条最多置顶一条（部分唯一索引兜住）。
      database.exec(`
        CREATE TABLE learning_note (
          id            TEXT PRIMARY KEY,
          entry_id      TEXT NOT NULL REFERENCES word_entry(id) ON DELETE CASCADE,
          body          TEXT NOT NULL,
          pinned        INTEGER NOT NULL DEFAULT 0,
          source_kind   TEXT NOT NULL DEFAULT 'manual',
          source_pin_id TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );

        CREATE INDEX learning_note_entry
          ON learning_note (entry_id, pinned DESC, created_at DESC);
        CREATE UNIQUE INDEX learning_note_entry_pinned
          ON learning_note (entry_id) WHERE pinned = 1;
      `)
    }
  },
  {
    version: 6,
    up: (database) => {
      // 线程与它的条目日志：条目只追加，parent_id 构成树，线程只记一个 leaf_entry_id。
      // 重新生成与改口都新增条目，旧回答一条不删；分支切换只改 leaf 一行。
      database.exec(`
        CREATE TABLE thread (
          id            TEXT PRIMARY KEY,
          title         TEXT NOT NULL,
          main_kind     TEXT NOT NULL,
          main_id       TEXT,
          context_json  TEXT NOT NULL DEFAULT '[]',
          leaf_entry_id TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );

        CREATE TABLE thread_entry (
          id         TEXT PRIMARY KEY,
          thread_id  TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
          parent_id  TEXT REFERENCES thread_entry(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL,
          payload    TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX thread_updated ON thread (updated_at DESC);
        CREATE INDEX thread_entry_thread ON thread_entry (thread_id, created_at);
        CREATE INDEX thread_entry_parent ON thread_entry (parent_id, created_at);
      `)
    }
  },
  {
    version: 7,
    up: (database) => {
      // 钉住是独立快照，故意不挂外键：删线程、切分支、删回答都不影响已钉住的内容。
      // 出处里的线程名、轮次、模型、原句都是钉住那一刻抄下来的，之后对不上也不改。
      // `start` / `end` 是片段在那一版回答正文里的字符区间，用来在对话里常驻描边。
      database.exec(`
        CREATE TABLE pin (
          id                   TEXT PRIMARY KEY,
          thread_id            TEXT NOT NULL,
          thread_title         TEXT NOT NULL,
          answer_id            TEXT NOT NULL,
          turn_index           INTEGER NOT NULL,
          model                TEXT NOT NULL,
          captured_text        TEXT NOT NULL,
          char_start           INTEGER NOT NULL,
          char_end             INTEGER NOT NULL,
          source_sentence_id   TEXT,
          source_sentence_text TEXT,
          target_kind          TEXT NOT NULL,
          target_id            TEXT,
          created_at           TEXT NOT NULL
        );

        CREATE INDEX pin_thread ON pin (thread_id, created_at DESC);
        CREATE INDEX pin_target ON pin (target_kind, target_id, created_at DESC);
        CREATE INDEX pin_unfiled ON pin (created_at DESC) WHERE target_kind = 'unfiled';
      `)
    }
  },
  {
    version: 8,
    up: (database) => {
      // 多套模型服务配置。密钥只存 safeStorage（DPAPI）加密后的密文，明文不落库；
      // 校验状态区分「确实通过」与「还没验证」，断网时可以先存着，成功调用后自动转已验证。
      // 备份必须跳过 api_key_secret 这一列，密钥默认不进备份（见 #36）。
      database.exec(`
        CREATE TABLE model_profile (
          id               TEXT PRIMARY KEY,
          name             TEXT NOT NULL,
          base_url         TEXT NOT NULL,
          model            TEXT NOT NULL,
          api_key_secret   TEXT,
          verification     TEXT NOT NULL DEFAULT 'unverified',
          last_error       TEXT,
          last_checked_at  TEXT,
          last_verified_at TEXT,
          created_at       TEXT NOT NULL,
          updated_at       TEXT NOT NULL
        );

        CREATE INDEX model_profile_created ON model_profile (created_at);
      `)
    }
  },
  {
    version: 9,
    up: (database) => {
      // 早期构建把 article 的库内顺序列叫 position；后来实现里改成了 ordinal。
      // 迁移只在版本号落后时跑，所以这些老库停在 8 却带着旧列名，必须单独修一次。
      const columns = database.pragma('table_info(article)') as { name: string }[]
      const hasPosition = columns.some((column) => column.name === 'position')
      const hasOrdinal = columns.some((column) => column.name === 'ordinal')
      if (hasPosition && !hasOrdinal) {
        database.exec('ALTER TABLE article RENAME COLUMN position TO ordinal')
      }
    }
  },
  {
    version: 10,
    up: (database) => {
      // 「稍后看」是按词条的一条独立标记，只记标记时间：不算进已收集，
      // 也不参看原句数、学习内容或收集时间。词条删掉（例如删最后一条原句）时
      // 标记随外键级联消失；反向不成立——标记不会凭空建出词条。
      database.exec(`
        CREATE TABLE entry_later (
          entry_id  TEXT PRIMARY KEY REFERENCES word_entry(id) ON DELETE CASCADE,
          marked_at TEXT NOT NULL
        );

        CREATE INDEX entry_later_marked ON entry_later (marked_at DESC);
      `)
    }
  },
  {
    version: 11,
    up: (database) => {
      // 「进入本篇选词」即视为读完：只追加一个可空的完成时间，旧文章默认 NULL。
      // 进度由此得到第三种状态（已读完、100%）；阅读位置与设置仍是各自独立的列，
      // 完成时间只写一次，重读、滚动、改设置都不该把它清掉或重写。
      database.exec('ALTER TABLE article ADD COLUMN completed_at TEXT')
    }
  },
  {
    version: 12,
    up: (database) => {
      // 学习指令是学习者自己保存的命名要求：名称、正文、创建与更新时间。
      // 独立表承载，不借 setting；六条内置示例只是界面里的只读常量，不写进这里，
      // 所以改名、复制、删除都只会动到用户自己的记录。
      database.exec(`
        CREATE TABLE learning_instruction (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          body       TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX learning_instruction_updated
          ON learning_instruction (updated_at DESC, id DESC);
      `)
    }
  },
  {
    version: 13,
    up: (database) => {
      // 生成文章要记录来源与来源词：`source_type` 为 'ai' 的是保存下来的生成文章，
      // 旧文章与随包语料保持 NULL（读取时按真题处理，不在迁移里补写）。
      // `source_entry_ids` 是保存那一刻的来源词条 id JSON 数组；词条后来被删也不清，
      // 详情按当前词条读出显示名，读不到就显示已删除，不做级联。
      // 这是文章自己的来源元数据，不是线程主对象类型（主对象仍是 none|entry|sentence|article）。
      database.exec(`
        ALTER TABLE article ADD COLUMN source_type TEXT;
        ALTER TABLE article ADD COLUMN source_entry_ids TEXT;
      `)
    }
  },
  {
    version: 14,
    up: (database) => {
      // 模型服务 v2：provider 与它的模型目录分开存，一个 provider 可以有多个模型。
      // 旧的 model_profile 不删：它是回滚副本，迁移后只读，运行时不再写入。
      // 每条旧配置复制成一个 custom + openai-completions provider，密钥密文原样保留，
      // 使用中的旧配置换成使用中的 provider（键写进 chat.activeProviderId）。
      database.exec(`
        CREATE TABLE model_provider (
          id                TEXT PRIMARY KEY,
          provider_key      TEXT NOT NULL UNIQUE,
          display_name      TEXT NOT NULL,
          protocol          TEXT NOT NULL,
          base_url          TEXT,
          auth_mode         TEXT NOT NULL,
          env_var           TEXT,
          secret_ciphertext TEXT,
          retry_policy      TEXT NOT NULL DEFAULT '{"mode":"normal"}',
          verification      TEXT NOT NULL DEFAULT 'unverified',
          last_error        TEXT,
          last_checked_at   TEXT,
          last_verified_at  TEXT,
          source            TEXT NOT NULL,
          -- 内置目录身份：Provider ID 可以因同厂商多套而变成 deepseek-2，
          -- 这一列始终指向目录里的入口（如 deepseek），迁移来的 custom 为 NULL。
          catalog_provider_id TEXT,
          default_model_id  TEXT,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );

        CREATE INDEX model_provider_created ON model_provider (created_at);

        CREATE TABLE model_provider_model (
          id             TEXT PRIMARY KEY,
          provider_id    TEXT NOT NULL REFERENCES model_provider(id) ON DELETE CASCADE,
          model_id       TEXT NOT NULL,
          display_name   TEXT NOT NULL,
          api            TEXT NOT NULL,
          base_url       TEXT,
          context_window INTEGER,
          max_tokens     INTEGER,
          input          TEXT NOT NULL DEFAULT 'text',
          reasoning      INTEGER NOT NULL DEFAULT 0,
          -- 目录描述符里的思考档位映射与兼容开关：请求时要用它们决定
          -- high 是否可用，以及思考字段按 DeepSeek / Kimi / ZAI 哪种格式发。
          thinking_level_map TEXT,
          compat             TEXT,
          source         TEXT NOT NULL,
          sort           INTEGER NOT NULL DEFAULT 0,
          created_at     TEXT NOT NULL,
          updated_at     TEXT NOT NULL,
          UNIQUE (provider_id, model_id)
        );

        CREATE INDEX model_provider_model_order
          ON model_provider_model (provider_id, sort);
      `)

      const profiles = database
        .prepare(
          `SELECT id, name, base_url, model, api_key_secret, verification, last_error,
                  last_checked_at, last_verified_at, created_at, updated_at
             FROM model_profile ORDER BY created_at, rowid`
        )
        .all() as {
        id: string
        name: string
        base_url: string
        model: string
        api_key_secret: string | null
        verification: string
        last_error: string | null
        last_checked_at: string | null
        last_verified_at: string | null
        created_at: string
        updated_at: string
      }[]

      const usedKeys = new Set<string>()
      const insertProvider = database.prepare(
        `INSERT INTO model_provider (
           id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
           secret_ciphertext, retry_policy, verification, last_error, last_checked_at,
           last_verified_at, source, default_model_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'openai-completions', ?, 'stored', NULL, ?, ?, ?, ?, ?, ?,
                   'custom', ?, ?, ?)`
      )
      const insertModel = database.prepare(
        `INSERT INTO model_provider_model (
           id, provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
           input, reasoning, source, sort, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'openai-completions', NULL, NULL, NULL, 'text', 0, 'manual', 0,
                   ?, ?)`
      )

      for (const profile of profiles) {
        try {
          const providerKey = deriveProviderKey(profile.name, profile.base_url, usedKeys)
          usedKeys.add(providerKey)
          const modelId = randomUUID()
          insertProvider.run(
            profile.id,
            providerKey,
            profile.name,
            profile.base_url,
            profile.api_key_secret,
            '{"mode":"normal"}',
            profile.verification === 'verified' ? 'verified' : 'unverified',
            profile.last_error,
            profile.last_checked_at,
            profile.last_verified_at,
            modelId,
            profile.created_at,
            profile.updated_at
          )
          insertModel.run(
            modelId,
            profile.id,
            profile.model,
            profile.model,
            profile.created_at,
            profile.updated_at
          )
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          throw new Error(`迁移模型配置「${profile.name}」（${profile.id}）失败：${detail}`)
        }
      }

      // 原使用中的 profile 继续是使用中的 provider；旧键只迁这一次，之后不再读写。
      const legacyActive = database
        .prepare(`SELECT value FROM setting WHERE key = 'chat.activeProfileId'`)
        .get() as { value: string } | undefined
      const activeId = legacyActive?.value.trim() ?? ''
      if (activeId !== '' && profiles.some((profile) => profile.id === activeId)) {
        database
          .prepare(
            `INSERT INTO setting (key, value, updated_at)
             VALUES ('chat.activeProviderId', ?, datetime('now'))
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
          )
          .run(activeId)
      }
      database.prepare(`DELETE FROM setting WHERE key = 'chat.activeProfileId'`).run()
    }
  }
]

function latestVersion(plan: readonly Migration[]): number {
  return plan.reduce((latest, migration) => Math.max(latest, migration.version), 0)
}

/** 迁移失败时带上目标版本：界面直接显示这句话就够说明发生了什么。 */
export class MigrationFailedError extends Error {
  readonly version: number

  constructor(version: number, detail: string) {
    super(`数据库升级到版本 ${version} 失败：${detail}`)
    this.name = 'MigrationFailedError'
    this.version = version
  }
}

export const LATEST_SCHEMA_VERSION = latestVersion(migrations)

export type MigrationOutcome = {
  from: number
  to: number
  applied: readonly number[]
}

export class SchemaTooNewError extends Error {
  readonly databaseVersion: number
  readonly supportedVersion: number

  constructor(databaseVersion: number, supportedVersion: number) {
    super(
      `本机资料库的 schema 版本是 ${databaseVersion}，高于本程序支持的 ${supportedVersion}`
    )
    this.name = 'SchemaTooNewError'
    this.databaseVersion = databaseVersion
    this.supportedVersion = supportedVersion
  }
}

export function readSchemaVersion(database: AppDatabase): number {
  return database.pragma('user_version', { simple: true }) as number
}

/**
 * 把所有待应用的迁移放在一笔事务里：任何一步失败都整体回滚，版本不前进。
 */
export function migrate(
  database: AppDatabase,
  options: { migrations?: readonly Migration[] } = {}
): MigrationOutcome {
  const plan = options.migrations ?? migrations
  const from = readSchemaVersion(database)
  const supportedVersion = latestVersion(plan)

  if (from > supportedVersion) {
    throw new SchemaTooNewError(from, supportedVersion)
  }

  const pending = plan.filter((migration) => migration.version > from)
  if (pending.length === 0) {
    return { from, to: from, applied: [] }
  }

  const applyPending = database.transaction(() => {
    for (const migration of pending) {
      try {
        migration.up(database)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new MigrationFailedError(migration.version, detail)
      }
      database.pragma(`user_version = ${migration.version}`)
    }
  })
  applyPending()

  return {
    from,
    to: pending[pending.length - 1].version,
    applied: pending.map((migration) => migration.version)
  }
}
