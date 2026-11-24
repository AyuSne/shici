import { randomUUID } from 'node:crypto'
import type { ChatError } from '../../shared/chat'
import type {
  ArticleContextMaterials,
  AskThreadRequest,
  ChatThreadView,
  CreateGroupThreadRequest,
  CreateGroupThreadResult,
  CreateThreadRequest,
  CreateThreadResult,
  DeleteThreadRequest,
  DeleteThreadResult,
  EditQuestionRequest,
  OpenThreadForMainRequest,
  OpenThreadForMainResult,
  PackArticleWordsRequest,
  PackArticleWordsResult,
  QuestionResult,
  SaveAnswerRequest,
  SaveAnswerResult,
  SaveContinuationRequest,
  SwitchAnswerRequest,
  SwitchQuestionRequest,
  SwitchThreadResult,
  ThreadAnswer,
  ThreadContextCandidates,
  ThreadContextItem,
  ThreadContextKind,
  ThreadListItem,
  ThreadListResult,
  ThreadMain,
  ThreadMainKind,
  ThreadTurn,
  ThreadVersion,
  UpdateThreadContextRequest,
  UpdateThreadContextResult
} from '../../shared/threads'
import { GROUP_WORD_LIMIT, wordContextEntryId, deduplicateArticleContext, summarizeContextItems } from '../../shared/threads'
import { paragraphLetter } from '../corpus/letter'
import type { AppDatabase } from '../db/database'

/**
 * 线程是围绕一个词、一条原句或一篇文章展开的对话，也可以什么都不挂。
 * 线程存成不可变条目日志（ADR 0003）：条目只追加，parent_id 构成树，
 * 线程只记一个 leaf_entry_id 表示当前分支。重新生成是同一提问下的兄弟回答，
 * 改口是同一条父条目下的兄弟提问；继续生成接在当前回答的最后一段后面。
 */

type ThreadEntryKind = 'question' | 'answer' | 'continuation'
type AnswerPhase = 'done' | 'stopped' | 'error'

type ThreadRow = {
  id: string
  title: string
  main_kind: string
  main_id: string | null
  context_json: string
  leaf_entry_id: string | null
  created_at: string
  updated_at: string
}

type ThreadEntryRow = {
  row_id: number
  id: string
  parent_id: string | null
  kind: string
  payload: string
  created_at: string
}

type AttemptEntryRow = {
  thread_id: string
  parent_id: string | null
  kind: string
  payload: string
}

type QuestionPayload = {
  text: string
  context: ThreadContextItem[]
}

type AnswerPayload = {
  text: string
  thinking: string
  thinkingMs: number
  phase: AnswerPhase
  error: ChatError | null
  /** 生成这一版时用的模型名；旧条目没有时为空串。 */
  model: string
}

const CONTEXT_KINDS: readonly ThreadContextKind[] = [
  'word',
  'sentence',
  'paragraph',
  'note',
  'article',
  'excerpt'
]
const ANSWER_PHASES: readonly AnswerPhase[] = ['done', 'stopped', 'error']
/** 一条线程最多带这么多条上下文，防止界面把整本书塞进去。 */
const CONTEXT_LIMIT = 10000
const TITLE_LIMIT = 30

function nowOf(options: { now?: string }): string {
  return options.now ?? new Date().toISOString()
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function parseContextJson(raw: string): ThreadContextItem[] {
  try {
    return sanitizeContextItems(JSON.parse(raw) as unknown)
  } catch {
    return []
  }
}

function isContextKind(value: unknown): value is ThreadContextKind {
  return typeof value === 'string' && (CONTEXT_KINDS as readonly string[]).includes(value)
}

/**
 * 上下文条目跨层传来，写库前只留认得的部分：种类要对、字要非空、id 要唯一。
 * 同一个 id 只留第一条，保持加入顺序。
 */
export function sanitizeContextItems(value: unknown): ThreadContextItem[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const items: ThreadContextItem[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const record = candidate as Record<string, unknown>
    const { id, kind, label, text, source } = record
    if (typeof id !== 'string' || id === '' || !isContextKind(kind)) continue
    if (typeof text !== 'string' || text.trim() === '') continue
    if (seen.has(id)) continue
    seen.add(id)
    items.push({
      id,
      kind,
      label: typeof label === 'string' ? label : '',
      text,
      source: typeof source === 'string' ? source : ''
    })
    if (items.length >= CONTEXT_LIMIT) break
  }
  return items
}

export const summarizeContext = summarizeContextItems

/** 上下文里带上的词条条目数；列表按 id 去过重，同一个词条只算一个。 */
function wordItemCount(items: readonly ThreadContextItem[]): number {
  return items.reduce((count, item) => (item.kind === 'word' ? count + 1 : count), 0)
}

/* ---------- 主对象 ---------- */

type EntryMainRow = {
  id: string
  main_form: string
  sentence_count: number
  article_count: number
}

type SentenceMainRow = {
  id: string
  entry_id: string
  surface: string
  article_id: string
  paragraph_id: string
  sentence_ordinal: number
  sentence_text: string
  article_title: string
  article_kind: string
  paragraph_ordinal: number
}

type ArticleMainRow = {
  id: string
  title: string
  session_label: string
  set_label: string
  kind_label: string
  word_count: number
}

function readEntryMain(database: AppDatabase, entryId: string): ThreadMain {
  const row = database
    .prepare(
      `SELECT we.id, we.main_form,
              (SELECT COUNT(*) FROM entry_sentence es WHERE es.entry_id = we.id) AS sentence_count,
              (SELECT COUNT(DISTINCT es.article_id) FROM entry_sentence es
                WHERE es.entry_id = we.id) AS article_count
         FROM word_entry we WHERE we.id = ?`
    )
    .get(entryId) as EntryMainRow | undefined
  return row
    ? {
        kind: 'entry',
        entryId: row.id,
        mainForm: row.main_form,
        sentenceCount: row.sentence_count,
        articleCount: row.article_count
      }
    : { kind: 'none' }
}

function readSentenceMain(database: AppDatabase, entrySentenceId: string): ThreadMain {
  const row = database
    .prepare(
      `SELECT es.id, es.entry_id, es.surface, es.article_id, es.paragraph_id,
              es.sentence_ordinal, s.text AS sentence_text, a.title AS article_title,
              a.kind AS article_kind, p.ordinal AS paragraph_ordinal, we.main_form
         FROM entry_sentence es
         JOIN word_entry we ON we.id = es.entry_id
         JOIN article a ON a.id = es.article_id
         JOIN paragraph p ON p.article_id = es.article_id AND p.id = es.paragraph_id
         JOIN sentence s
           ON s.article_id = es.article_id
          AND s.paragraph_id = es.paragraph_id
          AND s.ordinal = es.sentence_ordinal
        WHERE es.id = ?`
    )
    .get(entrySentenceId) as (SentenceMainRow & { main_form: string }) | undefined
  if (!row) {
    return { kind: 'none' }
  }
  return {
    kind: 'sentence',
    entryId: row.entry_id,
    entrySentenceId: row.id,
    mainForm: row.main_form,
    surface: row.surface,
    sentenceText: row.sentence_text,
    articleId: row.article_id,
    articleTitle: row.article_title,
    paragraphId: row.paragraph_id,
    paragraphOrdinal: row.paragraph_ordinal + 1,
    paragraphLetter: paragraphLetter(
      row.article_kind as 'long_match' | 'careful_reading',
      row.paragraph_id,
      row.paragraph_ordinal
    ),
    sentenceOrdinal: row.sentence_ordinal
  }
}

function readArticleMain(database: AppDatabase, articleId: string): ThreadMain {
  const row = database
    .prepare(
      `SELECT id, title, session_label, set_label, kind_label, word_count
         FROM article WHERE id = ?`
    )
    .get(articleId) as ArticleMainRow | undefined
  return row
    ? {
        kind: 'article',
        articleId: row.id,
        title: row.title,
        sessionLabel: row.session_label,
        setLabel: row.set_label,
        kindLabel: row.kind_label,
        wordCount: row.word_count
      }
    : { kind: 'none' }
}

function describeMain(
  database: AppDatabase,
  mainKind: ThreadMainKind,
  mainId: string | null
): ThreadMain {
  if (mainId === null) {
    return { kind: 'none' }
  }
  if (mainKind === 'entry') {
    return readEntryMain(database, mainId)
  }
  if (mainKind === 'sentence') {
    return readSentenceMain(database, mainId)
  }
  if (mainKind === 'article') {
    return readArticleMain(database, mainId)
  }
  return { kind: 'none' }
}

function mainIdOf(request: CreateThreadRequest['main']): string | null {
  if (request.kind === 'entry') return request.entryId
  if (request.kind === 'sentence') return request.entrySentenceId
  if (request.kind === 'article') return request.articleId
  return null
}

function mainLabelOf(main: ThreadMain): string {
  switch (main.kind) {
    case 'none':
      // 面向学习者的说法：这条对话没有绑定词条/原句/文章，从空白开始。
      return '空白学习'
    case 'entry':
      return `词条 ${main.mainForm}`
    case 'sentence':
      return `原句 · ${main.surface} · 段 ${
        main.paragraphLetter ?? main.paragraphOrdinal
      } · 第 ${main.sentenceOrdinal + 1} 句`
    case 'article':
      return `文章 · ${main.title}`
  }
}

function titleOf(main: ThreadMain): string {
  switch (main.kind) {
    case 'none':
      return '新的学习'
    case 'entry':
      return main.mainForm
    case 'sentence':
      return `${main.surface} · 原句`
    case 'article':
      return main.title
  }
}

function titleFromQuestion(text: string): string {
  const characters = Array.from(text.trim())
  if (characters.length <= TITLE_LIMIT) {
    return characters.join('')
  }
  return `${characters.slice(0, TITLE_LIMIT).join('')}…`
}

/* ---------- 上下文条目 ---------- */

function toWordItem(
  entryId: string,
  mainForm: string,
  sentenceCount: number,
  articleCount: number
): ThreadContextItem {
  return {
    id: `word:${entryId}`,
    kind: 'word',
    label: mainForm,
    text: mainForm,
    source: `已收 ${sentenceCount} 条原句 · ${articleCount} 篇`
  }
}

function wordItem(database: AppDatabase, entryId: string): ThreadContextItem | null {
  const main = readEntryMain(database, entryId)
  if (main.kind !== 'entry') {
    return null
  }
  return toWordItem(main.entryId, main.mainForm, main.sentenceCount, main.articleCount)
}

type LibraryWordRow = {
  id: string
  main_form: string
  sentence_count: number
  article_count: number
}

/**
 * 空白/组词线程没有主对象可围着找材料，候选就从库里全部词条来：
 * 自由学习可以自己挑词，被移除的词也还能从这里加回来。
 */
function libraryWordItems(database: AppDatabase): ThreadContextItem[] {
  const rows = database
    .prepare(
      `SELECT we.id, we.main_form,
              (SELECT COUNT(*) FROM entry_sentence es WHERE es.entry_id = we.id) AS sentence_count,
              (SELECT COUNT(DISTINCT es.article_id) FROM entry_sentence es
                WHERE es.entry_id = we.id) AS article_count
         FROM word_entry we
        ORDER BY we.last_collected_at DESC, we.main_form`
    )
    .all() as LibraryWordRow[]
  return rows.map((row) => toWordItem(row.id, row.main_form, row.sentence_count, row.article_count))
}

type SentenceItemRow = {
  id: string
  surface: string
  article_id: string
  paragraph_id: string
  sentence_ordinal: number
  sentence_text: string
  article_title: string
  article_kind: string
  paragraph_ordinal: number
}

const SENTENCE_ITEM_SELECT = `es.id, es.surface, es.article_id, es.paragraph_id,
  es.sentence_ordinal, s.text AS sentence_text, a.title AS article_title,
  a.kind AS article_kind, p.ordinal AS paragraph_ordinal`

const SENTENCE_ITEM_JOINS = `JOIN article a ON a.id = es.article_id
  JOIN paragraph p ON p.article_id = es.article_id AND p.id = es.paragraph_id
  JOIN sentence s
    ON s.article_id = es.article_id
   AND s.paragraph_id = es.paragraph_id
   AND s.ordinal = es.sentence_ordinal`

function toSentenceItem(row: SentenceItemRow): ThreadContextItem {
  const letter = paragraphLetter(
    row.article_kind as 'long_match' | 'careful_reading',
    row.paragraph_id,
    row.paragraph_ordinal
  )
  const paragraph = letter ?? String(row.paragraph_ordinal + 1)
  return {
    id: `sentence:${row.id}`,
    kind: 'sentence',
    label: row.surface,
    text: row.sentence_text,
    source: `${row.article_title} · 段 ${paragraph} · 第 ${row.sentence_ordinal + 1} 句`
  }
}

function sentenceItemsOfEntry(database: AppDatabase, entryId: string): ThreadContextItem[] {
  const rows = database
    .prepare(
      `SELECT ${SENTENCE_ITEM_SELECT}
         FROM entry_sentence es
         ${SENTENCE_ITEM_JOINS}
        WHERE es.entry_id = ?
        ORDER BY es.collected_at DESC, es.rowid DESC`
    )
    .all(entryId) as SentenceItemRow[]
  return rows.map(toSentenceItem)
}

function sentenceItemsOfArticle(database: AppDatabase, articleId: string): ThreadContextItem[] {
  const rows = database
    .prepare(
      `SELECT ${SENTENCE_ITEM_SELECT}
         FROM entry_sentence es
         ${SENTENCE_ITEM_JOINS}
        WHERE es.article_id = ?
        ORDER BY es.collected_at DESC, es.rowid DESC`
    )
    .all(articleId) as SentenceItemRow[]
  return rows.map(toSentenceItem)
}

type ParagraphItemRow = {
  id: string
  ordinal: number
  text: string
  article_id: string
  article_title: string
  article_kind: string
}

function toParagraphItem(row: ParagraphItemRow): ThreadContextItem {
  const letter = paragraphLetter(
    row.article_kind as 'long_match' | 'careful_reading',
    row.id,
    row.ordinal
  )
  const paragraph = letter ?? String(row.ordinal + 1)
  return {
    id: `paragraph:${row.article_id}:${row.id}`,
    kind: 'paragraph',
    label: `段 ${paragraph}`,
    text: row.text,
    source: row.article_title
  }
}

function paragraphItemsOfEntry(database: AppDatabase, entryId: string): ThreadContextItem[] {
  const rows = database
    .prepare(
      `SELECT p.id, p.ordinal, p.text, es.article_id, a.title AS article_title,
              a.kind AS article_kind
         FROM entry_sentence es
         JOIN paragraph p ON p.article_id = es.article_id AND p.id = es.paragraph_id
         JOIN article a ON a.id = es.article_id
        WHERE es.entry_id = ?
        GROUP BY es.article_id, es.paragraph_id
        ORDER BY a.title, p.ordinal`
    )
    .all(entryId) as ParagraphItemRow[]
  return rows.map(toParagraphItem)
}

function paragraphItemsOfArticle(database: AppDatabase, articleId: string): ThreadContextItem[] {
  const rows = database
    .prepare(
      `SELECT p.id, p.ordinal, p.text, p.article_id, a.title AS article_title,
              a.kind AS article_kind
         FROM paragraph p
         JOIN article a ON a.id = p.article_id
        WHERE p.article_id = ?
        ORDER BY p.ordinal`
    )
    .all(articleId) as ParagraphItemRow[]
  return rows.map(toParagraphItem)
}

type NoteItemRow = { id: string; body: string; main_form: string }

function toNoteItem(row: NoteItemRow): ThreadContextItem {
  return {
    id: `note:${row.id}`,
    kind: 'note',
    label: row.main_form,
    text: row.body,
    source: `词条 ${row.main_form} 的学习内容`
  }
}

function noteItemsOfEntry(database: AppDatabase, entryId: string): ThreadContextItem[] {
  const rows = database
    .prepare(
      `SELECT ln.id, ln.body, we.main_form
         FROM learning_note ln
         JOIN word_entry we ON we.id = ln.entry_id
        WHERE ln.entry_id = ?
        ORDER BY ln.pinned DESC, ln.created_at DESC, ln.id DESC`
    )
    .all(entryId) as NoteItemRow[]
  return rows.map(toNoteItem)
}

function noteItemsOfArticle(database: AppDatabase, articleId: string): ThreadContextItem[] {
  const rows = database
    .prepare(
      `SELECT ln.id, ln.body, we.main_form, ln.pinned, ln.created_at
         FROM learning_note ln
         JOIN word_entry we ON we.id = ln.entry_id
         JOIN entry_sentence es ON es.entry_id = ln.entry_id
        WHERE es.article_id = ?
        GROUP BY ln.id
        ORDER BY ln.pinned DESC, ln.created_at DESC, ln.id DESC`
    )
    .all(articleId) as NoteItemRow[]
  return rows.map(toNoteItem)
}

function articleItem(database: AppDatabase, articleId: string): ThreadContextItem | null {
  const main = readArticleMain(database, articleId)
  if (main.kind !== 'article') {
    return null
  }
  // 生成文章没有场次与套数，出处行只列真实存在的信息，不补假年份。
  const source = [main.sessionLabel, main.setLabel, main.kindLabel, `${main.wordCount} 词`]
    .filter((part) => part.trim() !== '')
    .join(' · ')
  return {
    id: `article:${main.articleId}`,
    kind: 'article',
    label: main.title,
    text: paragraphItemsOfArticle(database, articleId)
      .map((item) => `${item.label.replace('段 ', '')}. ${item.text}`)
      .join('\n\n'),
    source
  }
}

/** 旧版把文章标题存作正文；只补齐仍被选中的文章，不改历史提问快照。 */
function hydrateLegacyArticles(database: AppDatabase, items: ThreadContextItem[]): ThreadContextItem[] {
  return items.map((item) => {
    if (item.kind !== 'article' || !item.id.startsWith('article:') || item.text !== item.label) return item
    const full = articleItem(database, item.id.slice('article:'.length))
    return full && full.text.trim() !== '' ? { ...item, text: full.text } : item
  })
}

/**
 * 挂上主对象时预填的上下文：词条带主词形与最近收的那句原句，
 * 原句带词与它自己，文章带全文；空白线程什么都不带。
 */
function defaultContext(database: AppDatabase, main: ThreadMain): ThreadContextItem[] {
  const items: (ThreadContextItem | null)[] = []
  if (main.kind === 'entry') {
    items.push(wordItem(database, main.entryId))
    items.push(sentenceItemsOfEntry(database, main.entryId)[0] ?? null)
  } else if (main.kind === 'sentence') {
    items.push(wordItem(database, main.entryId))
    const sentence = database
      .prepare(`SELECT ${SENTENCE_ITEM_SELECT} FROM entry_sentence es ${SENTENCE_ITEM_JOINS} WHERE es.id = ?`)
      .get(main.entrySentenceId) as SentenceItemRow | undefined
    items.push(sentence ? toSentenceItem(sentence) : null)
  } else if (main.kind === 'article') {
    items.push(articleItem(database, main.articleId))
  }
  return items.filter((item): item is ThreadContextItem => item !== null)
}

/* ---------- 线程读写 ---------- */

function readThreadRow(database: AppDatabase, threadId: string): ThreadRow | undefined {
  return database
    .prepare(
      `SELECT id, title, main_kind, main_id, context_json, leaf_entry_id, created_at, updated_at
         FROM thread WHERE id = ?`
    )
    .get(threadId) as ThreadRow | undefined
}

function readThreadEntries(database: AppDatabase, threadId: string): ThreadEntryRow[] {
  return database
    .prepare(
      `SELECT rowid AS row_id, id, parent_id, kind, payload, created_at
         FROM thread_entry
        WHERE thread_id = ?
        ORDER BY created_at, rowid`
    )
    .all(threadId) as ThreadEntryRow[]
}

function questionPayloadOf(row: ThreadEntryRow): QuestionPayload {
  const payload = parseJson(row.payload)
  return {
    text: typeof payload.text === 'string' ? payload.text : '',
    context: sanitizeContextItems(payload.context)
  }
}

function answerPayloadOf(row: ThreadEntryRow): AnswerPayload {
  const payload = parseJson(row.payload)
  const phase =
    typeof payload.phase === 'string' &&
    (ANSWER_PHASES as readonly string[]).includes(payload.phase)
      ? (payload.phase as AnswerPhase)
      : 'done'
  const error = payload.error
  const thinkingMs =
    typeof payload.thinkingMs === 'number' && Number.isFinite(payload.thinkingMs)
      ? Math.max(0, Math.round(payload.thinkingMs))
      : 0
  return {
    text: typeof payload.text === 'string' ? payload.text : '',
    thinking: typeof payload.thinking === 'string' ? payload.thinking : '',
    thinkingMs,
    phase,
    model: typeof payload.model === 'string' ? payload.model : '',
    error:
      typeof error === 'object' && error !== null
        ? (error as ChatError)
        : null
  }
}

function versionsOf(
  rows: readonly ThreadEntryRow[],
  parentId: string | null,
  kind: ThreadEntryKind,
  selectedId: string
): ThreadVersion[] {
  return rows
    .filter((row) => row.parent_id === parentId && row.kind === kind)
    .map((row) => ({ id: row.id, selected: row.id === selectedId }))
}

function buildAnswer(
  rows: readonly ThreadEntryRow[],
  answerRows: readonly ThreadEntryRow[],
  questionId: string
): ThreadAnswer | null {
  const root = answerRows[0]
  if (!root) {
    return null
  }
  const continuations = answerRows.slice(1).filter((row) => row.kind === 'continuation')
  const segments = [root, ...continuations].map(answerPayloadOf)
  const last = segments[segments.length - 1] as AnswerPayload
  return {
    id: root.id,
    versions: versionsOf(rows, questionId, 'answer', root.id),
    text: segments.map((segment) => segment.text).join(''),
    thinking: segments
      .map((segment) => segment.thinking)
      .filter((text) => text !== '')
      .join('\n\n'),
    thinkingMs: segments.reduce((total, segment) => total + segment.thinkingMs, 0),
    phase: last.phase,
    error: last.error,
    model: segments[0]?.model ?? '',
    createdAt: root.created_at,
    continuationIds: continuations.map((row) => row.id)
  }
}

function buildTurns(rows: readonly ThreadEntryRow[], path: readonly ThreadEntryRow[]): ThreadTurn[] {
  const turns: ThreadTurn[] = []
  let question: ThreadEntryRow | null = null
  let answers: ThreadEntryRow[] = []

  const flush = (): void => {
    if (!question) return
    const questionRow = question
    const payload = questionPayloadOf(questionRow)
    turns.push({
      question: {
        id: questionRow.id,
        text: payload.text,
        createdAt: questionRow.created_at,
        wordCount: wordItemCount(payload.context),
        versions: versionsOf(
          rows,
          questionRow.parent_id,
          'question',
          questionRow.id
        )
      },
      answer: buildAnswer(rows, answers, questionRow.id)
    })
  }

  for (const row of path) {
    if (row.kind === 'question') {
      flush()
      question = row
      answers = []
      continue
    }
    if (row.kind === 'answer' || row.kind === 'continuation') {
      answers.push(row)
    }
  }
  flush()
  return turns
}

/** 从叶子沿 parent 走到根，再翻过来；叶子的父指针缺失时当成空线程。 */
function pathToLeaf(rows: readonly ThreadEntryRow[], leafId: string | null): ThreadEntryRow[] {
  if (leafId === null) {
    return []
  }
  const byId = new Map(rows.map((row) => [row.id, row]))
  const path: ThreadEntryRow[] = []
  const seen = new Set<string>()
  let cursor = byId.get(leafId)
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id)
    path.push(cursor)
    cursor = cursor.parent_id === null ? undefined : byId.get(cursor.parent_id)
  }
  path.reverse()
  return path
}

export function readThreadView(database: AppDatabase, threadId: string): ChatThreadView | null {
  const thread = readThreadRow(database, threadId)
  if (!thread) {
    return null
  }
  const rows = readThreadEntries(database, threadId)
  const context = hydrateLegacyArticles(database, parseContextJson(thread.context_json))
  const main = describeMain(
    database,
    thread.main_kind as ThreadMainKind,
    thread.main_id
  )
  return {
    id: thread.id,
    title: thread.title,
    main,
    ...(main.kind === 'none' && thread.main_kind !== 'none'
      ? { missingMain: thread.main_kind as Exclude<ThreadMainKind, 'none'> }
      : {}),
    context,
    contextSummary: summarizeContext(context),
    turns: buildTurns(rows, pathToLeaf(rows, thread.leaf_entry_id)),
    createdAt: thread.created_at,
    updatedAt: thread.updated_at
  }
}

export function listThreads(database: AppDatabase): ThreadListResult {
  // 轮数只数当前这一支上的提问；改口留下的旧提问不算，免得一条线程显示成两轮。
  const rows = database
    .prepare(
      `WITH RECURSIVE branch(thread_id, id, parent_id, kind) AS (
         SELECT t.id, e.id, e.parent_id, e.kind
           FROM thread t
           JOIN thread_entry e ON e.id = t.leaf_entry_id
         UNION
         SELECT b.thread_id, e.id, e.parent_id, e.kind
           FROM branch b
           JOIN thread_entry e ON e.id = b.parent_id
       )
       SELECT t.id, t.title, t.main_kind, t.main_id, t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM branch b
                WHERE b.thread_id = t.id AND b.kind = 'question') AS turn_count
         FROM thread t
        ORDER BY t.updated_at DESC, t.id DESC`
    )
    .all() as (Pick<ThreadRow, 'id' | 'title' | 'main_kind' | 'main_id' | 'created_at' | 'updated_at'> & {
    turn_count: number
  })[]

  const threads: ThreadListItem[] = rows.map((row) => {
    const main = describeMain(database, row.main_kind as ThreadMainKind, row.main_id)
    return {
      id: row.id,
      title: row.title,
      mainKind: row.main_kind as ThreadMainKind,
      mainLabel: main.kind === 'none' && row.main_kind !== 'none' ? '关联的内容已删除' : mainLabelOf(main),
      turnCount: row.turn_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }
  })
  return { threads }
}

function insertEntry(
  database: AppDatabase,
  input: {
    id?: string
    threadId: string
    parentId: string | null
    kind: ThreadEntryKind
    payload: QuestionPayload | AnswerPayload
    now: string
  }
): string {
  const id = input.id ?? randomUUID()
  database
    .prepare(
      `INSERT INTO thread_entry (id, thread_id, parent_id, kind, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, input.threadId, input.parentId, input.kind, JSON.stringify(input.payload), input.now)
  return id
}

function setLeaf(database: AppDatabase, threadId: string, leafId: string | null, now: string): void {
  database
    .prepare('UPDATE thread SET leaf_entry_id = ?, updated_at = ? WHERE id = ?')
    .run(leafId, now, threadId)
}

export function threadExists(database: AppDatabase, threadId: string): boolean {
  return database.prepare('SELECT 1 FROM thread WHERE id = ?').get(threadId) !== undefined
}

/** 一笔事务删掉所有分支和线程，不触碰出处快照。 */
export function deleteThread(
  database: AppDatabase,
  { threadId }: DeleteThreadRequest
): DeleteThreadResult {
  return database.transaction(() => {
    // 日志只追加，子条目的 rowid 比父条目大。先删子条目，避免长分支触发 SQLite 的递归级联深度上限。
    const entries = database.prepare('SELECT id FROM thread_entry WHERE thread_id = ? ORDER BY rowid DESC')
      .all(threadId) as { id: string }[]
    const deleteEntry = database.prepare('DELETE FROM thread_entry WHERE id = ?')
    for (const entry of entries) deleteEntry.run(entry.id)
    const deleted = database.prepare('DELETE FROM thread WHERE id = ?').run(threadId)
    return { status: deleted.changes > 0 ? 'deleted' : 'missing' } as const
  }).immediate()
}

export function createThread(
  database: AppDatabase,
  request: CreateThreadRequest,
  options: { now?: string } = {}
): CreateThreadResult {
  const now = nowOf(options)
  const main = describeMain(database, request.main.kind, mainIdOf(request.main))
  if (request.main.kind !== 'none' && main.kind === 'none') {
    return { status: 'rejected', reason: 'missing-main' }
  }

  const context = defaultContext(database, main)
  const id = randomUUID()
  database
    .prepare(
      `INSERT INTO thread (id, title, main_kind, main_id, context_json, leaf_entry_id,
                           created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`
    )
    .run(id, titleOf(main), main.kind, mainIdOf(request.main), JSON.stringify(context), now, now)

  const thread = readThreadView(database, id)
  if (!thread) {
    return { status: 'rejected', reason: 'missing-main' }
  }
  return { status: 'created', thread }
}

/** 组词线程的标题只用来在列表里认人：第一个词加总数，不改变主对象。 */
function groupTitleOf(forms: readonly string[]): string {
  const first = forms[0] ?? ''
  return forms.length <= 1 ? first : `${first} 等 ${forms.length} 个词`
}

/**
 * 空白/组词线程的唯一写入路径：主对象留空，上下文整份写进 `context_json`。
 * 组词与「本篇未整理词打包」共用，不另建会话表，也不另写一套 generation 状态。
 */
function insertContextThread(
  database: AppDatabase,
  input: { title: string; context: readonly ThreadContextItem[]; now: string }
): ChatThreadView | null {
  const id = randomUUID()
  database
    .prepare(
      `INSERT INTO thread (id, title, main_kind, main_id, context_json, leaf_entry_id,
                           created_at, updated_at)
       VALUES (?, ?, 'none', NULL, ?, NULL, ?, ?)`
    )
    .run(id, input.title, JSON.stringify(input.context), input.now, input.now)
  return readThreadView(database, id)
}

/** 请求里的词条 id 去空白、去重；非字符串与空串不算选中的词。 */
function uniqueEntryIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const ids: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const id = candidate.trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/**
 * 「用这些词学习」：从词条列表多选后一次开一条新线程。
 * 线程主对象保持空白（落点即未归档），默认上下文是每个词与它最近收的那句原句；
 * 每次调用都新建，绝不复用已有的空白或组词线程。选中的词一个都不能少：
 * 缺词直接拒绝，超过上限也直接拒绝，不在服务端悄悄截断。
 */
export function createGroupThread(
  database: AppDatabase,
  request: CreateGroupThreadRequest,
  options: { now?: string } = {}
): CreateGroupThreadResult {
  const entryIds = uniqueEntryIds(request?.entryIds)
  if (entryIds.length === 0) {
    return { status: 'rejected', reason: 'empty' }
  }
  if (entryIds.length > GROUP_WORD_LIMIT) {
    return { status: 'rejected', reason: 'too-many-words' }
  }

  const now = nowOf(options)
  const context: ThreadContextItem[] = []
  const seen = new Set<string>()
  const forms: string[] = []
  for (const entryId of entryIds) {
    const word = wordItem(database, entryId)
    if (word === null) {
      return { status: 'rejected', reason: 'missing-word' }
    }
    // 与挂单个词条的默认语义一致：最近收的那句原句；有更多原句再从 picker 加。
    const items = [word, sentenceItemsOfEntry(database, entryId)[0] ?? null]
    for (const item of items) {
      if (item !== null && !seen.has(item.id)) {
        seen.add(item.id)
        context.push(item)
      }
    }
    forms.push(word.label)
  }

  const holder: { thread: ChatThreadView | null } = { thread: null }
  database
    .transaction(() => {
      holder.thread = insertContextThread(database, {
        title: groupTitleOf(forms),
        context,
        now
      })
    })
    .immediate()

  const thread = holder.thread
  if (!thread) {
    return { status: 'rejected', reason: 'missing-word' }
  }
  return { status: 'created', thread }
}

type PackArticleRow = SentenceItemRow & {
  entry_id: string
  entry_main_form: string
  note_count: number
  sentence_count: number
  article_count: number
}

/**
 * 「把本篇未整理学习内容的词打包问模型」：
 * - 只认本文的 entry_sentence，按段落 / 句序 / 字区间第一次出现的顺序去重词条；
 * - 只打包 live `noteCount === 0` 的词（置顶学习内容也算已整理）；
 * - 上下文是每个词 + 它在本文对应到的全部原句，绝不使用别篇最近收的那句；
 * - 超过 20 个时明确报告没带上的数量，不在服务端假装全带上了；
 * - 没有可打包的词时不建空线程，交给界面温和提示。
 */
export function packArticleUnorganizedWords(
  database: AppDatabase,
  request: PackArticleWordsRequest,
  options: { now?: string } = {}
): PackArticleWordsResult {
  const article = database
    .prepare('SELECT 1 FROM article WHERE id = ?')
    .get(request.articleId)
  if (article === undefined) {
    return { status: 'missing' }
  }

  const rows = database
    .prepare(
      `SELECT es.entry_id, ${SENTENCE_ITEM_SELECT},
              we.main_form AS entry_main_form,
              (SELECT COUNT(*) FROM learning_note ln WHERE ln.entry_id = es.entry_id) AS note_count,
              (SELECT COUNT(*) FROM entry_sentence x WHERE x.entry_id = es.entry_id) AS sentence_count,
              (SELECT COUNT(DISTINCT x.article_id) FROM entry_sentence x
                WHERE x.entry_id = es.entry_id) AS article_count
         FROM entry_sentence es
         ${SENTENCE_ITEM_JOINS}
         JOIN word_entry we ON we.id = es.entry_id
        WHERE es.article_id = ?
        ORDER BY p.ordinal, es.sentence_ordinal, es.char_start, es.id`
    )
    .all(request.articleId) as PackArticleRow[]

  const ordered: { row: PackArticleRow; sentences: PackArticleRow[] }[] = []
  const byEntry = new Map<string, { row: PackArticleRow; sentences: PackArticleRow[] }>()
  for (const row of rows) {
    let group = byEntry.get(row.entry_id)
    if (group === undefined) {
      group = { row, sentences: [] }
      byEntry.set(row.entry_id, group)
      ordered.push(group)
    }
    group.sentences.push(row)
  }

  if (ordered.length === 0) {
    return { status: 'empty', reason: 'no-words', totalCount: 0 }
  }

  const unorganized = ordered.filter((group) => group.row.note_count === 0)
  if (unorganized.length === 0) {
    return { status: 'empty', reason: 'all-organized', totalCount: 0 }
  }

  const packed = unorganized.slice(0, GROUP_WORD_LIMIT)
  const context: ThreadContextItem[] = []
  const seen = new Set<string>()
  for (const group of packed) {
    const word = toWordItem(
      group.row.entry_id,
      group.row.entry_main_form,
      group.row.sentence_count,
      group.row.article_count
    )
    if (!seen.has(word.id)) {
      seen.add(word.id)
      context.push(word)
    }
    for (const sentence of group.sentences) {
      const item = toSentenceItem(sentence)
      if (!seen.has(item.id)) {
        seen.add(item.id)
        context.push(item)
      }
    }
  }

  const now = nowOf(options)
  const holder: { thread: ChatThreadView | null } = { thread: null }
  database
    .transaction(() => {
      holder.thread = insertContextThread(database, {
        title: groupTitleOf(packed.map((group) => group.row.entry_main_form)),
        context,
        now
      })
    })
    .immediate()

  const thread = holder.thread
  if (thread === null) {
    return { status: 'missing' }
  }
  return {
    status: 'created',
    thread,
    packedCount: packed.length,
    totalCount: unorganized.length,
    omittedCount: unorganized.length - packed.length
  }
}

/** 查找与主对象完全相同、最近更新的线程；空白线程不复用。 */
export function findRecentThreadForMain(
  database: AppDatabase,
  main: CreateThreadRequest['main']
): ChatThreadView | null {
  const mainId = mainIdOf(main)
  if (mainId === null || describeMain(database, main.kind, mainId).kind === 'none') return null
  const row = database
    .prepare(
      `SELECT id FROM thread WHERE main_kind = ? AND main_id = ?
       ORDER BY updated_at DESC, created_at DESC, rowid DESC LIMIT 1`
    )
    .get(main.kind, mainId) as { id: string } | undefined
  return row ? readThreadView(database, row.id) : null
}

/** 查找与创建在同一写事务里，连续请求不会各自创建一条。 */
export function openThreadForMain(
  database: AppDatabase,
  request: OpenThreadForMainRequest,
  options: { now?: string } = {}
): OpenThreadForMainResult {
  return database.transaction(() => {
    const mainId = mainIdOf(request.main)
    if (request.main.kind !== 'none' && describeMain(database, request.main.kind, mainId).kind === 'none') {
      return { status: 'rejected', reason: 'missing-main' } as const
    }
    if (!request.forceNew) {
      const existing = findRecentThreadForMain(database, request.main)
      if (existing) {
        if (request.ensureSentenceContext && existing.main.kind === 'sentence') {
          const present = new Set(existing.context.map((item) => item.id))
          const missing = defaultContext(database, existing.main).filter((item) => !present.has(item.id))
          if (missing.length > 0) {
            if (existing.context.length + missing.length > CONTEXT_LIMIT) {
              return { status: 'rejected', reason: 'context-full' } as const
            }
            const result = updateThreadContext(database, {
              threadId: existing.id,
              items: [...existing.context, ...missing]
            }, options)
            if (result.status === 'saved') return { status: 'reused', thread: result.thread } as const
            if (result.status === 'rejected') {
              return { status: 'rejected', reason: 'context-full' } as const
            }
          }
        }
        return { status: 'reused', thread: existing } as const
      }
    }
    return createThread(database, request, options)
  }).immediate()
}

export function updateThreadContext(
  database: AppDatabase,
  request: UpdateThreadContextRequest,
  options: { now?: string } = {}
): UpdateThreadContextResult {
  if (!readThreadRow(database, request.threadId)) {
    return { status: 'missing' }
  }
  const items = deduplicateArticleContext(sanitizeContextItems(request.items))
  if (wordItemCount(items) > GROUP_WORD_LIMIT) {
    return { status: 'rejected', reason: 'too-many-words' }
  }
  database
    .prepare('UPDATE thread SET context_json = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(items), nowOf(options), request.threadId)
  const thread = readThreadView(database, request.threadId)
  return thread ? { status: 'saved', thread } : { status: 'missing' }
}

function insertQuestion(
  database: AppDatabase,
  input: {
    thread: ThreadRow
    parentId: string | null
    text: string
    context: ThreadContextItem[]
    now: string
  }
): QuestionResult {
  const context = input.context
  const firstQuestion =
    database
      .prepare(
        `SELECT 1 FROM thread_entry
          WHERE thread_id = ? AND kind = 'question' LIMIT 1`
      )
      .get(input.thread.id) === undefined
  const id = insertEntry(database, {
    threadId: input.thread.id,
    parentId: input.parentId,
    kind: 'question',
    payload: { text: input.text, context },
    now: input.now
  })
  const title =
    input.thread.main_kind === 'none' && firstQuestion
      ? titleFromQuestion(input.text)
      : input.thread.title
  database
    .prepare(
      `UPDATE thread
          SET leaf_entry_id = ?, context_json = ?, title = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(id, JSON.stringify(context), title, input.now, input.thread.id)
  const thread = readThreadView(database, input.thread.id)
  return thread ? { status: 'asked', questionId: id, thread } : { status: 'missing' }
}

export function askQuestion(
  database: AppDatabase,
  request: AskThreadRequest,
  options: { now?: string } = {}
): QuestionResult {
  const thread = readThreadRow(database, request.threadId)
  if (!thread) {
    return { status: 'missing' }
  }
  const text = request.text.trim()
  if (text === '') {
    return { status: 'rejected', reason: 'empty' }
  }
  const context =
    request.context === undefined
      ? hydrateLegacyArticles(database, parseContextJson(thread.context_json))
      : deduplicateArticleContext(hydrateLegacyArticles(database, sanitizeContextItems(request.context)))
  if (wordItemCount(context) > GROUP_WORD_LIMIT) {
    return { status: 'rejected', reason: 'too-many-words' }
  }

  return insertQuestion(database, {
    thread,
    parentId: validParent(database, thread.id, thread.leaf_entry_id),
    text,
    context,
    now: nowOf(options)
  })
}

function validParent(
  database: AppDatabase,
  threadId: string,
  entryId: string | null
): string | null {
  if (entryId === null) {
    return null
  }
  const row = database
    .prepare('SELECT id FROM thread_entry WHERE id = ? AND thread_id = ?')
    .get(entryId, threadId) as { id: string } | undefined
  return row ? row.id : null
}

function readEntryRow(
  database: AppDatabase,
  threadId: string,
  entryId: string
): ThreadEntryRow | undefined {
  return database
    .prepare(
      `SELECT rowid AS row_id, id, parent_id, kind, payload, created_at
         FROM thread_entry WHERE id = ? AND thread_id = ?`
    )
    .get(entryId, threadId) as ThreadEntryRow | undefined
}

function readAttemptEntry(
  database: AppDatabase,
  attemptId: string
): AttemptEntryRow | undefined {
  return database
    .prepare(
      `SELECT thread_id, parent_id, kind, payload
         FROM thread_entry WHERE id = ?`
    )
    .get(attemptEntryId(attemptId)) as AttemptEntryRow | undefined
}

function attemptEntryId(attemptId: string): string {
  return `attempt:${attemptId}`
}

function attemptIdOf(request: { attemptId?: string }): string | null {
  const value = request.attemptId?.trim()
  return value ? value : null
}

function sameAttemptPayload(
  existing: AttemptEntryRow,
  request: SaveAnswerRequest | SaveContinuationRequest
): boolean {
  return (
    existing.payload ===
    JSON.stringify(
      answerPayloadOfRequest(
        request.text,
        request.thinking,
        request.thinkingMs,
        request.phase,
        request.error,
        request.model
      )
    )
  )
}

/** 这条已存在的续写是否确实挂在这次请求的 answer 根下面。 */
function continuationUnderAnswer(
  database: AppDatabase,
  threadId: string,
  parentId: string | null,
  answerId: string
): boolean {
  let cursor = parentId
  const seen = new Set<string>()
  while (cursor !== null && !seen.has(cursor)) {
    if (cursor === answerId) return true
    seen.add(cursor)
    const row = readEntryRow(database, threadId, cursor)
    if (!row || row.kind === 'question') return false
    cursor = row.parent_id
  }
  return false
}

function answerPayloadOfRequest(
  text: string,
  thinking: string,
  thinkingMs: number | undefined,
  phase: AnswerPhase,
  error: ChatError | null | undefined,
  model: string | undefined
): AnswerPayload {
  return {
    text,
    thinking,
    thinkingMs: thinkingMs === undefined ? 0 : Math.max(0, Math.round(thinkingMs)),
    phase,
    error: error ?? null,
    model: model?.trim() ?? ''
  }
}

export function saveAnswer(
  database: AppDatabase,
  request: SaveAnswerRequest,
  options: { now?: string } = {}
): SaveAnswerResult {
  const thread = readThreadRow(database, request.threadId)
  if (!thread) {
    return { status: 'missing' }
  }
  const question = readEntryRow(database, request.threadId, request.questionId)
  if (!question || question.kind !== 'question') {
    return { status: 'rejected', reason: 'question' }
  }

  const attemptId = attemptIdOf(request)
  if (attemptId !== null) {
    const existing = readAttemptEntry(database, attemptId)
    if (existing) {
      // 同一个 attempt 只能对应同一 thread / 同一问 / 同一份 payload；
      // 冲突绝不覆盖已有不可变条目。
      if (
        existing.thread_id !== request.threadId ||
        existing.kind !== 'answer' ||
        existing.parent_id !== question.id ||
        !sameAttemptPayload(existing, request)
      ) {
        return { status: 'rejected', reason: 'conflict' }
      }
      const view = readThreadView(database, request.threadId)
      return view ? { status: 'saved', thread: view } : { status: 'missing' }
    }
  }

  const now = nowOf(options)
  const id = insertEntry(database, {
    ...(attemptId === null ? {} : { id: attemptEntryId(attemptId) }),
    threadId: request.threadId,
    parentId: question.id,
    kind: 'answer',
    payload: answerPayloadOfRequest(
      request.text,
      request.thinking,
      request.thinkingMs,
      request.phase,
      request.error,
      request.model
    ),
    now
  })
  setLeaf(database, request.threadId, id, now)
  const view = readThreadView(database, request.threadId)
  return view ? { status: 'saved', thread: view } : { status: 'missing' }
}

/**
 * 从一条条目往下走到这一支的最后：默认取最新子条目（切分支用），
 * 只取 continuation 时用于找继续生成的尾巴。环状数据停在原地。
 */
function descendToLatestChild(
  database: AppDatabase,
  threadId: string,
  startId: string,
  kind?: ThreadEntryKind
): string {
  const latest =
    kind === undefined
      ? database.prepare(
          `SELECT id FROM thread_entry
            WHERE thread_id = ? AND parent_id = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
      : database.prepare(
          `SELECT id FROM thread_entry
            WHERE thread_id = ? AND parent_id = ? AND kind = ?
            ORDER BY created_at DESC, rowid DESC LIMIT 1`
        )
  let cursor = startId
  const seen = new Set<string>()
  for (;;) {
    if (seen.has(cursor)) return cursor
    seen.add(cursor)
    const child = (
      kind === undefined ? latest.get(threadId, cursor) : latest.get(threadId, cursor, kind)
    ) as { id: string } | undefined
    if (!child) {
      return cursor
    }
    cursor = child.id
  }
}

/** 继续生成接在当前回答这一路的最后一段后面，不产生新的版本。 */
export function saveContinuation(
  database: AppDatabase,
  request: SaveContinuationRequest,
  options: { now?: string } = {}
): SaveAnswerResult {
  const thread = readThreadRow(database, request.threadId)
  if (!thread) {
    return { status: 'missing' }
  }
  const answer = readEntryRow(database, request.threadId, request.answerId)
  if (!answer || answer.kind !== 'answer') {
    return { status: 'rejected', reason: 'answer' }
  }

  const attemptId = attemptIdOf(request)
  if (attemptId !== null) {
    const existing = readAttemptEntry(database, attemptId)
    if (existing) {
      if (
        existing.thread_id !== request.threadId ||
        existing.kind !== 'continuation' ||
        !continuationUnderAnswer(database, request.threadId, existing.parent_id, answer.id) ||
        !sameAttemptPayload(existing, request)
      ) {
        return { status: 'rejected', reason: 'conflict' }
      }
      const view = readThreadView(database, request.threadId)
      return view ? { status: 'saved', thread: view } : { status: 'missing' }
    }
  }

  const now = nowOf(options)
  const parentId = descendToLatestChild(database, request.threadId, answer.id, 'continuation')
  const id = insertEntry(database, {
    ...(attemptId === null ? {} : { id: attemptEntryId(attemptId) }),
    threadId: request.threadId,
    parentId,
    kind: 'continuation',
    payload: answerPayloadOfRequest(
      request.text,
      request.thinking,
      request.thinkingMs,
      request.phase,
      request.error,
      request.model
    ),
    now
  })
  setLeaf(database, request.threadId, id, now)
  const view = readThreadView(database, request.threadId)
  return view ? { status: 'saved', thread: view } : { status: 'missing' }
}

export function editQuestion(
  database: AppDatabase,
  request: EditQuestionRequest,
  options: { now?: string } = {}
): QuestionResult {
  const thread = readThreadRow(database, request.threadId)
  if (!thread) {
    return { status: 'missing' }
  }
  const original = readEntryRow(database, request.threadId, request.questionId)
  if (!original || original.kind !== 'question') {
    return { status: 'missing' }
  }
  const text = request.text.trim()
  if (text === '') {
    return { status: 'rejected', reason: 'empty' }
  }
  const context =
    request.context === undefined
      ? hydrateLegacyArticles(database, parseContextJson(thread.context_json))
      : deduplicateArticleContext(hydrateLegacyArticles(database, sanitizeContextItems(request.context)))
  if (wordItemCount(context) > GROUP_WORD_LIMIT) {
    return { status: 'rejected', reason: 'too-many-words' }
  }

  // 新提问挂在原来那条的父条目下：同一位置多出一个版本，原回答整支仍在库里。
  return insertQuestion(database, {
    thread,
    parentId: original.parent_id,
    text,
    context,
    now: nowOf(options)
  })
}

export function switchQuestion(
  database: AppDatabase,
  request: SwitchQuestionRequest,
  options: { now?: string } = {}
): SwitchThreadResult {
  const thread = readThreadRow(database, request.threadId)
  if (!thread) {
    return { status: 'missing' }
  }
  const question = readEntryRow(database, request.threadId, request.questionId)
  if (!question || question.kind !== 'question') {
    return { status: 'rejected', reason: 'question' }
  }
  setLeaf(
    database,
    request.threadId,
    descendToLatestChild(database, request.threadId, question.id),
    nowOf(options)
  )
  const view = readThreadView(database, request.threadId)
  return view ? { status: 'switched', thread: view } : { status: 'missing' }
}

export function switchAnswer(
  database: AppDatabase,
  request: SwitchAnswerRequest,
  options: { now?: string } = {}
): SwitchThreadResult {
  const thread = readThreadRow(database, request.threadId)
  if (!thread) {
    return { status: 'missing' }
  }
  const answer = readEntryRow(database, request.threadId, request.answerId)
  if (!answer || answer.kind !== 'answer' || answer.parent_id !== request.questionId) {
    return { status: 'rejected', reason: 'answer' }
  }
  setLeaf(
    database,
    request.threadId,
    descendToLatestChild(database, request.threadId, answer.id),
    nowOf(options)
  )
  const view = readThreadView(database, request.threadId)
  return view ? { status: 'switched', thread: view } : { status: 'missing' }
}

/**
 * 「存为文章」要读的那一份回答：沿用这里的条目日志与回答聚合，不在文章服务里
 * 重走一遍分支。正文是这一版根回答加它的继续生成，思维链不进来；
 * `questionContext` 是提这一问时存下的不可变上下文快照——线程后来增删上下文不影响它，
 * 来源词只认这一份。
 */
export type AnswerForArticle = {
  text: string
  /** 与 ThreadAnswer 相同的聚合语义：根回答加继续生成，最后一段决定完成状态。 */
  phase: AnswerPhase
  error: ChatError | null
  questionContext: ThreadContextItem[]
}

/** 从根回答顺着继续生成走到这一路的末尾；日志按时间排，最后一个子条目是最新的。 */
function continuationChain(
  database: AppDatabase,
  threadId: string,
  answer: ThreadEntryRow,
  entries?: readonly ThreadEntryRow[]
): ThreadEntryRow[] {
  const rows = entries ?? readThreadEntries(database, threadId)
  const chain = [answer]
  const seen = new Set([answer.id])
  let cursor = answer
  for (;;) {
    const next = rows
      .filter((row) => row.kind === 'continuation' && row.parent_id === cursor.id)
      .at(-1)
    if (!next || seen.has(next.id)) {
      return chain
    }
    seen.add(next.id)
    chain.push(next)
    cursor = next
  }
}

export function readAnswerForArticle(
  database: AppDatabase,
  threadId: string,
  answerId: string
): AnswerForArticle | null {
  if (!readThreadRow(database, threadId)) {
    return null
  }
  const answer = readEntryRow(database, threadId, answerId)
  if (!answer || answer.kind !== 'answer' || answer.parent_id === null) {
    return null
  }
  const question = readEntryRow(database, threadId, answer.parent_id)
  if (!question || question.kind !== 'question') {
    return null
  }

  const entries = readThreadEntries(database, threadId)
  const aggregated = buildAnswer(
    entries,
    continuationChain(database, threadId, answer, entries),
    question.id
  )
  if (aggregated === null) {
    return null
  }
  return {
    text: aggregated.text,
    phase: aggregated.phase,
    error: aggregated.error,
    questionContext: questionPayloadOf(question).context
  }
}

/** 这一问提出来时带了哪些词条（不可变快照）；来源词只从这里取。 */
export function wordEntryIdsOfQuestion(
  questionContext: readonly ThreadContextItem[]
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of questionContext) {
    const entryId = wordContextEntryId(item)
    if (entryId === null || seen.has(entryId)) continue
    seen.add(entryId)
    ids.push(entryId)
  }
  return ids
}

/**
 * 这次还能往上下文里加什么：词条与原句线程给这个词的原句、所在段落与学习内容，
 * 文章线程给这篇的原句、全部段落与这些词的学习内容。已经带上的不再列出。
 */
export function readContextCandidates(
  database: AppDatabase,
  threadId: string
): ThreadContextCandidates {
  const thread = readThreadRow(database, threadId)
  if (!thread) {
    return { items: [], articles: [], libraryItems: [] }
  }
  const main = describeMain(database, thread.main_kind as ThreadMainKind, thread.main_id)
  const context = parseContextJson(thread.context_json)
  const included = new Set(context.map((item) => item.id))

  const candidates: ThreadContextItem[] = []
  const seen = new Set<string>()
  const push = (item: ThreadContextItem | null): void => {
    if (!item || included.has(item.id) || seen.has(item.id)) return
    seen.add(item.id)
    candidates.push(item)
  }

  if (main.kind === 'entry' || main.kind === 'sentence') {
    push(wordItem(database, main.entryId))
    for (const item of sentenceItemsOfEntry(database, main.entryId)) push(item)
    const articleIds = database.prepare('SELECT DISTINCT article_id FROM entry_sentence WHERE entry_id = ?').all(main.entryId) as { article_id: string }[]
    for (const { article_id } of articleIds) {
      push(articleItem(database, article_id))
      for (const item of paragraphItemsOfArticle(database, article_id)) push(item)
    }
    for (const item of noteItemsOfEntry(database, main.entryId)) push(item)
  } else if (main.kind === 'article') {
    push(articleItem(database, main.articleId))
    for (const item of sentenceItemsOfArticle(database, main.articleId)) push(item)
    for (const item of paragraphItemsOfArticle(database, main.articleId)) push(item)
    for (const item of noteItemsOfArticle(database, main.articleId)) push(item)
  } else {
    // 空白与组词线程（主对象为空）：候选是库里全部词条，加上已带上的词的原句、
    // 段落与学习内容。这样自由学习能加词、组词线程能补更多原句，移除的词也能加回来。
    for (const item of libraryWordItems(database)) push(item)
    for (const item of context) {
      const entryId = wordContextEntryId(item)
      if (entryId === null) continue
      for (const nested of sentenceItemsOfEntry(database, entryId)) push(nested)
      for (const nested of paragraphItemsOfEntry(database, entryId)) push(nested)
      for (const nested of noteItemsOfEntry(database, entryId)) push(nested)
    }
  }

  const articles = database.prepare('SELECT id, title FROM article ORDER BY title, id').all() as { id: string; title: string }[]
  const libraryItems: ThreadContextItem[] = []
  for (const word of libraryWordItems(database)) {
    libraryItems.push(word)
    const entryId = wordContextEntryId(word)
    if (entryId !== null) {
      libraryItems.push(...sentenceItemsOfEntry(database, entryId), ...noteItemsOfEntry(database, entryId))
    }
  }
  return { items: candidates, articles, libraryItems }
}

/** 仅在展开文章时读取正文，避免打开面板时传输整座文章库。 */
export function readArticleContextMaterials(database: AppDatabase, articleId: string): ArticleContextMaterials {
  return { article: articleItem(database, articleId), paragraphs: paragraphItemsOfArticle(database, articleId) }
}
