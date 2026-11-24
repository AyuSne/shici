import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CollectSelectionRequest } from '../../shared/entries'
import {
  fixtureArticle,
  writeCorpusDirectory,
  type FixtureEntry
} from '../../testing/corpus-fixture'
import { importCorpus } from '../corpus/import'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { setEntryLater } from '../entries/later'
import { readEntryList } from '../entries/page'
import { collectSelection } from '../entries/queries'
import { openArticle, readHomeSummary } from './queries'

/**
 * 首页「最近收集」只认真实的词条收集：按每个词条最近一次收词的时间倒序，
 * 未归档的钉住不是词条，不能混进 chip 列表。
 */

const T0 = '2026-11-18T08:00:00.000Z'
const T1 = '2026-11-18T08:05:00.000Z'
const T2 = '2026-11-18T08:10:00.000Z'
const T3 = '2026-11-18T08:15:00.000Z'
const T4 = '2026-11-18T08:20:00.000Z'

const firstArticle = fixtureArticle({
  id: 'fixture-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Context keeps the skill alive.'],
    ['A steady habit keeps the reading going.']
  ]
})

const secondArticle = fixtureArticle({
  id: 'fixture-2026-06-s2-b',
  year: 2026,
  month: 6,
  set: 2,
  kind: 'long_match',
  sentences: [
    ['Patience pays off in the long run.', 'Employers approach new desks patiently.']
  ]
})

const thirdArticle = fixtureArticle({
  id: 'fixture-2026-06-s3-c2',
  year: 2026,
  month: 6,
  set: 3,
  sentences: [
    ['Reading keeps reading alive and reading well.'],
    ['Another paragraph has reading too.']
  ]
})

type JsonParagraph = {
  id: string
  text: string
  sentences: { ordinal: number; text: string; start: number; end: number }[]
}

function paragraphAt(entry: FixtureEntry, index: number): JsonParagraph {
  const paragraph = (entry.json.paragraphs as JsonParagraph[])[index]
  if (!paragraph) {
    throw new Error(`语料 ${entry.id} 没有第 ${index} 段`)
  }
  return paragraph
}

function selection(
  entry: FixtureEntry,
  paragraphIndex: number,
  needle: string
): CollectSelectionRequest {
  const paragraph = paragraphAt(entry, paragraphIndex)
  const start = paragraph.text.indexOf(needle)
  if (start < 0) {
    throw new Error(`语料 ${entry.id} 第 ${paragraphIndex} 段没有 ${needle}`)
  }
  const sentenceOrdinal = paragraph.sentences.findIndex(
    (candidate) => candidate.start <= start && start < candidate.end
  )
  return {
    articleId: entry.id,
    paragraphId: paragraph.id,
    sentenceOrdinal,
    start,
    end: start + needle.length
  }
}

function collect(
  entry: FixtureEntry,
  paragraphIndex: number,
  needle: string,
  now: string
): string {
  const result = collectSelection(database, selection(entry, paragraphIndex, needle), { now })
  if (result.status === 'rejected') {
    throw new Error(`收 ${needle} 被拒绝：${result.reason}`)
  }
  return result.entry.id
}

let directory: string
let database: AppDatabase

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-home-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
  writeCorpusDirectory(directory, [firstArticle, secondArticle, thirdArticle])
  importCorpus(database, { directory })
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('首页最近收集', () => {
  it('还没有收过词时是空列表，不拿假数据充数', () => {
    expect(readHomeSummary(database).recentEntries).toEqual([])
  })

  it('按最近收集时间倒序给出词条，并带上原句与来源文章数', () => {
    collect(firstArticle, 0, 'approach', T0)
    collect(firstArticle, 1, 'habit', T1)
    collect(secondArticle, 0, 'Patience', T2)

    const entries = readHomeSummary(database).recentEntries

    expect(entries.map((entry) => entry.mainForm)).toEqual(['Patience', 'habit', 'approach'])
    expect(entries[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      mainForm: 'Patience',
      sentenceCount: 1,
      articleCount: 1,
      lastCollectedAt: T2
    })
  })

  it('同一个词条再收一句会排到最前，计数跟着长', () => {
    collect(firstArticle, 0, 'approach', T0)
    collect(firstArticle, 1, 'habit', T1)
    collect(secondArticle, 0, 'Patience', T2)
    const approachId = collect(secondArticle, 0, 'approach', T3)

    const entries = readHomeSummary(database).recentEntries

    expect(entries[0]).toMatchObject({
      id: approachId,
      mainForm: 'approach',
      sentenceCount: 2,
      articleCount: 2,
      lastCollectedAt: T3
    })
    expect(entries.map((entry) => entry.mainForm)).toEqual(['approach', 'Patience', 'habit'])
  })

  it('未归档的钉住不算词条，不会出现在最近收集里', () => {    collect(firstArticle, 0, 'approach', T0)

    database
      .prepare(
        `INSERT INTO pin (
           id, thread_id, thread_title, answer_id, turn_index, model,
           captured_text, char_start, char_end, source_sentence_id,
           source_sentence_text, target_kind, target_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'pin-unfiled',
        'thread-1',
        '新的学习',
        'answer-1',
        1,
        'deepseek-flash',
        'lament 是惋惜。',
        0,
        'lament'.length,
        null,
        null,
        'unfiled',
        null,
        T4
      )

    const entries = readHomeSummary(database).recentEntries

    expect(entries.map((entry) => entry.mainForm)).toEqual(['approach'])
    expect(entries.map((entry) => entry.mainForm)).not.toContain('lament')
  })

  it('最多 8 个 chip，按最近收集倒序，与词条列表读同一份字段', () => {
    const words = [
      'Employers',
      'approach',
      'hiring',
      'differently',
      'Context',
      'keeps',
      'skill',
      'alive',
      'steady',
      'habit'
    ]
    words.forEach((word, index) => {
      const now = `2026-11-18T08:${String(index).padStart(2, '0')}:00.000Z`
      collect(firstArticle, index < 8 ? 0 : 1, word, now)
    })

    const summary = readHomeSummary(database)
    expect(summary.recentEntries).toHaveLength(8)
    expect(summary.recentEntries.map((entry) => entry.mainForm)).toEqual(
      ['habit', 'steady', 'alive', 'skill', 'keeps', 'Context', 'differently', 'hiring']
    )

    // chip 的字段就是词条列表那一行，不再另拼一套计数。
    const listed = readEntryList(database, {}).entries[0]
    if (!listed) throw new Error('词条列表为空')
    expect(summary.recentEntries[0]).toEqual({
      id: listed.id,
      mainForm: listed.mainForm,
      sentenceCount: listed.sentenceCount,
      articleCount: listed.articleCount,
      lastCollectedAt: listed.lastCollectedAt
    })
    expect(listed.noteCount).toEqual(expect.any(Number))
    expect(summary.recentEntries[0]).not.toHaveProperty('noteCount')
  })

  it('稍后看标记不改变最近收集的顺序与计数', () => {
    const recentId = collect(firstArticle, 0, 'approach', T0)
    collect(firstArticle, 1, 'habit', T1)
    const before = readHomeSummary(database).recentEntries

    expect(setEntryLater(database, { entryId: recentId, later: true }, { now: T3 })).toEqual({
      status: 'marked',
      markedAt: T3
    })

    const after = readHomeSummary(database)
    expect(after.recentEntries).toEqual(before)
    expect(after.laterEntries).toEqual([
      { entryId: recentId, mainForm: 'approach', markedAt: T3 }
    ])
  })
})

describe('首页继续阅读原句里的已拾区间', () => {
  it('给出保存句里实际收下的词形与段内转句内区间，重复出现但未收的不混进来', () => {
    openArticle(database, thirdArticle.id, { now: T0 })
    const entryId = collect(thirdArticle, 0, 'Reading', T0)

    const summary = readHomeSummary(database)
    if (summary.continueReading === null) throw new Error('应该有续读篇目')
    expect(summary.continueReading.lastReadPoint?.sentenceText).toBe(
      'Reading keeps reading alive and reading well.'
    )
    // 只亮第一次出现的 Reading，后两处 reading 没被收，不能靠主词形猜亮。
    expect(summary.continueReading.lastReadPointHighlights).toEqual([
      {
        entryId,
        mainForm: 'Reading',
        surface: 'Reading',
        start: 0,
        end: 7
      }
    ])
  })

  it('只取保存句里的区间：同篇别的句子与别的文章都不混进来', () => {
    openArticle(database, firstArticle.id, { now: T0 })
    const approachId = collect(firstArticle, 0, 'approach', T0)
    collect(firstArticle, 0, 'Context', T1)
    collect(firstArticle, 1, 'habit', T2)
    collect(secondArticle, 0, 'Patience', T3)

    const summary = readHomeSummary(database)
    if (summary.continueReading === null) throw new Error('应该有续读篇目')
    expect(summary.continueReading.lastReadPoint?.sentenceText).toBe(
      'Employers approach hiring differently.'
    )
    expect(summary.continueReading.lastReadPointHighlights).toEqual([
      {
        entryId: approachId,
        mainForm: 'approach',
        surface: 'approach',
        start: 10,
        end: 18
      }
    ])
  })
})

describe('首页继续阅读的本篇拾词速览', () => {
  it('只列当前续读篇目里收下的词条，按最近收词倒序', () => {
    openArticle(database, firstArticle.id, { now: T0 })
    const approachId = collect(firstArticle, 0, 'approach', T0)
    const habitId = collect(firstArticle, 1, 'habit', T1)
    collect(secondArticle, 0, 'Patience', T2)
    const contextId = collect(firstArticle, 0, 'Context', T3)

    const summary = readHomeSummary(database)
    if (summary.continueReading === null) throw new Error('应该有续读篇目')

    expect(summary.continueReading.article.id).toBe(firstArticle.id)
    expect(summary.continueReading.articleEntries).toEqual([
      { entryId: contextId, mainForm: 'Context' },
      { entryId: habitId, mainForm: 'habit' },
      { entryId: approachId, mainForm: 'approach' }
    ])
  })

  it('最多 4 个词条，再多留给词条页；没有收词时为空列表', () => {
    openArticle(database, firstArticle.id, { now: T0 })
    expect(readHomeSummary(database).continueReading?.articleEntries).toEqual([])

    const words = ['Employers', 'approach', 'hiring', 'differently', 'Context', 'keeps']
    words.forEach((word, index) => {
      collect(firstArticle, index < 5 ? 0 : 1, word, `2026-11-18T08:${10 + index}:00.000Z`)
    })

    const entries = readHomeSummary(database).continueReading?.articleEntries
    expect(entries).toHaveLength(4)
    expect(entries?.map((entry) => entry.mainForm)).toEqual([
      'keeps',
      'Context',
      'differently',
      'hiring'
    ])
  })
})
