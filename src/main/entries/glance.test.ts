import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fixtureArticle, writeCorpusDirectory, type FixtureEntry } from '../../testing/corpus-fixture'
import { importCorpus } from '../corpus/import'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { createLearningNote, pinLearningNote } from './notes'
import { collectSelection } from './queries'
import { readEntryGlance, readEntryGlances } from './glance'

/**
 * 阅读词条卡与悬停一瞥要的两件事：置顶学习内容摘要，以及一条跨篇
 * 「故人重逢」原句。只走公开服务（收词 / 写学习内容 / 置顶），
 * 期望值取自夹具里写死的原文与时间，不从实现反推。
 */

let directory: string
let database: AppDatabase

const firstArticle = fixtureArticle({
  id: 'fixture-glance-a',
  year: 2024,
  month: 6,
  set: 1,
  sentences: [['Employers approach hiring differently.'], ['Practice keeps the skill alive.']]
})

const secondArticle = fixtureArticle({
  id: 'fixture-glance-b',
  year: 2023,
  month: 12,
  set: 2,
  sentences: [['A new desk takes patience.'], ['She approached the counter quietly.']]
})

const thirdArticle = fixtureArticle({
  id: 'fixture-glance-c',
  year: 2023,
  month: 6,
  set: 3,
  sentences: [['They approached the problem from another side.']]
})

function collect(
  article: FixtureEntry,
  paragraphIndex: number,
  needle: string,
  at: string
) {
  const paragraph = (article.json.paragraphs as { id: string; text: string; sentences: { start: number; end: number }[] }[])[
    paragraphIndex
  ]!
  const start = paragraph.text.indexOf(needle)
  const sentenceOrdinal = paragraph.sentences.findIndex(
    (sentence) => sentence.start <= start && start < sentence.end
  )
  const result = collectSelection(
    database,
    {
      articleId: article.id,
      paragraphId: paragraph.id,
      sentenceOrdinal,
      start,
      end: start + needle.length
    },
    { now: at }
  )
  if (result.status === 'rejected') {
    throw new Error(`收词被拒绝：${result.reason}`)
  }
  return result
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-glance-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
  writeCorpusDirectory(directory, [firstArticle, secondArticle, thirdArticle])
  importCorpus(database, { directory })
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('readEntryGlance', () => {
  it('带出置顶学习内容摘要与一条非本篇的故人重逢原句，出处齐全', () => {
    collect(firstArticle, 0, 'approach', '2026-11-18T08:00:00.000Z')
    const elsewhere = collect(secondArticle, 1, 'approached', '2026-11-18T09:00:00.000Z')
    collect(thirdArticle, 0, 'approached', '2026-11-18T07:00:00.000Z')

    const note = createLearningNote(database, {
      entryId: elsewhere.entry.id,
      body: 'approach 在真题里常表示“着手处理”，比单纯的“接近”更常见。'
    })
    if (note.status !== 'saved') throw new Error('学习内容没有写成')
    expect(pinLearningNote(database, { noteId: note.note.id, pinned: true }).status).toBe('saved')

    expect(
      readEntryGlance(database, elsewhere.entry.id, { excludeArticleId: firstArticle.id })
    ).toEqual({
      pinnedNote: {
        id: note.note.id,
        excerpt: 'approach 在真题里常表示“着手处理”，比单纯的“接近”更常见。'
      },
      encounter: {
        entrySentenceId: elsewhere.sentence.id,
        articleId: secondArticle.id,
        articleTitle: '2023年12月 · 第2套 · 仔细阅读 Passage One',
        paragraphOrdinal: 2,
        sentenceText: 'She approached the counter quietly.',
        surface: 'approached'
      }
    })
  })

  it('没有置顶内容与别篇原句时两项都为 null，批量读只返回要的词条', () => {
    collect(firstArticle, 0, 'approach', '2026-11-18T08:00:00.000Z')
    const second = collect(secondArticle, 0, 'patience', '2026-11-18T09:00:00.000Z')

    const glances = readEntryGlances(database, [second.entry.id], {
      excludeArticleId: secondArticle.id
    })
    expect(glances.get(second.entry.id)).toEqual({ pinnedNote: null, encounter: null })
    expect(readEntryGlance(database, 'missing-entry')).toBeNull()
  })
})
