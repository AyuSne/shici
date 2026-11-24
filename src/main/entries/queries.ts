import { randomUUID } from 'node:crypto'
import type {
  CollectSelectionRequest,
  CollectSelectionResult,
  DeleteEntrySentenceResult,
  EntrySentence,
  EntrySentenceTarget,
  EntrySummary,
  ReadingCollectionMark,
  WordEntryCard
} from '../../shared/entries'
import type { ArticleKind } from '../../shared/library'
import type { AppDatabase } from '../db/database'
import type { Dictionary } from '../dictionary/dictionary'
import { reassignPinsFromEntry } from '../pins/pins'
import { paragraphLetter } from '../corpus/letter'
import { refreshLastCollected } from './entry-state'
import { resolveEntryKey } from './key'
import { readEntrySelection } from './selection'

/**
 * 选词的落点与词条卡。这一层只认本机库：选区由渲染层给“段 + 句 + 段内字符区间”，
 * 词形归并交给 key.ts（装了词典就用 ECDICT 的 lemma），重复圈选按“词条 + 篇 + 段 + 句”去重。
 */

type ArticleRow = { id: string }
type ParagraphRow = { text: string }
type SentenceRangeRow = { char_start: number; char_end: number }
type EntryRow = { id: string }
type StoredSentenceRow = {
  id: string
  entry_id: string
  article_id: string
  paragraph_id: string
  sentence_ordinal: number
  surface: string
  char_start: number
  char_end: number
  collected_at: string
}

type EntrySummaryRow = {
  id: string
  main_form: string
  last_collected_at: string
  later_marked_at: string | null
  sentence_count: number
  article_count: number
  note_count: number
}

export type EntrySentenceRow = {
  id: string
  surface: string
  article_id: string
  article_title: string
  article_kind: ArticleKind
  session_label: string
  set_label: string
  paragraph_id: string
  paragraph_ordinal: number
  sentence_ordinal: number
  sentence_text: string
  sentence_char_start: number
  char_start: number
  char_end: number
  sentence_page: number | null
  collected_at: string
}

/** 原句连同出处与句内位置，词条卡、词条页与重新圈定都从这里读同一套列。 */
export const ENTRY_SENTENCE_COLUMNS = `es.id, es.surface, es.article_id,
  a.title AS article_title, a.kind AS article_kind, a.session_label, a.set_label,
  es.paragraph_id, p.ordinal AS paragraph_ordinal, es.sentence_ordinal,
  s.text AS sentence_text, s.char_start AS sentence_char_start,
  es.char_start, es.char_end, s.page AS sentence_page, es.collected_at`

export const ENTRY_SENTENCE_JOINS = `JOIN article a ON a.id = es.article_id
  JOIN paragraph p
    ON p.article_id = es.article_id AND p.id = es.paragraph_id
  JOIN sentence s
    ON s.article_id = es.article_id
   AND s.paragraph_id = es.paragraph_id
   AND s.ordinal = es.sentence_ordinal`

export function readEntrySummary(database: AppDatabase, entryId: string): EntrySummary | null {
  const row = database
    .prepare(
      `SELECT we.id, we.main_form, we.last_collected_at,
              (SELECT el.marked_at FROM entry_later el WHERE el.entry_id = we.id)
                AS later_marked_at,
              (SELECT COUNT(*) FROM entry_sentence es WHERE es.entry_id = we.id) AS sentence_count,
              (SELECT COUNT(DISTINCT es.article_id) FROM entry_sentence es
                WHERE es.entry_id = we.id) AS article_count,
              (SELECT COUNT(*) FROM learning_note ln WHERE ln.entry_id = we.id) AS note_count
         FROM word_entry we
        WHERE we.id = ?`
    )
    .get(entryId) as EntrySummaryRow | undefined
  if (!row) {
    return null
  }

  const variants = database
    .prepare(
      `SELECT surface FROM entry_sentence
        WHERE entry_id = ?
        GROUP BY surface
        ORDER BY MIN(collected_at), MIN(rowid)`
    )
    .all(entryId) as { surface: string }[]

  return {
    id: row.id,
    mainForm: row.main_form,
    variants: variants
      .map((variant) => variant.surface)
      .filter((surface) => surface !== row.main_form),
    sentenceCount: row.sentence_count,
    articleCount: row.article_count,
    noteCount: row.note_count,
    lastCollectedAt: row.last_collected_at,
    laterMarkedAt: row.later_marked_at
  }
}

export function toEntrySentence(row: EntrySentenceRow): EntrySentence {
  return {
    id: row.id,
    surface: row.surface,
    articleId: row.article_id,
    articleTitle: row.article_title,
    paragraphId: row.paragraph_id,
    paragraphOrdinal: row.paragraph_ordinal + 1,
    paragraphLetter: paragraphLetter(row.article_kind, row.paragraph_id, row.paragraph_ordinal),
    sentenceOrdinal: row.sentence_ordinal,
    sentenceText: row.sentence_text,
    start: row.char_start,
    end: row.char_end,
    surfaceOffset: row.char_start - row.sentence_char_start,
    page: row.sentence_page,
    previousSentence: null,
    nextSentence: null,
    canSplitToNew: false,
    collectedAt: row.collected_at
  }
}

export function readEntrySentence(database: AppDatabase, id: string): EntrySentence | null {
  const row = database
    .prepare(
      `SELECT ${ENTRY_SENTENCE_COLUMNS}
         FROM entry_sentence es
         ${ENTRY_SENTENCE_JOINS}
        WHERE es.id = ?`
    )
    .get(id) as EntrySentenceRow | undefined
  return row ? toEntrySentence(row) : null
}

/** 阅读页从词条跳过来时要定位的原句，以及它属于哪个词条。 */
export function readEntrySentenceTarget(
  database: AppDatabase,
  entrySentenceId: string
): EntrySentenceTarget | null {
  const stored = database
    .prepare('SELECT entry_id FROM entry_sentence WHERE id = ?')
    .get(entrySentenceId) as { entry_id: string } | undefined
  if (!stored) {
    return null
  }
  const entry = readEntrySummary(database, stored.entry_id)
  const sentence = readEntrySentence(database, entrySentenceId)
  return entry && sentence ? { entry, sentence } : null
}

/** 一篇原文里全部已收集标记，按段序、句序、段内位置排。 */
export function readArticleCollections(
  database: AppDatabase,
  articleId: string
): ReadingCollectionMark[] {
  const rows = database
    .prepare(
      `SELECT es.id, es.entry_id, we.main_form, es.surface, es.paragraph_id,
              es.sentence_ordinal, es.char_start, es.char_end
         FROM entry_sentence es
         JOIN word_entry we ON we.id = es.entry_id
         JOIN paragraph p
           ON p.article_id = es.article_id AND p.id = es.paragraph_id
        WHERE es.article_id = ?
        ORDER BY p.ordinal, es.sentence_ordinal, es.char_start, es.id`
    )
    .all(articleId) as {
    id: string
    entry_id: string
    main_form: string
    surface: string
    paragraph_id: string
    sentence_ordinal: number
    char_start: number
    char_end: number
  }[]

  return rows.map((row) => ({
    id: row.id,
    entryId: row.entry_id,
    entryMainForm: row.main_form,
    surface: row.surface,
    paragraphId: row.paragraph_id,
    sentenceOrdinal: row.sentence_ordinal,
    start: row.char_start,
    end: row.char_end
  }))
}

/** 点开一个已收集词时的词条卡；词条不存在时为 null。 */
export function readWordEntryCard(
  database: AppDatabase,
  entryId: string
): WordEntryCard | null {
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

  return { entry, sentences: rows.map(toEntrySentence) }
}

/**
 * 收下一次选词：找到或建一个词条，再挂上这条原句。同篇同句同一个词条已经收过时
 * 只返回已有的一条，不新增、不累加计数。
 */
export function collectSelection(
  database: AppDatabase,
  request: CollectSelectionRequest,
  options: { now?: string; dictionary?: Dictionary } = {}
): CollectSelectionResult {
  const article = database
    .prepare('SELECT id FROM article WHERE id = ?')
    .get(request.articleId) as ArticleRow | undefined
  if (!article) {
    return { status: 'rejected', reason: 'article' }
  }

  const paragraph = database
    .prepare('SELECT text FROM paragraph WHERE article_id = ? AND id = ?')
    .get(request.articleId, request.paragraphId) as ParagraphRow | undefined
  if (!paragraph) {
    return { status: 'rejected', reason: 'paragraph' }
  }

  const sentence = database
    .prepare(
      `SELECT char_start, char_end FROM sentence
        WHERE article_id = ? AND paragraph_id = ? AND ordinal = ?`
    )
    .get(request.articleId, request.paragraphId, request.sentenceOrdinal) as
    | SentenceRangeRow
    | undefined
  if (!sentence) {
    return { status: 'rejected', reason: 'sentence' }
  }

  const read = readEntrySelection(paragraph.text, sentence, request.start, request.end)
  if (read.status === 'rejected') {
    return read
  }
  const { surface, start, end } = read

  const key = resolveEntryKey(database, surface, options.dictionary)
  const now = options.now ?? new Date().toISOString()

  const stored = database.transaction((): { entryId: string; sentenceId: string; created: boolean } => {
    // 先按词条键找；手工合并/换主词形后键可能没跟着变，再按已收过的同一个词形找，
    // 免得同一个表达散成两条词条。
    const existingEntry =
      (database
        .prepare('SELECT id FROM word_entry WHERE normalized_key = ?')
        .get(key) as EntryRow | undefined) ??
      (database
        .prepare(
          `SELECT entry_id AS id FROM entry_sentence
            WHERE lower(surface) = lower(?)
            ORDER BY collected_at DESC, id DESC LIMIT 1`
        )
        .get(surface) as EntryRow | undefined)

    let entryId: string
    if (existingEntry) {
      entryId = existingEntry.id
    } else {
      entryId = randomUUID()
      database
        .prepare(
          `INSERT INTO word_entry (id, main_form, normalized_key, created_at, last_collected_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(entryId, surface, key, now, now)
    }

    const duplicate = database
      .prepare(
        `SELECT id FROM entry_sentence
          WHERE entry_id = ? AND article_id = ? AND paragraph_id = ? AND sentence_ordinal = ?`
      )
      .get(entryId, request.articleId, request.paragraphId, request.sentenceOrdinal) as
      | { id: string }
      | undefined
    if (duplicate) {
      return { entryId, sentenceId: duplicate.id, created: false }
    }

    const sentenceId = randomUUID()
    database
      .prepare(
        `INSERT INTO entry_sentence (
           id, entry_id, article_id, paragraph_id, sentence_ordinal,
           surface, char_start, char_end, collected_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sentenceId,
        entryId,
        request.articleId,
        request.paragraphId,
        request.sentenceOrdinal,
        surface,
        start,
        end,
        now
      )
    database
      .prepare('UPDATE word_entry SET last_collected_at = ? WHERE id = ?')
      .run(now, entryId)
    return { entryId, sentenceId, created: true }
  })()

  const entry = readEntrySummary(database, stored.entryId)
  const entrySentence = readEntrySentence(database, stored.sentenceId)
  if (!entry || !entrySentence) {
    // 事务刚写完就读不到，说明并发删了文章；按拒绝处理，别把半截结果交给界面。
    return { status: 'rejected', reason: 'article' }
  }

  return {
    status: stored.created ? 'collected' : 'duplicate',
    entry,
    sentence: entrySentence,
    marks: readArticleCollections(database, request.articleId)
  }
}

/**
 * 删掉一条原句关联。删的是最后一条时连词条一起删，学习内容随词条级联删掉；
 * 界面在这之前先提示。
 */
export function deleteEntrySentence(
  database: AppDatabase,
  entrySentenceId: string
): DeleteEntrySentenceResult {
  const stored = database
    .prepare(
      `SELECT id, entry_id, article_id, paragraph_id, sentence_ordinal,
              surface, char_start, char_end, collected_at
         FROM entry_sentence WHERE id = ?`
    )
    .get(entrySentenceId) as StoredSentenceRow | undefined
  if (!stored) {
    return { status: 'missing' }
  }

  const remaining = database.transaction((): number => {
    database.prepare('DELETE FROM entry_sentence WHERE id = ?').run(entrySentenceId)
    const count = database
      .prepare('SELECT COUNT(*) AS count FROM entry_sentence WHERE entry_id = ?')
      .get(stored.entry_id) as { count: number }
    if (count.count === 0) {
      // 词条删掉后，钉在上面的学习内容也随级联没了；钉住本身退回未归档等重新落点。
      reassignPinsFromEntry(database, stored.entry_id, null)
      database.prepare('DELETE FROM word_entry WHERE id = ?').run(stored.entry_id)
    } else {
      refreshLastCollected(database, stored.entry_id)
    }
    return count.count
  })()

  const entryDeleted = remaining === 0
  return {
    status: 'deleted',
    entryDeleted,
    entry: entryDeleted ? null : readEntrySummary(database, stored.entry_id),
    articleId: stored.article_id,
    marks: readArticleCollections(database, stored.article_id),
    // 最后一条不提供撤销：词条、学习内容与钉住落点都一起收走了，只走危险确认。
    ...(entryDeleted
      ? {}
      : {
          snapshot: {
            id: stored.id,
            entryId: stored.entry_id,
            articleId: stored.article_id,
            paragraphId: stored.paragraph_id,
            sentenceOrdinal: stored.sentence_ordinal,
            surface: stored.surface,
            start: stored.char_start,
            end: stored.char_end,
            collectedAt: stored.collected_at
          }
        })
  }
}
