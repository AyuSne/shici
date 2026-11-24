import type {
  ReadingGlobalPreferences,
  ReadingGlobalPreferencesResult
} from '../../shared/reading'
import {
  DEFAULT_READING_GLOBAL_PREFERENCES,
  isMarginNoteMode
} from '../../shared/reading'
import type { AppDatabase } from '../db/database'
import { readSetting, writeSetting } from '../db/settings'

/**
 * 不分篇的阅读偏好。全部落在 setting 表：静默圈词、页边眉批与轻遮重读
 * 都不该产生按篇覆盖，也不该给 article_reading_setting 加列。
 *
 * 键名与取值是跨版本契约：布尔只用 '1' / '0'，眉批只用 all / mine / hidden；
 * 不认识的值逐项回落产品默认，不猜、不写坏数据。
 */
const SETTING_KEYS = {
  silentCollection: 'reading.silentCollection',
  marginNoteMode: 'reading.marginNotes',
  lightMask: 'reading.lightMask'
} as const

function parseBooleanSetting(value: string | null, fallback: boolean): boolean {
  if (value === '1' || value === 'true') {
    return true
  }
  if (value === '0' || value === 'false') {
    return false
  }
  return fallback
}

export function readReadingGlobalPreferences(
  database: AppDatabase
): ReadingGlobalPreferences {
  const storedMargin = readSetting(database, SETTING_KEYS.marginNoteMode)
  return {
    silentCollection: parseBooleanSetting(
      readSetting(database, SETTING_KEYS.silentCollection),
      DEFAULT_READING_GLOBAL_PREFERENCES.silentCollection
    ),
    marginNoteMode: isMarginNoteMode(storedMargin)
      ? storedMargin
      : DEFAULT_READING_GLOBAL_PREFERENCES.marginNoteMode,
    lightMask: parseBooleanSetting(
      readSetting(database, SETTING_KEYS.lightMask),
      DEFAULT_READING_GLOBAL_PREFERENCES.lightMask
    )
  }
}

function isReadingGlobalPreferences(
  value: ReadingGlobalPreferences
): value is ReadingGlobalPreferences {
  return (
    typeof value.silentCollection === 'boolean' &&
    isMarginNoteMode(value.marginNoteMode) &&
    typeof value.lightMask === 'boolean'
  )
}

/** 保存整份全局偏好；任一项不合法就整份不写，带回当前生效值。 */
export function saveReadingGlobalPreferences(
  database: AppDatabase,
  preferences: ReadingGlobalPreferences
): ReadingGlobalPreferencesResult {
  if (!isReadingGlobalPreferences(preferences)) {
    return { saved: false, preferences: readReadingGlobalPreferences(database) }
  }

  database.transaction(() => {
    writeSetting(
      database,
      SETTING_KEYS.silentCollection,
      preferences.silentCollection ? '1' : '0'
    )
    writeSetting(database, SETTING_KEYS.marginNoteMode, preferences.marginNoteMode)
    writeSetting(database, SETTING_KEYS.lightMask, preferences.lightMask ? '1' : '0')
  })()

  return { saved: true, preferences: readReadingGlobalPreferences(database) }
}
