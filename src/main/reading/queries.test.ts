import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureArticle, writeCorpusDirectory } from '../../testing/corpus-fixture'
import { importCorpus } from '../corpus/import'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { writeSetting } from '../db/settings'
import { createLearningNote, pinLearningNote } from '../entries/notes'
import { collectSelection, deleteEntrySentence } from '../entries/queries'
import { markArticleCompleted, readHomeSummary } from '../library/queries'
import {
  openReadingView,
  readReadingPreferences,
  readReadingSettings,
  readReadingView,
  saveReadingPoint,
  saveReadingPreferences,
  saveReadingSettings
} from './queries'

let directory: string
let database: AppDatabase

const carefulReading = fixtureArticle({
  id: 'fixture-2024-06-s1-c1',
  year: 2024,
  month: 6,
  set: 1,
  sentences: [
    ['Reading widely makes hard sentences easier.', 'Context carries most of the meaning.'],
    ['A steady habit keeps the reading going.']
  ],
  annotations: [{ surface: 'Context', gloss: '语境', paragraph: 0, sentence: 1 }]
})

const longMatch = fixtureArticle({
  id: 'fixture-2024-06-s2-b',
  year: 2024,
  month: 6,
  set: 2,
  kind: 'long_match',
  sentences: [
    ['Employers approach hiring differently.', 'Skills matter more than degrees.'],
    ['Practice interviews keep nerves steady.']
  ]
})

const olderReading = fixtureArticle({
  id: 'fixture-2023-12-s1-c1',
  year: 2023,
  month: 12,
  set: 1,
  sentences: [[
    'Old passages still repay a visit.',
    'Review begins with the sentence.',
    'A quiet hour of reading repays the visit.',
    'A hard sentence rewards a slow reading.'
  ]]
})

// 段落 id 不是字母的长篇匹配：段首字母按段序补，超过 P 的段不编号。
const numericLongMatch = fixtureArticle({
  id: 'fixture-2024-06-s3-b',
  year: 2024,
  month: 6,
  set: 3,
  kind: 'long_match',
  sentences: Array.from({ length: 17 }, (_value, index) => [
    `Numeric paragraph ${index + 1} keeps its place in the passage.`
  ])
})
numericLongMatch.json.paragraphs = (
  numericLongMatch.json.paragraphs as { id: string }[]
).map((paragraph, index) => ({ ...paragraph, id: String(index + 1) }))

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-reading-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
  writeCorpusDirectory(directory, [carefulReading, longMatch, olderReading, numericLongMatch])
  importCorpus(database, { directory })
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** 在给定段落、句子与词形上构造一次选词请求。 */
function collectWord(
  articleId: string,
  paragraphId: string,
  paragraphText: string,
  sentenceOrdinal: number,
  word: string,
  now = '2026-11-18T08:00:00.000Z'
) {
  const start = paragraphText.indexOf(word)
  return collectSelection(
    database,
    { articleId, paragraphId, sentenceOrdinal, start, end: start + word.length },
    { now }
  )
}

describe('readReadingPreferences', () => {
  it('没设置过时用产品说明里的默认值', () => {
    expect(readReadingPreferences(database)).toEqual({
      fontSize: 20,
      lineHeight: 1.8,
      annotationsVisible: true,
      weakHighlight: true
    })
  })

  it('读全局设置，无法识别的值逐项回落到默认', () => {
    writeSetting(database, 'reading.fontSize', '22')
    writeSetting(database, 'reading.lineHeight', '2')
    writeSetting(database, 'reading.annotationsVisible', '0')
    writeSetting(database, 'reading.weakHighlight', '0')

    expect(readReadingPreferences(database)).toEqual({
      fontSize: 22,
      lineHeight: 2,
      annotationsVisible: false,
      weakHighlight: false
    })

    writeSetting(database, 'reading.fontSize', '17')
    writeSetting(database, 'reading.lineHeight', '1.7')
    writeSetting(database, 'reading.annotationsVisible', '或许')
    writeSetting(database, 'reading.weakHighlight', '或许')

    expect(readReadingPreferences(database)).toEqual({
      fontSize: 20,
      lineHeight: 1.8,
      annotationsVisible: true,
      weakHighlight: true
    })
  })
})

describe('readReadingSettings', () => {
  it('没单独设过时整份来自全局', () => {
    expect(readReadingSettings(database, carefulReading.id)).toEqual({
      fontSize: 20,
      lineHeight: 1.8,
      annotationsVisible: true,
      weakHighlight: true,
      source: 'global'
    })
  })

  it('文章不存在时返回 null', () => {
    expect(readReadingSettings(database, 'nope')).toBeNull()
  })
})

describe('saveReadingSettings', () => {
  it('只改这一篇，下一篇文章仍用全局默认，全局本身不动', () => {
    const result = saveReadingSettings(database, {
      articleId: carefulReading.id,
      preferences: {
        fontSize: 16,
        lineHeight: 2,
        annotationsVisible: false,
        weakHighlight: false
      }
    })

    expect(result).toEqual({
      saved: true,
      settings: {
        fontSize: 16,
        lineHeight: 2,
        annotationsVisible: false,
        weakHighlight: false,
        source: 'article'
      }
    })
    expect(readReadingSettings(database, carefulReading.id)).toMatchObject({
      fontSize: 16,
      lineHeight: 2,
      annotationsVisible: false,
      weakHighlight: false,
      source: 'article'
    })
    expect(readReadingSettings(database, olderReading.id)).toMatchObject({
      fontSize: 20,
      lineHeight: 1.8,
      annotationsVisible: true,
      weakHighlight: true,
      source: 'global'
    })
    expect(readReadingPreferences(database)).toMatchObject({
      fontSize: 20,
      lineHeight: 1.8,
      annotationsVisible: true,
      weakHighlight: true
    })
  })

  it('再次保存覆盖本篇的值', () => {
    saveReadingSettings(database, {
      articleId: carefulReading.id,
      preferences: {
        fontSize: 16,
        lineHeight: 1.6,
        annotationsVisible: false,
        weakHighlight: false
      }
    })

    expect(
      saveReadingSettings(database, {
        articleId: carefulReading.id,
        preferences: {
          fontSize: 22,
          lineHeight: 2,
          annotationsVisible: true,
          weakHighlight: true
        }
      })
    ).toMatchObject({
      saved: true,
      settings: {
        fontSize: 22,
        lineHeight: 2,
        annotationsVisible: true,
        weakHighlight: true,
        source: 'article'
      }
    })
  })

  it('可以单独关掉本篇的弱高亮，不影响其他篇', () => {
    saveReadingSettings(database, {
      articleId: carefulReading.id,
      preferences: {
        fontSize: 20,
        lineHeight: 1.8,
        annotationsVisible: true,
        weakHighlight: false
      }
    })

    expect(readReadingSettings(database, carefulReading.id)?.weakHighlight).toBe(false)
    expect(readReadingSettings(database, olderReading.id)?.weakHighlight).toBe(true)
  })

  it('不认识的字号或行距不写入，返回当前生效值', () => {
    const result = saveReadingSettings(database, {
      articleId: carefulReading.id,
      preferences: {
        fontSize: 17 as never,
        lineHeight: 1.9 as never,
        annotationsVisible: false,
        weakHighlight: false
      }
    })

    expect(result).toMatchObject({
      saved: false,
      settings: {
        fontSize: 20,
        lineHeight: 1.8,
        annotationsVisible: true,
        weakHighlight: true,
        source: 'global'
      }
    })
    expect(readReadingSettings(database, carefulReading.id)).toMatchObject({ source: 'global' })
  })

  it('文章不存在时不写入', () => {
    expect(
      saveReadingSettings(database, {
        articleId: 'nope',
        preferences: {
          fontSize: 22,
          lineHeight: 2,
          annotationsVisible: false,
          weakHighlight: false
        }
      })
    ).toBeNull()
  })
})

describe('saveReadingPreferences', () => {
  it('写入全局默认，没有本篇覆盖的文章跟着变', () => {
    const result = saveReadingPreferences(database, {
      fontSize: 22,
      lineHeight: 2,
      annotationsVisible: false,
      weakHighlight: false
    })

    expect(result).toEqual({
      saved: true,
      preferences: {
        fontSize: 22,
        lineHeight: 2,
        annotationsVisible: false,
        weakHighlight: false
      }
    })
    expect(readReadingPreferences(database)).toEqual(result.preferences)
    expect(readReadingSettings(database, olderReading.id)).toEqual({
      ...result.preferences,
      source: 'global'
    })
  })

  it('已有本篇覆盖的文章不受设置页的全局默认影响', () => {
    saveReadingSettings(database, {
      articleId: carefulReading.id,
      preferences: {
        fontSize: 16,
        lineHeight: 1.6,
        annotationsVisible: false,
        weakHighlight: false
      }
    })

    expect(
      saveReadingPreferences(database, {
        fontSize: 22,
        lineHeight: 2,
        annotationsVisible: true,
        weakHighlight: true
      })
    ).toMatchObject({ saved: true })

    expect(readReadingSettings(database, carefulReading.id)).toEqual({
      fontSize: 16,
      lineHeight: 1.6,
      annotationsVisible: false,
      weakHighlight: false,
      source: 'article'
    })
    expect(readReadingSettings(database, olderReading.id)).toMatchObject({
      fontSize: 22,
      lineHeight: 2,
      annotationsVisible: true,
      weakHighlight: true,
      source: 'global'
    })
  })

  it('不认识的字号或行距不写入，返回当前生效的全局默认', () => {
    const result = saveReadingPreferences(database, {
      fontSize: 17 as never,
      lineHeight: 1.9 as never,
      annotationsVisible: false,
      weakHighlight: false
    })

    expect(result).toEqual({
      saved: false,
      preferences: {
        fontSize: 20,
        lineHeight: 1.8,
        annotationsVisible: true,
        weakHighlight: true
      }
    })
    expect(readReadingPreferences(database).fontSize).toBe(20)
  })
})

describe('readReadingView', () => {
  it('给出文章、按序段落与句子，长篇匹配带原卷字母，仔细阅读没有字母', () => {
    const longView = readReadingView(database, longMatch.id)
    expect(longView?.article).toMatchObject({ id: longMatch.id, kind: 'long_match' })
    expect(longView?.paragraphs.map((paragraph) => paragraph.ordinal)).toEqual([0, 1])
    expect(longView?.paragraphs.map((paragraph) => paragraph.letter)).toEqual(['A', 'B'])
    expect(longView?.paragraphs[0]?.sentences.map((sentence) => sentence.text)).toEqual([
      'Employers approach hiring differently.',
      'Skills matter more than degrees.'
    ])

    const carefulView = readReadingView(database, carefulReading.id)
    expect(carefulView?.paragraphs.map((paragraph) => paragraph.letter)).toEqual([null, null])
  })

  it('长篇匹配只编 A–P：非字母 id 按段序补，超过 P 的段不再加字母', () => {
    const view = readReadingView(database, numericLongMatch.id)

    expect(view?.paragraphs.map((paragraph) => paragraph.letter)).toEqual([
      ...'ABCDEFGHIJKLMNOP',
      null
    ])
  })

  it('原文注释挂在所属段落，正文本身不含注释文字', () => {
    const view = readReadingView(database, carefulReading.id)

    expect(view?.paragraphs[0]?.annotations).toEqual([
      { surface: 'Context', gloss: '语境', start: 44, end: 51, sentenceOrdinal: 1 }
    ])
    expect(view?.paragraphs[0]?.text).toContain('Context')
    expect(view?.paragraphs[0]?.text).not.toContain('语境')
    expect(view?.paragraphs[0]?.sentences[1]?.text).toBe('Context carries most of the meaning.')
  })

  it('带上本篇生效的阅读设置与上次读到的位置', () => {
    saveReadingSettings(database, {
      articleId: carefulReading.id,
      preferences: {
        fontSize: 18,
        lineHeight: 1.6,
        annotationsVisible: false,
        weakHighlight: false
      }
    })

    const view = readReadingView(database, carefulReading.id)

    expect(view?.settings).toMatchObject({
      fontSize: 18,
      lineHeight: 1.6,
      annotationsVisible: false,
      weakHighlight: false,
      source: 'article'
    })
    expect(view?.readingPoint).toBeNull()
  })

  it('收词与删除的结果自带刷新后的本篇曾收词数，不用重开阅读视图', () => {
    const paragraphText =
      'Reading widely makes hard sentences easier. Context carries most of the meaning.'
    expect(openReadingView(database, carefulReading.id)?.knownWordCount).toBe(0)

    const collected = collectWord(carefulReading.id, '1', paragraphText, 0, 'hard')
    if (collected.status === 'rejected') throw new Error('夹具收词被拒绝')
    expect(collected.knownWordCount).toBe(1)

    // 同篇同句再收一次是 duplicate，计数保持已刷新后的值。
    const duplicate = collectWord(carefulReading.id, '1', paragraphText, 0, 'hard')
    if (duplicate.status === 'rejected') throw new Error('夹具重复收词被拒绝')
    expect(duplicate.knownWordCount).toBe(1)

    const deleted = deleteEntrySentence(database, collected.sentence.id)
    if (deleted.status !== 'deleted') throw new Error('夹具删除失败')
    expect(deleted.knownWordCount).toBe(0)
    expect(openReadingView(database, carefulReading.id)?.knownWordCount).toBe(0)
  })

  it('带上这一篇已收集的表达，别的篇不混进来', () => {
    const paragraphText =
      'Reading widely makes hard sentences easier. Context carries most of the meaning.'
    expect(
      collectWord(carefulReading.id, '1', paragraphText, 0, 'hard').status
    ).toBe('collected')
    expect(
      collectWord(longMatch.id, 'A', 'Employers approach hiring differently.', 0, 'approach').status
    ).toBe('collected')

    const view = readReadingView(database, carefulReading.id)
    expect(view?.collected).toHaveLength(1)
    expect(view?.collected[0]).toMatchObject({
      surface: 'hard',
      entryMainForm: 'hard',
      paragraphId: '1',
      sentenceOrdinal: 0,
      start: 21,
      end: 25
    })
  })

  it('带出全局阅读偏好、本篇已识词数与标记的置顶内容 / 故人重逢', () => {
    const olderText =
      'Old passages still repay a visit. Review begins with the sentence. A quiet hour of reading repays the visit. A hard sentence rewards a slow reading.'
    // 「reading」只在别篇收过，本篇正文里出现；它也该算进本篇已识词数。
    const reading = collectWord(olderReading.id, '1', olderText, 2, 'reading', '2026-11-18T07:00:00.000Z')
    // 「hard」两边都收过：本篇的标记要带出别篇那条故人重逢。
    const olderHard = collectWord(
      olderReading.id,
      '1',
      olderText,
      3,
      'hard',
      '2026-11-18T08:00:00.000Z'
    )
    const hard = collectWord(
      carefulReading.id,
      '1',
      'Reading widely makes hard sentences easier. Context carries most of the meaning.',
      0,
      'hard',
      '2026-11-18T09:00:00.000Z'
    )
    if (reading.status === 'rejected' || olderHard.status === 'rejected' || hard.status === 'rejected') {
      throw new Error('夹具收词被拒绝')
    }

    const note = createLearningNote(database, {
      entryId: hard.entry.id,
      body: 'hard 在这里是「难懂的」，不是「坚硬的」。'
    })
    if (note.status !== 'saved') throw new Error('学习内容没有写成')
    pinLearningNote(database, { noteId: note.note.id, pinned: true })

    const view = readReadingView(database, carefulReading.id)
    expect(view?.globalPreferences).toEqual({
      silentCollection: false,
      marginNoteMode: 'all',
      lightMask: false
    })
    expect(view?.knownWordCount).toBe(2)
    expect(view?.collected).toHaveLength(1)
    expect(view?.collected[0]).toMatchObject({
      surface: 'hard',
      glance: {
        pinnedNote: { id: note.note.id, excerpt: 'hard 在这里是「难懂的」，不是「坚硬的」。' },
        encounter: {
          entrySentenceId: olderHard.sentence.id,
          articleId: olderReading.id,
          articleTitle: '2023年12月 · 第1套 · 仔细阅读 Passage One',
          paragraphOrdinal: 1,
          sentenceText: 'A hard sentence rewards a slow reading.',
          surface: 'hard'
        }
      }
    })
  })

  it('文章不存在时返回 null', () => {
    expect(readReadingView(database, 'nope')).toBeNull()
  })
})

describe('openReadingView', () => {
  it('首次打开停到第一句并记下最近打开', () => {
    const view = openReadingView(database, carefulReading.id, {
      now: '2026-11-18T08:00:00.000Z'
    })

    expect(view?.readingPoint).toMatchObject({
      paragraphId: '1',
      paragraphOrdinal: 1,
      sentenceOrdinal: 1,
      sentenceText: 'Reading widely makes hard sentences easier.'
    })
    expect(view?.article.lastOpenedAt).toBe('2026-11-18T08:00:00.000Z')
  })
})

describe('saveReadingPoint', () => {
  it('记住所在段落与句子，再次打开从那里继续', () => {
    openReadingView(database, carefulReading.id, { now: '2026-11-18T08:00:00.000Z' })

    expect(
      saveReadingPoint(
        database,
        { articleId: carefulReading.id, paragraphId: '2', sentenceOrdinal: 0 },
        { now: '2026-11-18T09:00:00.000Z' }
      )
    ).toEqual({ saved: true })

    const reopened = openReadingView(database, carefulReading.id, {
      now: '2026-11-18T10:00:00.000Z'
    })
    expect(reopened?.readingPoint).toMatchObject({
      paragraphId: '2',
      paragraphOrdinal: 2,
      sentenceOrdinal: 1,
      sentenceText: 'A steady habit keeps the reading going.'
    })
    expect(reopened?.article.lastOpenedAt).toBe('2026-11-18T10:00:00.000Z')
  })

  it('保存后首页的继续阅读跟着更新', () => {
    openReadingView(database, carefulReading.id, { now: '2026-11-18T08:00:00.000Z' })
    saveReadingPoint(
      database,
      { articleId: carefulReading.id, paragraphId: '1', sentenceOrdinal: 1 },
      { now: '2026-11-18T08:05:00.000Z' }
    )

    const summary = readHomeSummary(database)
    expect(summary.continueReading?.lastReadPoint).toMatchObject({
      paragraphOrdinal: 1,
      sentenceOrdinal: 2,
      sentenceText: 'Context carries most of the meaning.'
    })
    expect(summary.continueReading?.article.progress).toEqual({ state: 'reading', percent: 67 })
  })

  it('已读完后重读、滚动与改设置都不撤销已读完', () => {
    openReadingView(database, carefulReading.id, { now: '2026-11-18T08:00:00.000Z' })
    saveReadingPoint(
      database,
      { articleId: carefulReading.id, paragraphId: '2', sentenceOrdinal: 0 },
      { now: '2026-11-18T08:05:00.000Z' }
    )
    markArticleCompleted(database, carefulReading.id, { now: '2026-11-18T08:10:00.000Z' })

    // 重读：回到第一段并再写一次位置，完成状态与阅读位置各自保留。
    saveReadingPoint(
      database,
      { articleId: carefulReading.id, paragraphId: '1', sentenceOrdinal: 1 },
      { now: '2026-11-18T09:00:00.000Z' }
    )
    saveReadingSettings(database, {
      articleId: carefulReading.id,
      preferences: { fontSize: 16, lineHeight: 1.6, annotationsVisible: true, weakHighlight: true }
    })
    const reopened = openReadingView(database, carefulReading.id, {
      now: '2026-11-18T10:00:00.000Z'
    })

    expect(reopened?.article.progress).toEqual({ state: 'completed', percent: 100 })
    expect(reopened?.readingPoint).toMatchObject({ paragraphOrdinal: 1, sentenceOrdinal: 2 })
    expect(reopened?.settings).toMatchObject({ fontSize: 16, lineHeight: 1.6, source: 'article' })
    // 已经读完的篇目不会再回到首页「继续阅读」。
    expect(readHomeSummary(database).continueReading).toBeNull()
  })

  it('段落或句子不属于这篇时不写入', () => {
    openReadingView(database, carefulReading.id, { now: '2026-11-18T08:00:00.000Z' })

    expect(
      saveReadingPoint(database, {
        articleId: carefulReading.id,
        paragraphId: 'A',
        sentenceOrdinal: 0
      })
    ).toEqual({ saved: false })
    expect(
      saveReadingPoint(database, {
        articleId: carefulReading.id,
        paragraphId: '1',
        sentenceOrdinal: 9
      })
    ).toEqual({ saved: false })
    expect(
      saveReadingPoint(database, {
        articleId: 'nope',
        paragraphId: '1',
        sentenceOrdinal: 0
      })
    ).toEqual({ saved: false })
    expect(
      saveReadingPoint(database, {
        articleId: carefulReading.id,
        paragraphId: '1',
        sentenceOrdinal: -1
      })
    ).toEqual({ saved: false })
  })
})
