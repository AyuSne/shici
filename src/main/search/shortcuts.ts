import type { SearchShortcuts } from '../../shared/global-search'
import {
  SEARCH_SHORTCUT_ARTICLE_LIMIT,
  SEARCH_SHORTCUT_ENTRY_LIMIT
} from '../../shared/global-search'
import type { AppDatabase } from '../db/database'
import { readRecentEntryChips } from '../entries/page'
import { readRecentlyOpenedArticles } from '../library/queries'

/**
 * 全局搜索框为空时的「最近」：最近打开的文章与最近收集的词条。
 * 两组都复用页面自己的读模型，不在搜索里另拼一套计数或排序。
 */
export function readSearchShortcuts(database: AppDatabase): SearchShortcuts {
  return {
    recentArticles: readRecentlyOpenedArticles(
      database,
      SEARCH_SHORTCUT_ARTICLE_LIMIT
    ),
    recentEntries: readRecentEntryChips(database, SEARCH_SHORTCUT_ENTRY_LIMIT)
  }
}
