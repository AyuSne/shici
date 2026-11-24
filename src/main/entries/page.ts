import type {
  EntryListItem,
  EntryListRequest,
  EntryListResult,
  EntryPage,
  EntrySearchHit,
  EntrySentence,
  EntrySentenceGroup
} from '../../shared/entries'
import type { HomeEntryChip, HomeArticleEntry } from '../../shared/library'
import { buildSearchSnippet } from '../../shared/search'
import type { AppDatabase } from '../db/database'
import type { Dictionary } from '../dictionary/dictionary'
import { resolveEntryKey } from './key'
import { readLearningNotes } from './notes'
import {
  ENTRY_SENTENCE_COLUMNS,
  ENTRY_SENTENCE_JOINS,
  readEntrySummary,
  toEntrySentence,
  type EntrySentenceRow
} from './queries'

/**
 * 词条页的读模型：左栏列表与中/右栏的一整页。
 * 列表只给计数，打开某个词条时再取按文章分组的原句与学习内容。
 */

type EntryListRow = {
  id: string
  main_form: string
  last_collected_at: string
  sentence_count: number
  article_count: number
  note_count: number
}

type EntrySentenceHitRow = {
  entry_id: string
  id: string
  text: string
}

type EntryNoteHitRow = {
  entry_id: string
  id: string
  body: string
}

/**
 * 词条列表与首页「最近收集」共用同一份列：计数口径只有一处，
 * 首页不必再拼一套 SQL，也就不会和词条页漂移。
 */
export const ENTRY_LIST_COLUMNS = `we.id, we.main_form, we.last_collected_at,
  (SELECT COUNT(*) FROM entry_sentence es WHERE es.entry_id = we.id) AS sentence_count,
  (SELECT COUNT(DISTINCT es.article_id) FROM entry_sentence es
    WHERE es.entry_id = we.id) AS article_count,
  (SELECT COUNT(*) FROM learning_note ln WHERE ln.entry_id = we.id) AS note_count`

function toEntryListItem(row: EntryListRow): EntryListItem {
  return {
    id: row.id,
    mainForm: row.main_form,
    sentenceCount: row.sentence_count,
    articleCount: row.article_count,
    noteCount: row.note_count,
    lastCollectedAt: row.last_collected_at
  }
}

/** 首页最多摆几个词条 chip；再多就交给词条页。 */
export const HOME_RECENT_ENTRY_LIMIT = 8

/** 首页「继续阅读」卡片底部最多速览几个本篇词条。 */
export const HOME_ARTICLE_ENTRY_LIMIT = 4

/**
 * 首页「最近收集」：只数真实收下的词条（至少一条原句），排序与词条列表默认一致，
 * 最近收词的排前面；上限固定，稍后看标记与钉住都不参与。
 */
export function readRecentEntryChips(
  database: AppDatabase,
  limit: number = HOME_RECENT_ENTRY_LIMIT
): HomeEntryChip[] {
  const rows = database
    .prepare(
      `SELECT ${ENTRY_LIST_COLUMNS}
         FROM word_entry we
        WHERE EXISTS (SELECT 1 FROM entry_sentence es WHERE es.entry_id = we.id)
        ORDER BY we.last_collected_at DESC, we.id DESC
        LIMIT ?`
    )
    .all(limit) as EntryListRow[]

  return rows.map((row) => {
    const { id, mainForm, sentenceCount, articleCount, lastCollectedAt } = toEntryListItem(row)
    return { id, mainForm, sentenceCount, articleCount, lastCollectedAt }
  })
}

/**
 * 首页「继续阅读」的本篇速览：只看这一篇的 entry_sentence，按词条在本篇最近一次
 * 收词时间倒序；同一词条在本篇收过多句也只出现一次。
 */
export function readArticleEntryChips(
  database: AppDatabase,
  articleId: string,
  limit: number = HOME_ARTICLE_ENTRY_LIMIT
): HomeArticleEntry[] {
  const rows = database
    .prepare(
      `SELECT we.id AS entry_id, we.main_form AS main_form, MAX(es.collected_at) AS last_at
         FROM word_entry we
         JOIN entry_sentence es ON es.entry_id = we.id
        WHERE es.article_id = ?
        GROUP BY we.id
        ORDER BY last_at DESC, we.id DESC
        LIMIT ?`
    )
    .all(articleId, limit) as { entry_id: string; main_form: string }[]

  return rows.map((row) => ({ entryId: row.entry_id, mainForm: row.main_form }))
}

/**
 * 一次批量读出，不按词条逐条查；片段与高亮区间都交给 shared/search.ts，界面只按区间切。
 */
function readEntryHits(
  database: AppDatabase,
  rows: readonly EntryListRow[],
  pattern: string
): Map<string, EntrySearchHit> {
  const wanted = new Set(rows.map((row) => row.id))
  const sentenceRows = database
    .prepare(
      `SELECT es.entry_id, es.id, s.text
         FROM entry_sentence es
         JOIN sentence s
           ON s.article_id = es.article_id
          AND s.paragraph_id = es.paragraph_id
          AND s.ordinal = es.sentence_ordinal
        WHERE instr(lower(s.text), ?) > 0
        ORDER BY es.collected_at DESC, es.id DESC`
    )
    .all(pattern) as EntrySentenceHitRow[]
  const firstSentence = new Map<string, EntrySentenceHitRow>()
  for (const row of sentenceRows) {
    if (wanted.has(row.entry_id) && !firstSentence.has(row.entry_id)) {
      firstSentence.set(row.entry_id, row)
    }
  }

  const noteRows = database
    .prepare(
      `SELECT ln.entry_id, ln.id, ln.body
         FROM learning_note ln
        WHERE instr(lower(ln.body), ?) > 0
        ORDER BY ln.pinned DESC, ln.created_at DESC, ln.id DESC`
    )
    .all(pattern) as EntryNoteHitRow[]
  const firstNote = new Map<string, EntryNoteHitRow>()
  for (const row of noteRows) {
    if (wanted.has(row.entry_id) && !firstNote.has(row.entry_id)) {
      firstNote.set(row.entry_id, row)
    }
  }

  const hits = new Map<string, EntrySearchHit>()
  for (const row of rows) {
    if (row.main_form.toLowerCase().includes(pattern)) {
      hits.set(row.id, {
        match: 'main-form',
        snippet: buildSearchSnippet(row.main_form, pattern),
        entryId: row.id
      })
      continue
    }
    const sentence = firstSentence.get(row.id)
    if (sentence) {
      hits.set(row.id, {
        match: 'sentence',
        snippet: buildSearchSnippet(sentence.text, pattern),
        entryId: row.id,
        entrySentenceId: sentence.id
      })
      continue
    }
    const note = firstNote.get(row.id)
    if (note) {
      hits.set(row.id, {
        match: 'learning-note',
        snippet: buildSearchSnippet(note.body, pattern),
        entryId: row.id,
        noteId: note.id
      })
    }
  }
  return hits
}

/**
 * 左栏列表。搜索匹配主词形、已收原句正文与学习内容正文；每条命中的词条带回
 * 命中类型、高亮片段与定位 id。`total` 始终是库里的词条总数，搜索与筛选只改 `entries`。
 */
export function readEntryList(
  database: AppDatabase,
  request: EntryListRequest = {}
): EntryListResult {
  const query = (request.query ?? '').trim().toLowerCase()
  const sort = request.sort === 'alpha' ? 'alpha' : 'recent'
  const filter = request.filter ?? 'all'

  const rows = database
    .prepare(
      `SELECT ${ENTRY_LIST_COLUMNS}
         FROM word_entry we
        WHERE ? = ''
           OR instr(lower(we.main_form), ?) > 0
           OR EXISTS (
                SELECT 1 FROM entry_sentence es
                  JOIN sentence s
                    ON s.article_id = es.article_id
                   AND s.paragraph_id = es.paragraph_id
                   AND s.ordinal = es.sentence_ordinal
                 WHERE es.entry_id = we.id AND instr(lower(s.text), ?) > 0
              )
           OR EXISTS (
                SELECT 1 FROM learning_note ln
                 WHERE ln.entry_id = we.id AND instr(lower(ln.body), ?) > 0
              )
        ORDER BY ${
          sort === 'alpha'
            ? 'lower(we.main_form) ASC, we.id ASC'
            : 'we.last_collected_at DESC, we.id DESC'
        }`
    )
    .all(query, query, query, query) as EntryListRow[]

  const total = (database.prepare('SELECT COUNT(*) AS count FROM word_entry').get() as {
    count: number
  }).count

  const matched = rows.filter((row) => {
    if (filter === 'has-notes') return row.note_count > 0
    if (filter === 'no-notes') return row.note_count === 0
    return true
  })
  const entries: EntryListItem[] = matched.map(toEntryListItem)
  if (query !== '') {
    const hits = readEntryHits(database, matched, query)
    for (const entry of entries) {
      const hit = hits.get(entry.id)
      if (hit !== undefined) entry.hit = hit
    }
  }

  return { total, entries }
}

/** 组内按段序、句序排；组与组之间按这一组最新收集的时间倒序。 */
function groupSentences(rows: readonly EntrySentenceRow[]): EntrySentenceGroup[] {
  const groups = new Map<string, EntrySentenceGroup>()
  for (const row of rows) {
    let group = groups.get(row.article_id)
    if (!group) {
      group = {
        articleId: row.article_id,
        articleTitle: row.article_title,
        sessionLabel: row.session_label,
        setLabel: row.set_label,
        latestCollectedAt: row.collected_at,
        sentences: []
      }
      groups.set(row.article_id, group)
    }
    group.sentences.push(toEntrySentence(row))
  }

  const ordered = [...groups.values()]
  for (const group of ordered) {
    group.sentences.sort(
      (left, right) =>
        left.paragraphOrdinal - right.paragraphOrdinal ||
        left.sentenceOrdinal - right.sentenceOrdinal ||
        left.start - right.start ||
        left.id.localeCompare(right.id)
    )
  }
  return ordered
}

/** 补上同一篇里的上一句 / 下一句，词条页可以就地展开前后文。 */
function withNeighbors(database: AppDatabase, sentences: EntrySentence[]): void {
  if (sentences.length === 0) return
  const articleIds = [...new Set(sentences.map((sentence) => sentence.articleId))]
  for (const articleId of articleIds) {
    const rows = database
      .prepare(
        `SELECT s.paragraph_id, s.ordinal, s.text
           FROM sentence s
           JOIN paragraph p ON p.article_id = s.article_id AND p.id = s.paragraph_id
          WHERE s.article_id = ?
          ORDER BY p.ordinal, s.ordinal`
      )
      .all(articleId) as { paragraph_id: string; ordinal: number; text: string }[]
    const positions = new Map(
      rows.map((row, position) => [`${row.paragraph_id}:${row.ordinal}`, position])
    )
    for (const sentence of sentences) {
      if (sentence.articleId !== articleId) continue
      const position = positions.get(
        `${sentence.paragraphId}:${sentence.sentenceOrdinal}`
      )
      if (position === undefined) continue
      sentence.previousSentence = rows[position - 1]?.text ?? null
      sentence.nextSentence = rows[position + 1]?.text ?? null
    }
  }
}

/** 词条页的一整页；词条不存在时返回 null。 */
export function readEntryPage(
  database: AppDatabase,
  entryId: string,
  options: { dictionary?: Dictionary } = {}
): EntryPage | null {
  const entry = readEntrySummary(database, entryId)
  if (!entry) {
    return null
  }

  const rows = database
    .prepare(
      `SELECT ${ENTRY_SENTENCE_COLUMNS}
         FROM entry_sentence es
         ${ENTRY_SENTENCE_JOINS}
        WHERE es.entry_id = ?
        ORDER BY es.collected_at DESC, es.id DESC`
    )
    .all(entryId) as EntrySentenceRow[]

  const groups = groupSentences(rows)
  const sentences = groups.flatMap((group) => group.sentences)
  withNeighbors(database, sentences)

  // 已经属于本词条词形的原句不能再「拆到新词条」；换主词形后键没跟上的情况也不让拆。
  const storedKey = database
    .prepare('SELECT normalized_key FROM word_entry WHERE id = ?')
    .get(entryId) as { normalized_key: string } | undefined
  for (const sentence of sentences) {
    sentence.canSplitToNew =
      storedKey !== undefined &&
      resolveEntryKey(database, sentence.surface, options.dictionary) !==
        storedKey.normalized_key
  }

  return { entry, groups, notes: readLearningNotes(database, entryId) }
}
