import type { SettingsOverview } from '../../shared/settings'
import type { AppDatabase } from '../db/database'
import { readThemePreference } from '../db/settings'
import {
  backupDirectoryOf,
  readLastBackup,
  readLastSnapshot,
  snapshotDirectoryOf
} from '../data/backup'
import { readReadingPreferences } from '../reading/queries'
import {
  listModelProviders,
  readActiveProviderId,
  readDefaultModel,
  readModelProvider
} from './providers'
import type { SecretStore } from './secret-store'

export type OverviewOptions = {
  secrets: SecretStore
  /** 解析环境变量模式的密钥来源；默认进程环境。 */
  env: NodeJS.ProcessEnv
  /** 没有本机配置时，环境变量里的模型名仍是后续调用会用的那个。 */
  fallbackModel: string
  appVersion: string
  electronVersion: string
  dataDirectory: string
}

/** 设置页一次读到的全部值。只读：任何配置写入都要走单独的 provider 服务。 */
export function readSettingsOverview(
  database: AppDatabase,
  options: OverviewOptions
): SettingsOverview {
  const providers = listModelProviders(database, {
    secrets: options.secrets,
    env: options.env
  })
  const activeProviderId = readActiveProviderId(database)
  const activeProvider =
    activeProviderId === null ? null : readModelProvider(database, activeProviderId)
  const defaultModel =
    activeProvider === null ? null : readDefaultModel(database, activeProvider)
  return {
    providers,
    activeProviderId,
    defaultModelId: defaultModel?.id ?? null,
    activeModel: defaultModel?.modelId ?? options.fallbackModel,
    reading: readReadingPreferences(database),
    theme: readThemePreference(database),
    appVersion: options.appVersion,
    electronVersion: options.electronVersion,
    dataDirectory: options.dataDirectory,
    lastBackup: readLastBackup(database),
    lastSnapshot: readLastSnapshot(database),
    backupDirectory: backupDirectoryOf(options.dataDirectory),
    snapshotDirectory: snapshotDirectoryOf(options.dataDirectory)
  }
}
