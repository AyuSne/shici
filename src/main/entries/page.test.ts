import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CollectSelectionRequest } from '../../shared/entries'
import { fixtureArticle, writeCorpusDirectory, type FixtureEntry } from '../../testing/corpus-fixture'
import { importCorpus } from '../corpus/import'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { createLearningNote } from './notes'
import { collectSelection } from './queries'
import { readEntryList, readEntryPage } from './page'

const T0 = '2026-11-18T08:00:00.000Z'
const T1 = '2026-11-18T08:05:00.000Z'
const T2 = '2026-11-18T08:10:00.000Z'
const T3 = '2026-11-18T08:15:00.000Z'

const firstArticle = fixtureArticle({
  id: 'fixture-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['She approached the counter quietly.', 'The clerk smiled.'],
    ['Context keeps the skill alive.', 'Repeated words stick.']
  ]
})

const secondArticle = fixtureArticle({
  id: 'fixture-2026-06-s2-c2',
  year: 2026,
  month: 6,
  set: 2,
  kind: 'careful_reading',
  label: '2026年6月 · 第2套 · 仔细阅读 Passage Two',
  sentences: [['Another passage approaches the same idea.', 'It reaches a different conclusion.']]
})

type JsonParagraph = {
  id: string
  text: string
  sentences: { ordinal: number; text: string; start: number; end: number }[]
}

function paragraphAt(entry: FixtureEntry, index: number): JsonParagraph {
  return (entry.json.paragraphs as JsonParagraph[])[index] as JsonParagraph
}

/** 按语料里的段落与句子算出一次选区的角色标：段、句与段内字符区间。 */
export function selection(
  entry: FixtureEntry,
  paragraphIndex: number,
  needle: string
): CollectSelectionRequest {
  const paragraph = paragraphAt(entry, paragraphIndex)
  const start = paragraph.text.indexOf(needle)
  if (start < 0) {
    throw new Error(`fixture ${entry.id}: 第 ${paragraphIndex} 段没有 ${needle}`)
  }
  const sentenceIndex = paragraph.sentences.findIndex(
    (candidate) => candidate.start <= start && start < candidate.end
  )
  if (sentenceIndex < 0) {
    throw new Error(`fixture ${entry.id}: ${needle} 不在句子里`)
  }
  return {
    articleId: entry.id,
    paragraphId: paragraph.id,
    sentenceOrdinal: sentenceIndex,
    start,
    end: start + needle.length
  }
}

function collect(
  database: AppDatabase,
  entry: FixtureEntry,
  paragraphIndex: number,
  needle: string,
  now: string = T0
) {
  const result = collectSelection(database, selection(entry, paragraphIndex, needle), { now })
  if (result.status === 'rejected') {
    throw new Error(`collect ${needle} rejected: ${result.reason}`)
  }
  return result
}

let directory: string
let database: AppDatabase

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-entry-page-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
  writeCorpusDirectory(directory, [firstArticle, secondArticle])
  importCorpus(database, { directory })
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('readEntryList', () => {
  it('默认按最近收集排，给出用到的计数', () => {
    const first = collect(database, firstArticle, 0, 'approach', T0)
    collect(database, secondArticle, 0, 'approaches', T1)
    collect(database, firstArticle, 1, 'approached', T2)
    collect(database, firstArticle, 2, 'Context', T3)

    const listing = readEntryList(database, {})

    expect(listing.total).toBe(2)
    expect(listing.entries.map((entry) => entry.mainForm)).toEqual(['Context', 'approach'])
    const approach = listing.entries[1]
    expect(approach?.id).toBe(first.entry.id)
    expect(approach).toMatchObject({
      sentenceCount: 3,
      articleCount: 2,
      noteCount: 0,
      lastCollectedAt: T2
    })
  })

  it('字母序按主词形排，不受大小写影响', () => {
    collect(database, firstArticle, 2, 'Context')
    collect(database, firstArticle, 0, 'approach', T1)

    expect(readEntryList(database, { sort: 'alpha' }).entries.map((entry) => entry.mainForm)).toEqual(
      ['approach', 'Context']
    )
  })

  it('搜索同时匹配主词形与原句正文', () => {
    collect(database, firstArticle, 0, 'approach')
    collect(database, firstArticle, 2, 'Context')

    expect(readEntryList(database, { query: 'appro' }).entries.map((e) => e.mainForm)).toEqual([
      'approach'
    ])
    expect(readEntryList(database, { query: 'EMPLOYERS' }).entries.map((e) => e.mainForm)).toEqual([
      'approach'
    ])
    expect(readEntryList(database, { query: 'keep' }).entries.map((e) => e.mainForm)).toEqual([
      'Context'
    ])
    expect(readEntryList(database, { query: 'zebra' })).toMatchObject({ total: 2, entries: [] })
  })
})

function snippetHighlights(snippet: {
  text: string
  ranges: { start: number; end: number }[]
}): string[] {
  return snippet.ranges.map((range) => snippet.text.slice(range.start, range.end))
}

describe('readEntryList search hits', () => {
  it('命中主词形、原句与学习内容时给出命中类型、片段与定位 id', () => {
    const approach = collect(database, firstArticle, 0, 'approach', T0)
    collect(database, firstArticle, 2, 'Context', T1)
    const note = createLearningNote(database, {
      entryId: approach.entry.id,
      body: '记：approach 是「做法、途径」。\n第二段：approach to training。'
    })
    if (note.status !== 'saved') throw new Error('学习内容没有存下')

    // 主词形命中：片段就是主词形本身，不再往原句里找。
    const byMainForm = readEntryList(database, { query: 'approach' })
    expect(byMainForm.entries.map((entry) => entry.mainForm)).toEqual(['approach'])
    const mainFormHit = byMainForm.entries[0]?.hit
    expect(mainFormHit).toMatchObject({
      match: 'main-form',
      entryId: approach.entry.id
    })
    expect(snippetHighlights(mainFormHit!.snippet)).toEqual(['approach'])

    // 原句命中：带上原句关联 id、文章、段落与句序，片段里高亮真实命中的词。
    const bySentence = readEntryList(database, { query: 'EMPLOYERS' })
    expect(bySentence.entries.map((entry) => entry.mainForm)).toEqual(['approach'])
    const sentenceHit = bySentence.entries[0]?.hit
    expect(sentenceHit).toMatchObject({
      match: 'sentence',
      entryId: approach.entry.id,
      entrySentenceId: approach.sentence.id
    })
    expect(snippetHighlights(sentenceHit!.snippet)).toEqual(['Employers'])
    expect(sentenceHit!.snippet.text).toContain('Employers approach hiring differently.')

    // 学习内容命中：带上学习内容 id；换行被压成一行，高亮仍落在原词上。
    const byNote = readEntryList(database, { query: '途径' })
    expect(byNote.entries.map((entry) => entry.mainForm)).toEqual(['approach'])
    const noteHit = byNote.entries[0]?.hit
    expect(noteHit).toMatchObject({
      match: 'learning-note',
      entryId: approach.entry.id,
      noteId: note.note.id
    })
    expect(noteHit!.snippet.text).not.toContain('\n')
    expect(snippetHighlights(noteHit!.snippet)).toEqual(['途径'])
  })

  it('搜不到时返回空列表，总数仍是库里全部词条', () => {
    collect(database, firstArticle, 0, 'approach')
    collect(database, firstArticle, 2, 'Context')

    expect(readEntryList(database, { query: 'zebra' })).toEqual({ total: 2, entries: [] })
  })

  it('搜索与排序、有无学习内容筛选组合时结果仍正确', () => {
    const approach = collect(database, firstArticle, 0, 'approach', T0)
    const context = collect(database, firstArticle, 2, 'Context', T1)
    const conclusion = collect(database, secondArticle, 0, 'conclusion', T2)
    createLearningNote(database, { entryId: approach.entry.id, body: 'approach 的搭配' })
    createLearningNote(database, { entryId: context.entry.id, body: 'approach 的语境义' })

    // 同一个查询词经不同字段命中：approach 走主词形，Context 只能走学习内容。
    const hasNotes = readEntryList(database, { query: 'approach', filter: 'has-notes' })
    expect(hasNotes.entries.map((entry) => entry.mainForm)).toEqual(['Context', 'approach'])
    expect(hasNotes.entries.map((entry) => entry.hit?.match)).toEqual([
      'learning-note',
      'main-form'
    ])

    // 排序只改结果顺序，不改命中与筛选。
    const alpha = readEntryList(database, {
      query: 'approach',
      sort: 'alpha',
      filter: 'has-notes'
    })
    expect(alpha.entries.map((entry) => entry.mainForm)).toEqual(['approach', 'Context'])
    expect(alpha.entries.map((entry) => entry.hit?.match)).toEqual([
      'main-form',
      'learning-note'
    ])

    // 没有学习内容的词条在 has-notes 下被筛掉，在 no-notes 下仍能按原句命中。
    expect(
      readEntryList(database, { query: 'reaches', filter: 'has-notes' }).entries
    ).toEqual([])
    const noNotes = readEntryList(database, { query: 'reaches', filter: 'no-notes' })
    expect(noNotes.entries.map((entry) => entry.mainForm)).toEqual([conclusion.entry.mainForm])
    expect(noNotes.entries[0]?.hit).toMatchObject({
      match: 'sentence',
      entrySentenceId: conclusion.sentence.id
    })
  })

  it('列表行带回已收集的变体，按首次收集排且不含主词形', () => {
    collect(database, firstArticle, 0, 'approach', T0)
    collect(database, secondArticle, 0, 'approaches', T1)
    collect(database, firstArticle, 1, 'approached', T2)
    collect(database, firstArticle, 0, 'Approaching', T3)

    const listing = readEntryList(database, {})

    expect(listing.entries).toHaveLength(1)
    expect(listing.entries[0]).toMatchObject({
      mainForm: 'approach',
      variants: ['approaches', 'approached', 'Approaching']
    })
  })
})

describe('readEntryPage', () => {
  it('原句按文章分组：组间最近收集在前，组内按段序、句序', () => {
    const collected = collect(database, firstArticle, 0, 'approach', T0)
    collect(database, secondArticle, 0, 'approaches', T1)
    collect(database, firstArticle, 1, 'approached', T2)

    const page = readEntryPage(database, collected.entry.id)
    expect(page).not.toBeNull()
    if (!page) return

    expect(page.groups.map((group) => group.articleId)).toEqual([
      firstArticle.id,
      secondArticle.id
    ])
    const group = page.groups[0]
    expect(group).toMatchObject({
      articleTitle: '2026年6月 · 第1套 · 仔细阅读 Passage One',
      sessionLabel: '2026年6月',
      setLabel: '第1套'
    })
    expect(group?.sentences.map((sentence) => sentence.surface)).toEqual([
      'approach',
      'approached'
    ])
    const firstSentence = group?.sentences[0]
    expect(firstSentence).toMatchObject({
      articleId: firstArticle.id,
      paragraphOrdinal: 1,
      paragraphLetter: null,
      sentenceOrdinal: 0,
      sentenceText: 'Employers approach hiring differently.',
      surfaceOffset: 'Employers '.length,
      page: 1
    })
  })

  it('长篇匹配给出原卷段落字母', () => {
    const longMatch = fixtureArticle({
      id: 'fixture-2026-06-s1-b',
      year: 2026,
      month: 6,
      set: 1,
      kind: 'long_match',
      sentences: [['First paragraph here.'], ['Nothing on approach.'], ['Other ideas remain.']]
    })
    writeCorpusDirectory(directory, [firstArticle, secondArticle, longMatch])
    importCorpus(database, { directory })

    const collected = collect(database, longMatch, 2, 'ideas', T0)
    const page = readEntryPage(database, collected.entry.id)
    expect(page?.groups[0]?.sentences[0]).toMatchObject({
      paragraphOrdinal: 3,
      paragraphLetter: 'C'
    })
  })

  it('给出同篇前后句，并标出哪些原句能拆到新词条', () => {
    const approach = collect(database, firstArticle, 0, 'approach', T0)
    collect(database, firstArticle, 0, 'Approaching', T1)

    const page = readEntryPage(database, approach.entry.id)
    const sentences = page?.groups[0]?.sentences ?? []
    expect(sentences[0]).toMatchObject({
      surface: 'approach',
      previousSentence: null,
      nextSentence: 'Approaching a new desk takes patience.',
      canSplitToNew: false
    })
    expect(sentences[1]).toMatchObject({
      surface: 'Approaching',
      previousSentence: 'Employers approach hiring differently.',
      nextSentence: 'She approached the counter quietly.',
      canSplitToNew: false
    })
  })

  it('词条不存在时返回 null', () => {
    expect(readEntryPage(database, 'nope')).toBeNull()
  })
})
