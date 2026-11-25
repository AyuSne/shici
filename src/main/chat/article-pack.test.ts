import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ThreadContextItem } from '../../shared/threads'
import {
  fixtureArticle,
  writeCorpusDirectory,
  type FixtureEntry
} from '../../testing/corpus-fixture'
import { importCorpus } from '../corpus/import'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { collectSelection } from '../entries/queries'
import { createLearningNote, pinLearningNote } from '../entries/notes'
import { listThreads, packArticleUnorganizedWords, readThreadView } from './threads'

const T0 = '2026-11-18T08:00:00.000Z'

/**
 * 打包的是「本篇还没整理学习内容的词」：同一个词条在本篇出现多次只算一个词，
 * 顺序按它在本文第一次出现的段落 / 句序 / 字区间；上下文只带这些词在本篇的原句，
 * 别篇更晚收集的句子不能混进来。上限 20，超过时明确告诉调用方没带上多少。
 */

const articleA = fixtureArticle({
  id: 'fixture-pack-a',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Practice keeps the skill alive.'],
    ['Approaching a new desk takes patience.', 'Context still carries meaning.'],
    ['She approached the counter quietly.'],
    ['Hiring managers value steady practice.']
  ]
})

const articleB = fixtureArticle({
  id: 'fixture-pack-b',
  year: 2026,
  month: 6,
  set: 1,
  label: '2026年6月 · 第1套 · 仔细阅读 Passage Two',
  sentences: [['Approaching a cliff demands care.']]
})

const words = [
  'ability',
  'absorb',
  'academic',
  'access',
  'account',
  'accurate',
  'achieve',
  'acknowledge',
  'acquire',
  'adapt',
  'adequate',
  'adjust',
  'admire',
  'adopt',
  'advance',
  'advocate',
  'affect',
  'afford',
  'agency',
  'agenda',
  'aggressive',
  'agriculture',
  'allocate'
] as const

const articleMany = fixtureArticle({
  id: 'fixture-pack-many',
  year: 2026,
  month: 6,
  set: 2,
  kind: 'long_match',
  label: '2026年6月 · 第2套 · 长篇匹配',
  sentences: words.map((word) => [`Studies of ${word} continue today.`])
})

const articleEmpty = fixtureArticle({
  id: 'fixture-pack-empty',
  year: 2026,
  month: 6,
  set: 1,
  label: '2026年6月 · 第1套 · 仔细阅读 Passage Three',
  sentences: [['Nothing has been collected here.']]
})

type JsonParagraph = {
  id: string
  text: string
  sentences: { ordinal: number; text: string; start: number; end: number }[]
}

function paragraphAt(entry: FixtureEntry, index: number): JsonParagraph {
  const paragraph = (entry.json.paragraphs as JsonParagraph[])[index]
  if (!paragraph) throw new Error(`fixture ${entry.id}: 没有第 ${index} 段`)
  return paragraph
}

function collect(entry: FixtureEntry, paragraphIndex: number, needle: string, now = T0): void {
  const paragraph = paragraphAt(entry, paragraphIndex)
  const start = paragraph.text.indexOf(needle)
  if (start < 0) throw new Error(`fixture ${entry.id}: 第 ${paragraphIndex} 段没有 ${needle}`)
  const sentenceOrdinal = paragraph.sentences.findIndex(
    (sentence) => sentence.start <= start && start < sentence.end
  )
  const result = collectSelection(
    database,
    {
      articleId: entry.id,
      paragraphId: paragraph.id,
      sentenceOrdinal,
      start,
      end: start + needle.length
    },
    { now }
  )
  if (result.status === 'rejected') {
    throw new Error(`圈 ${needle} 被拒绝：${result.reason}`)
  }
}

function entryIdOf(mainForm: string): string {
  const row = database
    .prepare('SELECT id FROM word_entry WHERE main_form = ?')
    .get(mainForm) as { id: string } | undefined
  if (!row) throw new Error(`没有词条 ${mainForm}`)
  return row.id
}

function note(mainForm: string, pinned = false): void {
  const created = createLearningNote(database, {
    entryId: entryIdOf(mainForm),
    body: `${mainForm} 的学习内容`
  })
  if (created.status !== 'saved') throw new Error(`学习内容没写成：${mainForm}`)
  if (pinned) pinLearningNote(database, { noteId: created.note.id, pinned: true })
}

function contextItems(threadId: string): ThreadContextItem[] {
  const view = readThreadView(database, threadId)
  if (view === null) throw new Error('线程没读出来')
  return view.context
}

let directory: string
let database: AppDatabase

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-article-pack-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
  writeCorpusDirectory(directory, [articleA, articleB, articleMany, articleEmpty])
  importCorpus(database, { directory })
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('packArticleUnorganizedWords', () => {
  it('只打包本篇还没整理学习内容的词：按首次出现排序，只带本篇的原句', () => {
    // 故意逆着文章顺序收集，证明排序看的是正文位置而不是收集时间。
    collect(articleA, 0, 'hiring')
    collect(articleA, 0, 'approach', '2026-11-18T08:01:00.000Z')
    collect(articleA, 1, 'Approaching', '2026-11-18T08:01:30.000Z')
    collect(articleA, 2, 'approached', '2026-11-18T08:01:40.000Z')
    collect(articleA, 0, 'Practice', '2026-11-18T08:02:00.000Z')
    collect(articleA, 1, 'Context', '2026-11-18T08:03:00.000Z')
    collect(articleA, 3, 'Hiring', '2026-11-18T08:04:00.000Z')
    // 同一个词条在别篇更晚收了一句；打包 A 篇时绝不能把这一句带进来。
    collect(articleB, 0, 'Approaching', '2026-11-18T09:00:00.000Z')
    note('Context')

    const result = packArticleUnorganizedWords(database, { articleId: articleA.id })

    expect(result).toMatchObject({
      status: 'created',
      packedCount: 3,
      totalCount: 3,
      omittedCount: 0
    })
    if (result.status !== 'created') return
    const view = readThreadView(database, result.thread.id)
    expect(view).not.toBeNull()
    if (view === null) return
    expect(view.main).toEqual({ kind: 'none' })
    expect(view.title).toBe('approach 等 3 个词')
    expect(view.turns).toEqual([])

    const words = view.context.filter((item) => item.kind === 'word')
    expect(words.map((item) => item.label)).toEqual(['approach', 'hiring', 'Practice'])

    const texts = view.context.map((item) => item.text)
    expect(texts).toContain('Employers approach hiring differently.')
    expect(texts).toContain('Approaching a new desk takes patience.')
    expect(texts).toContain('She approached the counter quietly.')
    expect(texts).toContain('Hiring managers value steady practice.')
    expect(texts).toContain('Practice keeps the skill alive.')
    expect(texts).not.toContain('Approaching a cliff demands care.')

    // 上下文条目按 id 去重：同一个词条在本篇的每条原句各出现一次。
    const ids = view.context.map((item) => item.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(view.contextSummary.wordCount).toBe(3)
    expect(view.contextSummary.sentenceCount).toBe(6)
  })

  it('同一个词条在本篇多段出现只算一个词，但它的每条本篇原句都带上', () => {
    collect(articleA, 0, 'approach')
    collect(articleA, 1, 'Approaching', '2026-11-18T08:01:00.000Z')
    collect(articleA, 2, 'approached', '2026-11-18T08:02:00.000Z')

    const result = packArticleUnorganizedWords(database, { articleId: articleA.id })

    expect(result).toMatchObject({ status: 'created', packedCount: 1 })
    if (result.status !== 'created') return
    const items = contextItems(result.thread.id)
    expect(items.filter((item) => item.kind === 'word')).toHaveLength(1)
    expect(items.filter((item) => item.kind === 'sentence').map((item) => item.text)).toEqual([
      'Employers approach hiring differently.',
      'Approaching a new desk takes patience.',
      'She approached the counter quietly.'
    ])
  })

  it('超过 20 个未整理词时按段落与句序取前 20 个，并明确报告没带上的数量', () => {
    // 逆序收集 23 个词；absorb 已整理，所以剩下 22 个待打包。
    for (let index = words.length - 1; index >= 0; index -= 1) {
      collect(articleMany, index, words[index] as string, `2026-11-18T08:${String(index).padStart(2, '0')}:00.000Z`)
    }
    note('absorb', true)

    const result = packArticleUnorganizedWords(database, { articleId: articleMany.id })

    expect(result).toMatchObject({
      status: 'created',
      packedCount: 20,
      totalCount: 22,
      omittedCount: 2
    })
    if (result.status !== 'created') return
    const items = contextItems(result.thread.id)
    const packed = items.filter((item) => item.kind === 'word').map((item) => item.label)
    expect(packed).toEqual([
      'ability',
      'academic',
      'access',
      'account',
      'accurate',
      'achieve',
      'acknowledge',
      'acquire',
      'adapt',
      'adequate',
      'adjust',
      'admire',
      'adopt',
      'advance',
      'advocate',
      'affect',
      'afford',
      'agency',
      'agenda',
      'aggressive'
    ])
    const sentences = items.filter((item) => item.kind === 'sentence').map((item) => item.text)
    expect(sentences).toHaveLength(20)
    expect(sentences[0]).toBe('Studies of ability continue today.')
    expect(sentences).not.toContain('Studies of agriculture continue today.')
    expect(sentences).not.toContain('Studies of allocate continue today.')
    expect(sentences).not.toContain('Studies of absorb continue today.')
  })

  it('所有已拾词都整理过学习内容时温和收场，不创建空线程', () => {
    collect(articleA, 0, 'approach')
    collect(articleA, 0, 'Practice', '2026-11-18T08:01:00.000Z')
    note('approach')
    note('Practice', true)

    const before = listThreads(database).threads.length
    const result = packArticleUnorganizedWords(database, { articleId: articleA.id })

    expect(result).toEqual({ status: 'empty', reason: 'all-organized', totalCount: 0 })
    expect(listThreads(database).threads).toHaveLength(before)
  })

  it('本篇还没拾词时也不创建空线程', () => {
    const result = packArticleUnorganizedWords(database, { articleId: articleEmpty.id })

    expect(result).toEqual({ status: 'empty', reason: 'no-words', totalCount: 0 })
    expect(listThreads(database).threads).toHaveLength(0)
  })

  it('文章不存在时返回 missing，不写任何线程', () => {
    expect(packArticleUnorganizedWords(database, { articleId: 'nope' })).toEqual({
      status: 'missing'
    })
    expect(listThreads(database).threads).toHaveLength(0)
  })
})
