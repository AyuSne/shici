import type {
  EntryLearningGlance,
  ReadingEncounter
} from '../../shared/entries'
import type { AppDatabase } from '../db/database'

/**
 * 阅读里随手能看的两样东西：词条的置顶学习内容摘要，以及一条来自别的文章的
 * 「故人重逢」原句。两个都是只读快照，不改任何学习数据。
 *
 * 阅读视图会一次问一串词条；这里按词条批量读，不按正文标记逐条查。
 */

/** 摘要截到一行能摆下的长度；超出用省略号收尾。 */
export const GLANCE_EXCERPT_LIMIT = 80

export function glanceExcerpt(body: string): string {
  const flat = body.replace(/\s+/gu, ' ').trim()
  return flat.length <= GLANCE_EXCERPT_LIMIT
    ? flat
    : `${flat.slice(0, GLANCE_EXCERPT_LIMIT)}…`
}

type PinnedRow = { entry_id: string; id: string; body: string }

type EncounterRow = {
  id: string
  entry_id: string
  article_id: string
  article_title: string
  paragraph_ordinal: number
  sentence_text: string
  surface: string
}

function emptyGlance(): EntryLearningGlance {
  return { pinnedNote: null, encounter: null }
}

/**
 * 一次读多个词条的 glance。`excludeArticleId` 用于把「本篇」排除在故人重逢之外；
 * 不传时按「最近收的一条原句」给（词条卡没有当前篇上下文时也能显示点什么）。
 * 每个请求的词条都会在结果里拿到一个对象，没有内容时两项为 null。
 */
export function readEntryGlances(
  database: AppDatabase,
  entryIds: readonly string[],
  options: { excludeArticleId?: string } = {}
): Map<string, EntryLearningGlance> {
  const unique = [...new Set(entryIds)]
  const glances = new Map<string, EntryLearningGlance>()
  for (const entryId of unique) {
    glances.set(entryId, emptyGlance())
  }
  if (unique.length === 0) {
    return glances
  }

  const placeholders = unique.map(() => '?').join(', ')
  const pinnedRows = database
    .prepare(
      `SELECT entry_id, id, body FROM learning_note
        WHERE pinned = 1 AND entry_id IN (${placeholders})
        ORDER BY updated_at DESC, id DESC`
    )
    .all(...unique) as PinnedRow[]
  for (const row of pinnedRows) {
    const glance = glances.get(row.entry_id)
    if (glance !== undefined && glance.pinnedNote === null) {
      glance.pinnedNote = { id: row.id, excerpt: glanceExcerpt(row.body) }
    }
  }

  const encounterStatement = database.prepare(
    `SELECT es.id, es.entry_id, es.article_id, a.title AS article_title,
            p.ordinal + 1 AS paragraph_ordinal, s.text AS sentence_text, es.surface
       FROM entry_sentence es
       JOIN article a ON a.id = es.article_id
       JOIN paragraph p
         ON p.article_id = es.article_id AND p.id = es.paragraph_id
       JOIN sentence s
         ON s.article_id = es.article_id
        AND s.paragraph_id = es.paragraph_id
        AND s.ordinal = es.sentence_ordinal
      WHERE es.entry_id = ?
        AND (? IS NULL OR es.article_id <> ?)
      ORDER BY es.collected_at DESC, es.id DESC
      LIMIT 1`
  )
  const exclude = options.excludeArticleId ?? null
  for (const entryId of unique) {
    const row = encounterStatement.get(entryId, exclude, exclude) as EncounterRow | undefined
    if (row === undefined) {
      continue
    }
    const encounter: ReadingEncounter = {
      entrySentenceId: row.id,
      articleId: row.article_id,
      articleTitle: row.article_title,
      paragraphOrdinal: row.paragraph_ordinal,
      sentenceText: row.sentence_text,
      surface: row.surface
    }
    const glance = glances.get(entryId)
    if (glance !== undefined) {
      glance.encounter = encounter
    }
  }

  return glances
}

/** 单个词条的 glance；词条不存在时返回 null，调用方按「已经不在了」处理。 */
export function readEntryGlance(
  database: AppDatabase,
  entryId: string,
  options: { excludeArticleId?: string } = {}
): EntryLearningGlance | null {
  const exists = database
    .prepare('SELECT 1 FROM word_entry WHERE id = ?')
    .get(entryId)
  if (exists === undefined) {
    return null
  }
  return readEntryGlances(database, [entryId], options).get(entryId) ?? emptyGlance()
}
