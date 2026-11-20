import type { ModelProviderSummary } from './model-providers'
import type { ReadingPreferences } from './reading'
import type { ThemePreference } from './types'

/**
 * 设置页的跨层类型。密钥明文只在主进程里出现：渲染层读到的永远只有掩码与来源状态。
 */

/** 设置页一次读到的全部本机设置。 */
export type SettingsOverview = {
  /** 只读的 provider 列表；名称、协议、模型、验证状态与「使用中」都在这里。 */
  providers: ModelProviderSummary[]
  activeProviderId: string | null
  /** 使用中 provider 的默认模型行 id；没有可用配置时为 null。 */
  defaultModelId: string | null
  /** 后续调用会用的模型名；没有本机配置时回退到环境变量里的那份，仍没有则为空。 */
  activeModel: string
  reading: ReadingPreferences
  theme: ThemePreference
  appVersion: string
  electronVersion: string
  dataDirectory: string
  /** 上次手动备份；没备份过为 null。 */
  lastBackup: BackupSummary | null
  /** 恢复前自动留下的那份快照；没恢复过为 null。 */
  lastSnapshot: BackupSummary | null
  backupDirectory: string
  snapshotDirectory: string
}

export type SaveThemeRequest = {
  theme: ThemePreference
}

export type SaveThemeResult = {
  saved: boolean
  theme: ThemePreference
}

export type OpenDataDirectoryResult = {
  opened: boolean
  path: string
}

/** 手动备份与恢复前自动快照：两者都是整库副本，区别只在谁来触发。 */
export type BackupKind = 'manual' | 'before-restore'

/** 一次备份落成的文件；`exists` 是读设置时按文件系统重新确认的。 */
export type BackupSummary = {
  at: string
  file: string
  bytes: number
  kind: BackupKind
  exists: boolean
}

/** 恢复被拒的原因，界面据此说清楚为什么不能换。 */
export type RestoreRejection =
  | 'missing'
  | 'not-a-database'
  | 'not-a-library'
  | 'too-new'
  | 'damaged'
  | 'same-file'

/** 备份没写成的原因；`same-file` 指目标正好是本机资料库。 */
export type BackupFailure = 'same-file' | 'unknown'

export type CreateBackupResult =
  | { status: 'saved'; backup: BackupSummary; overview: SettingsOverview }
  | { status: 'cancelled'; overview: SettingsOverview }
  | { status: 'failed'; reason: BackupFailure; overview: SettingsOverview }

/** 「从备份恢复」第一步：弹出文件选择，并先看清那个文件能不能用。 */
export type PickRestoreResult =
  | { status: 'picked'; file: string; schemaVersion: number; bytes: number; createdAt: string }
  | { status: 'cancelled' }
  | { status: 'rejected'; reason: RestoreRejection }

/** 第二步：确认后整体替换；失败时是否已经退回恢复前，由 rolledBack 说清。 */
export type RestoreBackupResult =
  | { status: 'restored'; snapshot: BackupSummary; overview: SettingsOverview }
  | { status: 'rejected'; reason: RestoreRejection; overview: SettingsOverview }
  | {
      status: 'failed'
      snapshot: BackupSummary | null
      rolledBack: boolean
      overview: SettingsOverview
    }
