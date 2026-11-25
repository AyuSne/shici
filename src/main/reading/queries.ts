import type {
  ReadingAnnotation,
  ReadingParagraph,
  ReadingPreferences,
  ReadingPreferencesResult,
  ReadingProgressRequest,
  ReadingProgressResult,
  ReadingSentence,
  ReadingSettings,
  ReadingSettingsRequest,
  ReadingSettingsResult,
  ReadingView
} from '../../shared/reading'
import {
  DEFAULT_READING_PREFERENCES,
  isReadingFontSize,
  isReadingLineHeight,
  READING_FONT_SIZES,
  READING_LINE_HEIGHTS
} from '../../shared/reading'
import type { AppDatabase } from '../db/database'
import { readSetting, writeSetting } from '../db/settings'
import { paragraphLetter } from '../corpus/letter'
import { readArticleCollections } from '../entries/queries'
import { openArticle, readArticleDetail, readReadingPoint } from '../library/queries'
import { readReadingGlobalPreferences } from './global-preferences'
import { readArticlePreviouslyCollectedCount } from './known-words'

/**
 * 阅读设置的键。全局默认存在 setting 表；本篇覆盖存在 article_reading_setting。
 * 本篇整份覆盖全局，不从全局逐项继承——面板上「来自全局 / 本篇」只区分这两种来源。
 */
const SETTING_KEYS = {
  fontSize: 'reading.fontSize',
  lineHeight: 'reading.lineHeight',
  annotationsVisible: 'reading.annotationsVisible',
  weakHighlight: 'reading.weakHighlight'
} as const

type ArticleSettingRow = {
  font_size: number
  line_height_tenths: number
  annotations_visible: number
  weak_highlight: number
}

type ParagraphRow = {
  id: string
  ordinal: number
  text: string
  page_start: number | null
  page_end: number | null
}

type SentenceRow = {
  paragraph_id: string
  ordinal: number
  text: string
  char_start: number
  char_end: number
  page: number | null
}

type AnnotationRow = {
  paragraph_id: string
  sentence_ordinal: number
  surface: string
  gloss: string
  char_start: number
  char_end: number
}

function parseFontSize(value: string | null): ReadingPreferences['fontSize'] {
  const fontSize = Number(value)
  return isReadingFontSize(fontSize) ? fontSize : DEFAULT_READING_PREFERENCES.fontSize
}

function parseLineHeight(value: string | null): ReadingPreferences['lineHeight'] {
  const lineHeight = Number(value)
  return isReadingLineHeight(lineHeight)
    ? lineHeight
    : DEFAULT_READING_PREFERENCES.lineHeight
}

function parseBooleanSetting(value: string | null, fallback: boolean): boolean {
  if (value === '1' || value === 'true') {
    return true
  }
  if (value === '0' || value === 'false') {
    return false
  }
  return fallback
}

/** 本机全局默认。没设置过或值不认识时逐项回落到产品说明里的默认值。 */
export function readReadingPreferences(database: AppDatabase): ReadingPreferences {
  return {
    fontSize: parseFontSize(readSetting(database, SETTING_KEYS.fontSize)),
    lineHeight: parseLineHeight(readSetting(database, SETTING_KEYS.lineHeight)),
    annotationsVisible: parseBooleanSetting(
      readSetting(database, SETTING_KEYS.annotationsVisible),
      DEFAULT_READING_PREFERENCES.annotationsVisible
    ),
    weakHighlight: parseBooleanSetting(
      readSetting(database, SETTING_KEYS.weakHighlight),
      DEFAULT_READING_PREFERENCES.weakHighlight
    )
  }
}

function isReadingPreferences(value: ReadingPreferences): boolean {
  return (
    isReadingFontSize(value.fontSize) &&
    isReadingLineHeight(value.lineHeight) &&
    typeof value.annotationsVisible === 'boolean' &&
    typeof value.weakHighlight === 'boolean'
  )
}

/**
 * 设置页存的全局默认。只写 setting 表，不碰任何一篇的覆盖值：
 * 已按篇调过的文章继续用自己那份，没调过的文章下次打开跟着新默认走。
 */
export function saveReadingPreferences(
  database: AppDatabase,
  preferences: ReadingPreferences
): ReadingPreferencesResult {
  if (!isReadingPreferences(preferences)) {
    return { saved: false, preferences: readReadingPreferences(database) }
  }

  const write = database.transaction(() => {
    writeSetting(database, SETTING_KEYS.fontSize, String(preferences.fontSize))
    writeSetting(database, SETTING_KEYS.lineHeight, String(preferences.lineHeight))
    writeSetting(database, SETTING_KEYS.annotationsVisible, preferences.annotationsVisible ? '1' : '0')
    writeSetting(database, SETTING_KEYS.weakHighlight, preferences.weakHighlight ? '1' : '0')
  })
  write()

  return { saved: true, preferences: readReadingPreferences(database) }
}

function articleExists(database: AppDatabase, articleId: string): boolean {
  return (
    database.prepare('SELECT 1 FROM article WHERE id = ?').get(articleId) !== undefined
  )
}

function readArticleSettingRow(
  database: AppDatabase,
  articleId: string
): ArticleSettingRow | undefined {
  return database
    .prepare(
      `SELECT font_size, line_height_tenths, annotations_visible, weak_highlight
       FROM article_reading_setting WHERE article_id = ?`
    )
    .get(articleId) as ArticleSettingRow | undefined
}

/** 本篇生效的阅读设置；调用前须确认文章存在。 */
function effectiveReadingSettings(
  database: AppDatabase,
  articleId: string
): ReadingSettings {
  const row = readArticleSettingRow(database, articleId)
  if (!row) {
    return { ...readReadingPreferences(database), source: 'global' }
  }

  const fontSizes: readonly number[] = READING_FONT_SIZES
  const lineHeightTenths = READING_LINE_HEIGHTS.map((height) => Math.round(height * 10))
  const valid =
    fontSizes.includes(row.font_size) &&
    lineHeightTenths.includes(row.line_height_tenths) &&
    (row.annotations_visible === 0 || row.annotations_visible === 1) &&
    (row.weak_highlight === 0 || row.weak_highlight === 1)
  if (!valid) {
    // 库里的值只该由这里写入；真坏掉时宁可回落全局，也不把界面打乱。
    return { ...readReadingPreferences(database), source: 'global' }
  }

  return {
    fontSize: row.font_size as ReadingPreferences['fontSize'],
    lineHeight: (row.line_height_tenths / 10) as ReadingPreferences['lineHeight'],
    annotationsVisible: row.annotations_visible === 1,
    weakHighlight: row.weak_highlight === 1,
    source: 'article'
  }
}

/** 本篇生效的阅读设置；文章不存在时返回 null。 */
export function readReadingSettings(
  database: AppDatabase,
  articleId: string
): ReadingSettings | null {
  if (!articleExists(database, articleId)) {
    return null
  }
  return effectiveReadingSettings(database, articleId)
}

/**
 * 记住这一篇的设置。值不合法时不写入，返回当前生效值；文章不存在时返回 null。
 * 全局默认不受影响。
 */
export function saveReadingSettings(
  database: AppDatabase,
  request: ReadingSettingsRequest
): ReadingSettingsResult | null {
  const current = readReadingSettings(database, request.articleId)
  if (current === null) {
    return null
  }

  const { preferences } = request
  if (!isReadingPreferences(preferences)) {
    return { saved: false, settings: current }
  }

  database
    .prepare(
      `INSERT INTO article_reading_setting (
         article_id, font_size, line_height_tenths, annotations_visible, weak_highlight
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (article_id) DO UPDATE SET
         font_size = excluded.font_size,
         line_height_tenths = excluded.line_height_tenths,
         annotations_visible = excluded.annotations_visible,
         weak_highlight = excluded.weak_highlight,
         updated_at = datetime('now')`
    )
    .run(
      request.articleId,
      preferences.fontSize,
      Math.round(preferences.lineHeight * 10),
      preferences.annotationsVisible ? 1 : 0,
      preferences.weakHighlight ? 1 : 0
    )

  return {
    saved: true,
    settings: effectiveReadingSettings(database, request.articleId)
  }
}

/**
 * 长篇匹配按原卷字母显示段首；仔细阅读不显示。语料约定段落 id 就是 A–P 的字母，
 * 万一 id 不是字母，按段序补一个；超过 P 的段不再编号，不发明原卷没有的字母。
 */
function groupByParagraph<T extends { paragraph_id: string }>(
  rows: readonly T[],
  paragraphOrder: readonly string[]
): Map<string, T[]> {
  const grouped = new Map<string, T[]>()
  for (const paragraphId of paragraphOrder) {
    grouped.set(paragraphId, [])
  }
  for (const row of rows) {
    grouped.get(row.paragraph_id)?.push(row)
  }
  return grouped
}

/**
 * 阅读页的一份完整视图：文章元信息、按段组织的句子与原文注释、生效设置、上次位置。
 * 只读，不记「最近打开」；打开动作见 openReadingView。
 */
export function readReadingView(database: AppDatabase, articleId: string): ReadingView | null {
  const article = readArticleDetail(database, articleId)
  if (!article) {
    return null
  }

  const paragraphRows = database
    .prepare(
      `SELECT id, ordinal, text, page_start, page_end
       FROM paragraph WHERE article_id = ? ORDER BY ordinal`
    )
    .all(articleId) as ParagraphRow[]

  const sentenceRows = database
    .prepare(
      `SELECT paragraph_id, ordinal, text, char_start, char_end, page
       FROM sentence WHERE article_id = ? ORDER BY paragraph_id, ordinal`
    )
    .all(articleId) as SentenceRow[]

  const annotationRows = database
    .prepare(
      `SELECT paragraph_id, sentence_ordinal, surface, gloss, char_start, char_end
       FROM annotation WHERE article_id = ? ORDER BY ordinal`
    )
    .all(articleId) as AnnotationRow[]

  const paragraphOrder = paragraphRows.map((paragraph) => paragraph.id)
  const sentences = groupByParagraph(sentenceRows, paragraphOrder)
  const annotations = groupByParagraph(annotationRows, paragraphOrder)

  const paragraphs = paragraphRows.map((paragraph): ReadingParagraph => {
    const readingSentences = (sentences.get(paragraph.id) ?? []).map(
      (sentence): ReadingSentence => ({
        ordinal: sentence.ordinal,
        text: sentence.text,
        start: sentence.char_start,
        end: sentence.char_end,
        page: sentence.page
      })
    )
    const readingAnnotations = (annotations.get(paragraph.id) ?? []).map(
      (annotation): ReadingAnnotation => ({
        surface: annotation.surface,
        gloss: annotation.gloss,
        start: annotation.char_start,
        end: annotation.char_end,
        sentenceOrdinal: annotation.sentence_ordinal
      })
    )

    return {
      id: paragraph.id,
      ordinal: paragraph.ordinal,
      letter: paragraphLetter(article.kind, paragraph.id, paragraph.ordinal),
      text: paragraph.text,
      pageStart: paragraph.page_start,
      pageEnd: paragraph.page_end,
      sentences: readingSentences,
      annotations: readingAnnotations
    }
  })

  return {
    article,
    paragraphs,
    settings: effectiveReadingSettings(database, articleId),
    globalPreferences: readReadingGlobalPreferences(database),
    knownWordCount: readArticlePreviouslyCollectedCount(database, articleId),
    readingPoint: readReadingPoint(database, articleId),
    collected: readArticleCollections(database, articleId)
  }
}

/** 打开一篇原文：记下最近打开，首次打开停在第一句，然后返回整份视图。 */
export function openReadingView(
  database: AppDatabase,
  articleId: string,
  options: { now?: string } = {}
): ReadingView | null {
  const opened = openArticle(database, articleId, options)
  if (!opened.opened) {
    return null
  }
  return readReadingView(database, articleId)
}

/**
 * 记下读到哪。段落与句子必须属于这篇；调用方在滚动中节流调用，从不合法位置
 * 回来只回 saved:false，不改库。
 */
export function saveReadingPoint(
  database: AppDatabase,
  request: ReadingProgressRequest,
  options: { now?: string } = {}
): ReadingProgressResult {
  if (!Number.isInteger(request.sentenceOrdinal) || request.sentenceOrdinal < 0) {
    return { saved: false }
  }

  const sentence = database
    .prepare(
      'SELECT 1 FROM sentence WHERE article_id = ? AND paragraph_id = ? AND ordinal = ?'
    )
    .get(request.articleId, request.paragraphId, request.sentenceOrdinal)
  if (sentence === undefined) {
    return { saved: false }
  }

  const now = options.now ?? new Date().toISOString()
  const updated = database
    .prepare(
      `UPDATE article SET last_paragraph_id = ?, last_sentence_index = ?, last_opened_at = ?
       WHERE id = ?`
    )
    .run(request.paragraphId, request.sentenceOrdinal, now, request.articleId)

  return { saved: updated.changes > 0 }
}
