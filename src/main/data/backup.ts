import { randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type { BackupKind, BackupSummary, RestoreRejection } from '../../shared/settings'
import type { AppDatabase } from '../db/database'
import { openDatabase } from '../db/database'
import {
  LATEST_SCHEMA_VERSION,
  migrate,
  readSchemaVersion
} from '../db/migrations'
import { readSetting, writeSetting } from '../db/settings'
import { fileStamp } from '../file-stamp'

/**
 * 备份、恢复与恢复前快照：都落成独立的 SQLite 文件。
 * 备份文件里不带密钥，恢复时整体替换本机资料库。
 */

const BACKUP_SETTING_KEY = 'backup.last'
const SNAPSHOT_SETTING_KEY = 'backup.last-snapshot'
/**
 * 备份与快照都放在本机资料库目录下的这两个子目录里。
 * 备份是给用户带走的整库副本，快照只留在本机、用来回退。
 */
const BACKUP_DIRECTORY_NAME = 'backups'
const SNAPSHOT_DIRECTORY_NAME = 'snapshots'

export function backupDirectoryOf(dataDirectory: string): string {
  return join(dataDirectory, BACKUP_DIRECTORY_NAME)
}

export function snapshotDirectoryOf(dataDirectory: string): string {
  return join(dataDirectory, SNAPSHOT_DIRECTORY_NAME)
}

/** 备份目标就是正在用的库文件时不能动手：那等于把库覆盖掉。 */
export class BackupTargetError extends Error {
  constructor() {
    super('备份不能写到本机资料库文件本身')
    this.name = 'BackupTargetError'
  }
}

function summaryOf(
  file: string,
  input: { at: string; bytes: number; kind: BackupKind }
): BackupSummary {
  return {
    at: input.at,
    file,
    bytes: input.bytes,
    kind: input.kind,
    exists: true
  }
}

function removeSidecars(file: string): void {
  rmSync(`${file}-wal`, { force: true })
  rmSync(`${file}-shm`, { force: true })
}

/**
 * 写一份能单独拿走或回退的副本：先在线备份到同目录的临时文件。
 * 手动备份要把密钥清空——清空之后必须 VACUUM 重建文件，否则旧密钥还留在空闲页里，
 * 扫文件就能捞出来。恢复前快照只留在本机，保留本机加密的密钥，回退时才能完好如初。
 */
async function writeCopy(
  database: AppDatabase,
  destination: string,
  options: { stripSecrets: boolean }
): Promise<number> {
  mkdirSync(dirname(destination), { recursive: true })
  const partial = join(
    dirname(destination),
    `.${basename(destination)}.${randomUUID()}.partial`
  )
  try {
    await database.backup(partial)
    const copy = openDatabase(partial)
    try {
      if (options.stripSecrets) {
        copy.exec(`
          UPDATE model_profile
             SET api_key_secret = NULL,
                 verification = 'unverified',
                 last_error = NULL,
                 last_checked_at = NULL,
                 last_verified_at = NULL
        `)
        // v14 的 provider 密文同样不进备份；环境变量模式的引用保留，
        // 存本机的配置没了密钥就不能再自称「已验证」。
        copy.exec(`
          UPDATE model_provider
             SET secret_ciphertext = NULL;
          UPDATE model_provider
             SET verification = 'unverified',
                 last_error = NULL,
                 last_checked_at = NULL,
                 last_verified_at = NULL
           WHERE auth_mode = 'stored';
        `)
        copy.exec('VACUUM')
      }
      // 副本不该依赖 -wal / -shm：换成回滚日志，单文件即可打开。
      copy.pragma('journal_mode = DELETE')
    } finally {
      copy.close()
    }
    removeSidecars(partial)
    rmSync(destination, { force: true })
    removeSidecars(destination)
    renameSync(partial, destination)
    return statSync(destination).size
  } catch (error) {
    rmSync(partial, { force: true })
    removeSidecars(partial)
    throw error
  }
}

function isLiveDatabase(database: AppDatabase, file: string): boolean {
  return database.name !== ':memory:' && resolve(database.name) === resolve(file)
}

type StoredBackup = Omit<BackupSummary, 'exists'>

/** 库里只存「上次备份是哪一份」，文件还在不在每次现问文件系统。 */
function readStoredBackup(database: AppDatabase, key: string): StoredBackup | null {
  const raw = readSetting(database, key)
  if (raw === null) {
    return null
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const record = value as Record<string, unknown>
    const kind = record.kind
    if (
      typeof record.at !== 'string' ||
      typeof record.file !== 'string' ||
      typeof record.bytes !== 'number' ||
      (kind !== 'manual' && kind !== 'before-restore')
    ) {
      return null
    }
    return { at: record.at, file: record.file, bytes: record.bytes, kind }
  } catch {
    return null
  }
}

function present(summary: StoredBackup | null): BackupSummary | null {
  return summary === null ? null : { ...summary, exists: existsSync(summary.file) }
}

function storeBackup(
  database: AppDatabase,
  key: string,
  summary: StoredBackup
): void {
  writeSetting(
    database,
    key,
    JSON.stringify({
      at: summary.at,
      file: summary.file,
      bytes: summary.bytes,
      kind: summary.kind
    })
  )
}

export function readLastBackup(database: AppDatabase): BackupSummary | null {
  return present(readStoredBackup(database, BACKUP_SETTING_KEY))
}

export async function createBackup(
  database: AppDatabase,
  options: { file: string; now: string }
): Promise<BackupSummary> {
  const file = resolve(options.file)
  if (isLiveDatabase(database, file)) {
    throw new BackupTargetError()
  }
  const bytes = await writeCopy(database, file, { stripSecrets: true })
  const summary = summaryOf(file, { at: options.now, bytes, kind: 'manual' })
  storeBackup(database, BACKUP_SETTING_KEY, summary)
  return summary
}

/* ---------- 恢复 ---------- */

export type RestoreInspection =
  | { ok: true; schemaVersion: number; bytes: number; createdAt: string }
  | { ok: false; reason: RestoreRejection }

export type RestoreOutcome =
  | { status: 'restored'; snapshot: BackupSummary }
  | { status: 'rejected'; reason: RestoreRejection }
  /** `rolledBack` 为 false 时连快照都没换回来，库可能停在中间状态。 */
  | { status: 'failed'; snapshot: BackupSummary | null; rolledBack: boolean }

/** 把候选文件连同它的 -wal / -shm 一起复制到临时目录：数据库如果是 WAL 模式，单拷主文件会读到旧内容。 */
function copyCandidate(
  source: string,
  tempDirectory: string
): { file: string; cleanup: () => void } {
  const file = join(tempDirectory, `candidate-${randomUUID()}.db`)
  copyFileSync(source, file)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(`${source}${suffix}`)) {
      copyFileSync(`${source}${suffix}`, `${file}${suffix}`)
    }
  }
  return {
    file,
    cleanup: () => {
      rmSync(file, { force: true })
      removeSidecars(file)
    }
  }
}

function hasTable(database: AppDatabase, name: string): boolean {
  return (
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  )
}

/**
 * 各版本该有的表。只看 `setting` 一张表不够：一个版本号写成本程序、
 * 表却不齐的文件照样会被恢复成一堆读不出来的表。
 */
const TABLES_BY_VERSION: readonly { version: number; tables: readonly string[] }[] = [
  { version: 1, tables: ['setting'] },
  { version: 2, tables: ['article', 'paragraph', 'sentence', 'annotation'] },
  { version: 3, tables: ['article_reading_setting'] },
  { version: 4, tables: ['word_entry', 'entry_sentence'] },
  { version: 5, tables: ['learning_note'] },
  { version: 6, tables: ['thread', 'thread_entry'] },
  { version: 7, tables: ['pin'] },
  { version: 8, tables: ['model_profile'] },
  { version: 10, tables: ['entry_later'] },
  { version: 14, tables: ['model_provider', 'model_provider_model'] }
]

/**
 * 各版本该有的新列。只查表不够：版本号写着 11、表也齐、但文章表没有
 * `completed_at` 的文件，恢复进来会让「已读完」的读取直接报错。
 */
const COLUMNS_BY_VERSION: readonly {
  version: number
  table: string
  columns: readonly string[]
}[] = [
  { version: 11, table: 'article', columns: ['completed_at'] },
  // v14 的 provider 与模型目录缺列时，恢复进来连只读卡片都读不出来。
  {
    version: 14,
    table: 'model_provider',
    columns: [
      'provider_key',
      'secret_ciphertext',
      'default_model_id',
      'protocol',
      'catalog_provider_id'
    ]
  },
  {
    version: 14,
    table: 'model_provider_model',
    columns: ['provider_id', 'model_id', 'api', 'sort', 'thinking_level_map', 'compat']
  }
]

function tableColumns(database: AppDatabase, table: string): Set<string> {
  const columns = database.pragma(`table_info(${table})`) as { name: string }[]
  return new Set(columns.map((column) => column.name))
}

function isLibraryDatabase(database: AppDatabase, schemaVersion: number): boolean {
  return (
    TABLES_BY_VERSION.filter((entry) => entry.version <= schemaVersion).every((entry) =>
      entry.tables.every((table) => hasTable(database, table))
    ) &&
    COLUMNS_BY_VERSION.filter((entry) => entry.version <= schemaVersion).every((entry) => {
      const present = tableColumns(database, entry.table)
      return entry.columns.every((column) => present.has(column))
    })
  )
}

/**
 * 看一眼这份文件能不能当备份用：是不是 SQLite、是不是本程序的库、版本是否高于当前程序。
 * 检查在临时副本上做，不动原文件。
 */
export function inspectBackupFile(
  file: string,
  options: { tempDirectory?: string } = {}
): RestoreInspection {
  const source = resolve(file)
  if (!existsSync(source)) {
    return { ok: false, reason: 'missing' }
  }

  const ownsDirectory = options.tempDirectory === undefined
  const directory =
    options.tempDirectory ?? mkdtempSync(join(tmpdir(), 'english-learning-inspect-'))
  const cleanupDirectory = (): void => {
    if (ownsDirectory) {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  let candidate: { file: string; cleanup: () => void }
  try {
    candidate = copyCandidate(source, directory)
  } catch {
    // 读不了的东西（目录、被占用、没权限）不是备份，也不该把异常抛给界面。
    cleanupDirectory()
    return { ok: false, reason: 'not-a-database' }
  }

  let copy: AppDatabase | null = null
  try {
    // 坏文件的报错会晚到第一条语句：打开成功不代表是数据库，句柄得由这里兜住关闭。
    copy = new Database(candidate.file)
    let integrity: unknown
    try {
      integrity = copy.pragma('integrity_check', { simple: true })
    } catch {
      return { ok: false, reason: 'not-a-database' }
    }
    if (integrity !== 'ok') {
      return { ok: false, reason: 'damaged' }
    }
    const schemaVersion = readSchemaVersion(copy)
    // 更新的版本我们读不懂它的表结构，先按版本拒绝，别用旧表清单去猜。
    if (schemaVersion > LATEST_SCHEMA_VERSION) {
      return { ok: false, reason: 'too-new' }
    }
    if (schemaVersion < 1 || !isLibraryDatabase(copy, schemaVersion)) {
      return { ok: false, reason: 'not-a-library' }
    }
    const stats = statSync(source)
    return {
      ok: true,
      schemaVersion,
      bytes: stats.size,
      createdAt: stats.mtime.toISOString()
    }
  } catch {
    return { ok: false, reason: 'not-a-database' }
  } finally {
    copy?.close()
    candidate.cleanup()
    cleanupDirectory()
  }
}

/**
 * 把一份文件的内容整体灌进正在用的连接。走 SQLite 的在线备份接口：
 * 连接不用关，灌完之后同一个连接立即读到新内容，WAL 与预编译语句都还在。
 */
async function replaceWithFile(
  database: AppDatabase,
  source: string,
  tempDirectory: string | undefined
): Promise<void> {
  const ownsDirectory = tempDirectory === undefined
  const directory =
    tempDirectory ?? mkdtempSync(join(tmpdir(), 'english-learning-restore-'))
  const candidate = copyCandidate(resolve(source), directory)
  try {
    const from = new Database(candidate.file)
    try {
      await from.backup(resolve(database.name))
    } finally {
      from.close()
    }
    // 整库换页后，这个连接里可能还留着换页前的表定义；先重新读一次 schema，
    // 让调用方随后的迁移按恢复进来的版本判断（否则「加列」会被旧定义当成重复列）。
    database.prepare('SELECT COUNT(*) AS tables FROM sqlite_master').get()
  } finally {
    candidate.cleanup()
    if (ownsDirectory) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

function stampOf(iso: string): string {
  return fileStamp(new Date(iso))
}

/** 快照文件名按时间排；同一秒里再恢复一次也不覆盖上一份。 */
function nextSnapshotFile(directory: string, now: string): string {
  mkdirSync(directory, { recursive: true })
  const base = `english-learning-before-restore-${stampOf(now)}`
  let file = join(directory, `${base}.db`)
  for (let index = 2; existsSync(file); index += 1) {
    file = join(directory, `${base}-${index}.db`)
  }
  return file
}

function rememberSnapshot(database: AppDatabase, summary: BackupSummary): void {
  storeBackup(database, SNAPSHOT_SETTING_KEY, summary)
}

export function readLastSnapshot(database: AppDatabase): BackupSummary | null {
  return present(readStoredBackup(database, SNAPSHOT_SETTING_KEY))
}

/**
 * 恢复 = 先用在线备份留一份当前快照，再把备份文件整体灌进本机库。
 * 灌进去之后如果版本比当前程序旧，就地升级；升级失败就退回快照。
 */
export async function restoreBackup(
  database: AppDatabase,
  options: {
    file: string
    snapshotDirectory: string
    now: string
    tempDirectory?: string
  }
): Promise<RestoreOutcome> {
  const file = resolve(options.file)
  if (isLiveDatabase(database, file)) {
    return { status: 'rejected', reason: 'same-file' }
  }

  const inspection = inspectBackupFile(file, { tempDirectory: options.tempDirectory })
  if (!inspection.ok) {
    return { status: 'rejected', reason: inspection.reason }
  }

  const snapshotFile = nextSnapshotFile(options.snapshotDirectory, options.now)
  let snapshot: BackupSummary
  try {
    // 快照只留在本机，是「恢复前的当前状态」：密钥也原样保留，回退时不用重填。
    const bytes = await writeCopy(database, snapshotFile, { stripSecrets: false })
    snapshot = summaryOf(snapshotFile, { at: options.now, bytes, kind: 'before-restore' })
  } catch {
    return { status: 'failed', snapshot: null, rolledBack: true }
  }

  try {
    await replaceWithFile(database, file, options.tempDirectory)
    if (inspection.schemaVersion < LATEST_SCHEMA_VERSION) {
      migrate(database)
    }
    // 刚用过的这份备份就是「上次备份」；恢复不该把卡片上的时间与体积抹掉。
    storeBackup(database, BACKUP_SETTING_KEY, {
      at: inspection.createdAt,
      file,
      bytes: inspection.bytes,
      kind: 'manual'
    })
    rememberSnapshot(database, snapshot)
    return { status: 'restored', snapshot }
  } catch {
    // 恢复失败时退回快照，恢复前的数据（含密钥）原样回来。
    let rolledBack = false
    try {
      await replaceWithFile(database, snapshot.file, options.tempDirectory)
      rememberSnapshot(database, snapshot)
      rolledBack = true
    } catch {
      // 回滚也失败：把失败状态如实交回界面，快照文件仍留在磁盘上。
    }
    return { status: 'failed', snapshot, rolledBack }
  }
}
