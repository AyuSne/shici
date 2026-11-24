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
import { collectSelection } from '../entries/queries'
import { openArticle } from '../library/queries'
import { readSearchShortcuts } from './shortcuts'

/**
 * Ctrl+K 空态的两组「最近」：最近打开的文章最多 3 篇、最近收集的词条最多 5 条。
 * 走真实 SQLite 与公开服务，期望值直接来自测试里写入的时间与词形。
 */

const T = (minute: number): string => `2026-11-18T09:${String(minute).padStart(2, '0')}:00.000Z`

const first = fixtureArticle({
  id: 'fixture-shortcuts-a',
  sentences: [
    ['Employers approach hiring differently.', 'Context keeps the skill alive.'],
    ['A steady habit keeps the reading going.']
  ]
})
const second = fixtureArticle({
  id: 'fixture-shortcuts-b',
  year: 2024,
  month: 12,
  set: 2,
  sentences: [['Patience pays off in the long run.']]
})
const third = fixtureArticle({
  id: 'fixture-shortcuts-c',
  year: 2023,
  month: 6,
  set: 3,
  sentences: [['Luminous lanterns mark the final line.']]
})
const fourth = fixtureArticle({
  id: 'fixture-shortcuts-d',
  year: 2025,
  month: 6,
  set: 1,
  sentences: [['A fourth article closes the set.']]
})

type JsonParagraph = {
  id: string
  text: string
  sentences: { ordinal: number; text: string; start: number; end: number }[]
}

let directory: string
let database: AppDatabase

function paragraphAt(entry: FixtureEntry, index: number): JsonParagraph {
  const paragraph = (entry.json.paragraphs as JsonParagraph[])[index]
  if (!paragraph) throw new Error(`fixture 没有第 ${index} 段`)
  return paragraph
}

function collect(entry: FixtureEntry, paragraphIndex: number, needle: string, now: string): string {
  const paragraph = paragraphAt(entry, paragraphIndex)
  const start = paragraph.text.indexOf(needle)
  if (start < 0) throw new Error(`第 ${paragraphIndex} 段没有 ${needle}`)
  const sentenceOrdinal = paragraph.sentences.findIndex(
    (sentence) => sentence.start <= start && start < sentence.end
  )
  const request: CollectSelectionRequest = {
    articleId: entry.id,
    paragraphId: paragraph.id,
    sentenceOrdinal,
    start,
    end: start + needle.length
  }
  const result = collectSelection(database, request, { now })
  if (result.status === 'rejected') throw new Error(`收 ${needle} 被拒绝：${result.reason}`)
  return result.entry.id
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-search-shortcuts-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
  writeCorpusDirectory(directory, [first, second, third, fourth])
  importCorpus(database, { directory })
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('全局搜索空态快捷项', () => {
  it('什么都没打开、没收过时两组都是空列表', () => {
    expect(readSearchShortcuts(database)).toEqual({
      recentArticles: [],
      recentEntries: []
    })
  })

  it('最近打开的文章最多 3 篇，按最近打开倒序，不带没打开过的', () => {
    openArticle(database, first.id, { now: T(1) })
    openArticle(database, second.id, { now: T(2) })
    openArticle(database, third.id, { now: T(3) })
    openArticle(database, fourth.id, { now: T(4) })

    const shortcuts = readSearchShortcuts(database)
    expect(shortcuts.recentArticles.map((article) => article.id)).toEqual([
      fourth.id,
      third.id,
      second.id
    ])
    expect(shortcuts.recentArticles[0]?.title).toContain('2025年6月')
  })

  it('最近收集的词条最多 5 条，按最近收词倒序，未归档钉住不混入', () => {
    const ids: string[] = []
    for (const word of ['Employers', 'approach', 'hiring', 'differently', 'Context', 'keeps']) {
      ids.push(collect(first, 0, word, T(ids.length)))
    }
    collect(second, 0, 'Patience', T(9))

    database
      .prepare(
        `INSERT INTO pin (
           id, thread_id, thread_title, answer_id, turn_index, model,
           captured_text, char_start, char_end, source_sentence_id,
           source_sentence_text, target_kind, target_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        'pin-unfiled-shortcuts',
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
        T(20)
      )

    const shortcuts = readSearchShortcuts(database)
    expect(shortcuts.recentEntries.map((entry) => entry.mainForm)).toEqual([
      'Patience',
      'keeps',
      'Context',
      'differently',
      'hiring'
    ])
    expect(shortcuts.recentEntries.map((entry) => entry.id)).toEqual([
      expect.stringMatching(/^[0-9a-f-]{36}$/),
      ids[5],
      ids[4],
      ids[3],
      ids[2]
    ])
  })
})
