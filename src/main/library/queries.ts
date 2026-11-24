import type {
  ArticleDetail,
  ArticleKind,
  ArticleSourceWord,
  HomeSummary,
  LibraryArticle,
  LibraryListing,
  LibrarySearchResults,
  LibrarySession,
  MarkArticleCompletedResult,
  ReadingPoint,
  ReadingProgress
} from '../../shared/library'
import type { AppDatabase } from '../db/database'
import { readArticleEntryChips, readRecentEntryChips } from '../entries/page'
import { readLaterEntries } from '../entries/later'

type ArticleRow = {
  row_id: number
  id: string
  title: string
  kind: ArticleKind
  source_type: string | null
  source_entry_ids: string | null
  kind_label: string
  session_key: string
  session_label: string
  set_label: string
  exam_set: number
  word_count: number
  body_text: string
  page_start: number | null
  page_end: number | null
  ordinal: number
  last_opened_at: string | null
  last_paragraph_id: string | null
  last_sentence_index: number | null
  completed_at: string | null
}

const ARTICLE_COLUMNS = `rowid AS row_id, id, title, kind, source_type, source_entry_ids,
  kind_label, session_key, session_label, set_label, exam_set,
  word_count, body_text, page_start, page_end, ordinal,
  last_opened_at, last_paragraph_id, last_sentence_index, completed_at`

/** 生成文章在库里记 `source_type = 'ai'`；旧文章与随包语料这一列是 NULL，按真题读。 */
function sourceTypeOf(row: ArticleRow): LibraryArticle['sourceType'] {
  return row.source_type === 'ai' ? 'ai' : 'exam'
}

/**
 * 打开过的文章才有进度：按最后到的句子在全文里排第几算百分比。
 * 完成时间一旦写下就是第三种状态，固定 100%；读到末句也先停在 99%，
 * 「读完」只由进入「本篇选词」这一条入口写。
 */
function readingProgress(database: AppDatabase, row: ArticleRow): ReadingProgress {
  if (row.completed_at !== null) {
    return { state: 'completed', percent: 100 }
  }

  if (
    row.last_opened_at === null ||
    row.last_paragraph_id === null ||
    row.last_sentence_index === null
  ) {
    return { state: 'unread', percent: 0 }
  }

  const paragraph = database
    .prepare('SELECT ordinal FROM paragraph WHERE article_id = ? AND id = ?')
    .get(row.id, row.last_paragraph_id) as { ordinal: number } | undefined
  if (!paragraph) {
    return { state: 'unread', percent: 0 }
  }

  const counted = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sentence WHERE article_id = ?) AS total,
         (SELECT COUNT(*) FROM sentence s
            JOIN paragraph p ON p.article_id = s.article_id AND p.id = s.paragraph_id
          WHERE s.article_id = ?
            AND (p.ordinal < ? OR (p.ordinal = ? AND s.ordinal <= ?))) AS read`
    )
    .get(row.id, row.id, paragraph.ordinal, paragraph.ordinal, row.last_sentence_index) as {
    total: number
    read: number
  }

  if (counted.total === 0 || counted.read === 0) {
    return { state: 'unread', percent: 0 }
  }
  // 读到末句也先停在 99%：读完是单独的语义，等阅读页显式写。
  const percent = Math.min(99, Math.max(1, Math.round((counted.read / counted.total) * 100)))
  return { state: 'reading', percent }
}

function toArticle(database: AppDatabase, row: ArticleRow): LibraryArticle {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    sourceType: sourceTypeOf(row),
    kindLabel: row.kind_label,
    sessionLabel: row.session_label,
    setLabel: row.set_label,
    wordCount: row.word_count,
    progress: readingProgress(database, row),
    lastOpenedAt: row.last_opened_at
  }
}

function readArticleRow(database: AppDatabase, articleId: string): ArticleRow | undefined {
  return database
    .prepare(`SELECT ${ARTICLE_COLUMNS} FROM article WHERE id = ?`)
    .get(articleId) as ArticleRow | undefined
}

/**
 * 单篇文章的列表行：全局搜索按命中逐篇取它，不额外算详情里的计数。
 * 文章不存在时返回 null。
 */
export function readLibraryArticle(
  database: AppDatabase,
  articleId: string
): LibraryArticle | null {
  const row = readArticleRow(database, articleId)
  return row ? toArticle(database, row) : null
}

/**
 * 文章库：真题按场次、套数和题型固定排序；
 * 生成文章单独一列，按保存顺序从新到旧，不占场次、也不混进真题分组。
 */
export function readLibrary(database: AppDatabase): LibraryListing {
  const rows = database
    .prepare(
      `SELECT ${ARTICLE_COLUMNS} FROM article
       ORDER BY session_key DESC,
         exam_set ASC,
         CASE kind WHEN 'long_match' THEN 0 ELSE 1 END,
         ordinal ASC`
    )
    .all() as ArticleRow[]

  const sessions: LibrarySession[] = []
  let current: LibrarySession | null = null
  for (const row of rows) {
    if (sourceTypeOf(row) === 'ai') continue
    if (current === null || current.id !== row.session_key) {
      current = { id: row.session_key, label: row.session_label, sets: [] }
      sessions.push(current)
    }
    let set = current.sets.at(-1)
    if (!set || set.id !== row.exam_set) {
      set = { id: row.exam_set, label: row.set_label, articles: [] }
      current.sets.push(set)
    }
    set.articles.push(toArticle(database, row))
  }

  const aiArticles = rows
    .filter((row) => sourceTypeOf(row) === 'ai')
    .sort((left, right) => right.row_id - left.row_id)
    .map((row) => toArticle(database, row))

  return {
    articleCount: rows.length,
    sessionCount: sessions.length,
    sessions,
    aiArticles
  }
}

/** `source_entry_ids` 是保存时的来源词条 id 列表；读详情时按当前词条补主词形。 */
function readSourceWords(database: AppDatabase, raw: string | null): ArticleSourceWord[] {
  if (raw === null) {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const value of parsed) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue
    seen.add(value)
    ids.push(value)
  }
  return ids.map((entryId) => {
    const entry = database
      .prepare('SELECT main_form FROM word_entry WHERE id = ?')
      .get(entryId) as { main_form: string } | undefined
    return { entryId, mainForm: entry?.main_form ?? null }
  })
}

export function readArticleDetail(
  database: AppDatabase,
  articleId: string
): ArticleDetail | null {
  const row = readArticleRow(database, articleId)
  if (!row) {
    return null
  }

  const counted = database
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM paragraph WHERE article_id = ?) AS paragraphs,
         (SELECT COUNT(*) FROM sentence WHERE article_id = ?) AS sentences,
         (SELECT COUNT(DISTINCT es.entry_id) FROM entry_sentence es
           WHERE es.article_id = ?) AS word_entries,
         (SELECT COUNT(*) FROM entry_sentence es WHERE es.article_id = ?) AS collected_sentences`
    )
    .get(articleId, articleId, articleId, articleId) as {
    paragraphs: number
    sentences: number
    word_entries: number
    collected_sentences: number
  }

  return {
    ...toArticle(database, row),
    paragraphCount: counted.paragraphs,
    sentenceCount: counted.sentences,
    wordEntryCount: counted.word_entries,
    collectedSentenceCount: counted.collected_sentences,
    pages: formatPages(row.page_start, row.page_end),
    sourceWords: readSourceWords(database, row.source_entry_ids)
  }
}

function formatPages(start: number | null, end: number | null): string {
  if (start === null || end === null) {
    return ''
  }
  return start === end ? `第 ${start} 页` : `第 ${start}–${end} 页`
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 命中处前后各取一小段，尽量不切在半个词上。 */
function snippetAround(bodyText: string, pattern: string): string {
  const index = bodyText.toLowerCase().indexOf(pattern)
  if (index < 0) {
    return collapseWhitespace(bodyText.slice(0, 120))
  }
  const context = 48
  let start = Math.max(0, index - context)
  let end = Math.min(bodyText.length, index + pattern.length + context)
  if (start > 0) {
    const space = bodyText.indexOf(' ', start)
    if (space >= 0 && space < index) {
      start = space + 1
    }
  }
  if (end < bodyText.length) {
    const space = bodyText.lastIndexOf(' ', end)
    if (space > index + pattern.length) {
      end = space
    }
  }
  const prefix = start > 0 ? '…' : ''
  const suffix = end < bodyText.length ? '…' : ''
  return `${prefix}${collapseWhitespace(bodyText.slice(start, end))}${suffix}`
}

/**
 * 文章库搜索：同时匹配篇名与正文，返回命中处的一小段。通配符按字面处理。
 */
export function searchLibrary(database: AppDatabase, rawQuery: string): LibrarySearchResults {
  const query = rawQuery.trim()
  if (query === '') {
    return { query, results: [] }
  }
  const pattern = query.toLowerCase()

  const rows = database
    .prepare(
      `SELECT ${ARTICLE_COLUMNS} FROM article
       WHERE instr(lower(title), ?) > 0 OR instr(lower(body_text), ?) > 0
       ORDER BY session_key DESC, ordinal ASC`
    )
    .all(pattern, pattern) as ArticleRow[]

  return {
    query,
    results: rows.map((row) => {
      const titleHit = row.title.toLowerCase().includes(pattern)
      return {
        article: toArticle(database, row),
        matched: titleHit ? 'title' : 'body',
        snippet: titleHit ? row.title : snippetAround(row.body_text, pattern)
      }
    })
  }
}

/**
 * 打开一篇文章：记下「最近打开」，首次打开时把位置停在第一句。
 * 阅读页之后会按真实阅读位置改写这两列。
 */
export function openArticle(
  database: AppDatabase,
  articleId: string,
  options: { now?: string } = {}
): { opened: boolean } {
  const row = database
    .prepare('SELECT id, last_paragraph_id FROM article WHERE id = ?')
    .get(articleId) as { id: string; last_paragraph_id: string | null } | undefined
  if (!row) {
    return { opened: false }
  }

  const now = options.now ?? new Date().toISOString()
  if (row.last_paragraph_id !== null) {
    database.prepare('UPDATE article SET last_opened_at = ? WHERE id = ?').run(now, articleId)
    return { opened: true }
  }

  const firstParagraph = database
    .prepare('SELECT id FROM paragraph WHERE article_id = ? ORDER BY ordinal LIMIT 1')
    .get(articleId) as { id: string } | undefined
  if (!firstParagraph) {
    database.prepare('UPDATE article SET last_opened_at = ? WHERE id = ?').run(now, articleId)
    return { opened: true }
  }

  database
    .prepare(
      `UPDATE article SET last_opened_at = ?, last_paragraph_id = ?, last_sentence_index = 0
       WHERE id = ?`
    )
    .run(now, firstParagraph.id, articleId)
  return { opened: true }
}

/**
 * 进入「本篇选词」即读完：写下完成时间，只写一次。
 * 只碰 completed_at——阅读位置、最近打开与本篇阅读设置都是各自的列，重读、滚动、
 * 改设置都不该被这一笔顺手改掉。文章不存在时什么都不写。
 */
export function markArticleCompleted(
  database: AppDatabase,
  articleId: string,
  options: { now?: string } = {}
): MarkArticleCompletedResult {
  const row = database
    .prepare('SELECT completed_at FROM article WHERE id = ?')
    .get(articleId) as { completed_at: string | null } | undefined
  if (!row) {
    return { status: 'missing' }
  }
  if (row.completed_at !== null) {
    return {
      status: 'completed',
      articleId,
      completedAt: row.completed_at,
      changed: false
    }
  }

  const now = options.now ?? new Date().toISOString()
  const updated = database
    .prepare('UPDATE article SET completed_at = ? WHERE id = ? AND completed_at IS NULL')
    .run(now, articleId)
  if (updated.changes === 0) {
    // 理论上只在并发写入时走到；以库里已经落下的那一份为准，不覆盖。
    const current = database
      .prepare('SELECT completed_at FROM article WHERE id = ?')
      .get(articleId) as { completed_at: string | null }
    if (current.completed_at !== null) {
      return {
        status: 'completed',
        articleId,
        completedAt: current.completed_at,
        changed: false
      }
    }
  }

  return { status: 'completed', articleId, completedAt: now, changed: true }
}

/**
 * 上次读到的位置。段与句都用 1 起，句中文字一并带上，首页据此显示「上次停在哪」。
 * 位置指向的句子已经不在了（比如语料更新过）就当作没读过。
 */
export function readReadingPoint(
  database: AppDatabase,
  articleId: string
): ReadingPoint | null {
  const row = database
    .prepare(
      'SELECT last_paragraph_id, last_sentence_index FROM article WHERE id = ?'
    )
    .get(articleId) as
    | { last_paragraph_id: string | null; last_sentence_index: number | null }
    | undefined
  if (
    !row ||
    row.last_paragraph_id === null ||
    row.last_sentence_index === null
  ) {
    return null
  }

  const found = database
    .prepare(
      `SELECT p.ordinal AS paragraph_ordinal, s.text AS sentence_text
         FROM paragraph p
         JOIN sentence s
           ON s.article_id = p.article_id AND s.paragraph_id = p.id AND s.ordinal = ?
        WHERE p.article_id = ? AND p.id = ?`
    )
    .get(row.last_sentence_index, articleId, row.last_paragraph_id) as
    | { paragraph_ordinal: number; sentence_text: string }
    | undefined
  if (!found) {
    return null
  }
  return {
    paragraphId: row.last_paragraph_id,
    paragraphOrdinal: found.paragraph_ordinal + 1,
    sentenceOrdinal: row.last_sentence_index + 1,
    sentenceText: found.sentence_text
  }
}

/**
 * 最近打开过的文章：全局搜索空态与后续「最近」入口共用。
 * 与首页「继续阅读」不同，这里不排除已读完的篇目；按最后打开时间倒序。
 */
export function readRecentlyOpenedArticles(
  database: AppDatabase,
  limit: number
): LibraryArticle[] {
  const rows = database
    .prepare(
      `SELECT ${ARTICLE_COLUMNS} FROM article
        WHERE last_opened_at IS NOT NULL
        ORDER BY last_opened_at DESC, rowid DESC
        LIMIT ?`
    )
    .all(limit) as ArticleRow[]
  return rows.map((row) => toArticle(database, row))
}

/**
 * 首页：文章库规模，最近打开、还没读完的那一篇，已读完篇数，以及真实的最近收集。
 * 「继续阅读」只挑没读完的：读完后它让位给更早打开的那一篇，全部读完才是 null。
 */
export function readHomeSummary(database: AppDatabase): HomeSummary {
  const totals = database
    .prepare(
      `SELECT COUNT(*) AS articles,
              COUNT(DISTINCT CASE WHEN source_type = 'ai' THEN NULL ELSE session_key END) AS sessions,
              (SELECT COUNT(*) FROM article WHERE completed_at IS NOT NULL) AS completed
         FROM article`
    )
    .get() as { articles: number; sessions: number; completed: number }

  const recent = database
    .prepare(
      `SELECT ${ARTICLE_COLUMNS} FROM article
       WHERE last_opened_at IS NOT NULL AND completed_at IS NULL
       ORDER BY last_opened_at DESC
       LIMIT 1`
    )
    .get() as ArticleRow | undefined

  return {
    library: { articleCount: totals.articles, sessionCount: totals.sessions },
    continueReading: recent
      ? {
          article: toArticle(database, recent),
          lastReadPoint: readReadingPoint(database, recent.id),
          articleEntries: readArticleEntryChips(database, recent.id)
        }
      : null,
    completedArticleCount: totals.completed,
    recentEntries: readRecentEntryChips(database),
    laterEntries: readLaterEntries(database)
  }
}

