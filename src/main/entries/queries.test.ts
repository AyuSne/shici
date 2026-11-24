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
import { writeDictionaryFixture } from '../../testing/dictionary-fixture'
import { importCorpus } from '../corpus/import'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { openDictionary } from '../dictionary/dictionary'
import {
  collectSelection,
  deleteEntrySentence,
  readArticleCollections,
  readEntrySentenceTarget,
  readWordEntryCard
} from './queries'

const T0 = '2026-11-18T08:00:00.000Z'
const T1 = '2026-11-18T08:05:00.000Z'
const T2 = '2026-11-18T08:10:00.000Z'

const article = fixtureArticle({
  id: 'fixture-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['She approached the counter quietly.', 'The approachable clerk smiled.'],
    ['Language learners benefit from context.', 'Repeated words stick.'],
    ['Practice keeps the skill alive.', 'Language learners read every day.'],
    ['The team approaches every problem slowly.'],
    ['He drank the water slowly.', 'They drink tea every morning.']
  ]
})

const otherArticle = fixtureArticle({
  id: 'fixture-2026-06-s1-c2',
  year: 2026,
  month: 6,
  set: 2,
  label: '2026年6月 · 第2套 · 仔细阅读 Passage Two',
  sentences: [['Another passage approaches the same idea.', 'Context still carries meaning.']]
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
function selection(
  entry: FixtureEntry,
  paragraphIndex: number,
  needle: string,
  options: { from?: number; offsetStart?: number; offsetEnd?: number } = {}
): CollectSelectionRequest {
  const paragraph = paragraphAt(entry, paragraphIndex)
  const start = paragraph.text.indexOf(needle, options.from ?? 0)
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
    start: start + (options.offsetStart ?? 0),
    end: start + needle.length + (options.offsetEnd ?? 0)
  }
}

function collect(
  database: AppDatabase,
  entry: FixtureEntry,
  paragraphIndex: number,
  needle: string,
  options: { now?: string; from?: number; offsetStart?: number; offsetEnd?: number } = {}
) {
  return collectSelection(database, selection(entry, paragraphIndex, needle, options), {
    now: options.now ?? T0
  })
}

let directory: string
let database: AppDatabase

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-entries-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
  writeCorpusDirectory(directory, [article, otherArticle])
  importCorpus(database, { directory })
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('collectSelection', () => {
  it('圈下一个词，建词条与原句，返回这次的收集结果', () => {
    const result = collect(database, article, 0, 'approach')

    expect(result.status).toBe('collected')
    if (result.status !== 'collected') return
    expect(result.entry).toMatchObject({
      mainForm: 'approach',
      variants: [],
      sentenceCount: 1,
      articleCount: 1
    })
    expect(result.sentence).toMatchObject({
      surface: 'approach',
      articleId: article.id,
      articleTitle: '2026年6月 · 第1套 · 仔细阅读 Passage One',
      paragraphId: paragraphAt(article, 0).id,
      sentenceOrdinal: 0,
      sentenceText: 'Employers approach hiring differently.'
    })
    expect(result.marks).toEqual([
      {
        id: result.sentence.id,
        entryId: result.entry.id,
        entryMainForm: 'approach',
        surface: 'approach',
        paragraphId: paragraphAt(article, 0).id,
        sentenceOrdinal: 0,
        start: paragraphAt(article, 0).text.indexOf('approach'),
        end: paragraphAt(article, 0).text.indexOf('approach') + 'approach'.length,
        glance: { pinnedNote: null, encounter: null }
      }
    ])
  })

  it('同篇同句重复圈同一个表达只保留一条关联', () => {
    const first = collect(database, article, 0, 'approach')
    const second = collect(database, article, 0, 'approach', { now: T1 })

    expect(second.status).toBe('duplicate')
    if (first.status !== 'collected' || second.status !== 'duplicate') return
    expect(second.entry).toMatchObject({ sentenceCount: 1, articleCount: 1 })
    expect(second.sentence.id).toBe(first.sentence.id)
    expect(second.marks).toHaveLength(1)
    expect(collect(database, article, 0, 'approach', { now: T2 }).status).toBe('duplicate')
  })

  it('同一篇里换个词形再圈，仍归到同一个词条下', () => {
    const first = collect(database, article, 0, 'approach')
    const second = collect(database, article, 0, 'Approaching', { now: T1 })

    expect(first.status).toBe('collected')
    expect(second.status).toBe('collected')
    if (first.status !== 'collected' || second.status !== 'collected') return
    expect(second.entry.id).toBe(first.entry.id)
    expect(second.entry).toMatchObject({
      mainForm: 'approach',
      variants: ['Approaching'],
      sentenceCount: 2,
      articleCount: 1
    })
    expect(second.sentence.surface).toBe('Approaching')
  })

  it('常见词形变化（大小写、-ing、-ed、-s）归到同一词条', () => {
    const first = collect(database, article, 0, 'approach')
    expect(first.status).toBe('collected')
    if (first.status !== 'collected') return

    for (const [paragraphIndex, surface] of [
      [0, 'Approaching'],
      [1, 'approached'],
      [4, 'approaches']
    ] as const) {
      const result = collect(database, article, paragraphIndex, surface)
      expect(result.status).toBe('collected')
      if (result.status !== 'collected') return
      expect(result.entry.id).toBe(first.entry.id)
    }

    const card = readWordEntryCard(database, first.entry.id)
    expect(card?.entry.sentenceCount).toBe(4)
    expect(card?.sentences.map((sentence) => sentence.surface).sort()).toEqual([
      'Approaching',
      'approach',
      'approached',
      'approaches'
    ])
  })

  it('派生词单独成条', () => {
    const base = collect(database, article, 0, 'approach')
    const derived = collect(database, article, 1, 'approachable')

    expect(base.status).toBe('collected')
    expect(derived.status).toBe('collected')
    if (base.status !== 'collected' || derived.status !== 'collected') return
    expect(derived.entry.id).not.toBe(base.entry.id)
    expect(derived.entry.mainForm).toBe('approachable')
  })

  it('装了词典时按 ECDICT 的 lemma 归并，规则猜不出的不规则变化也并得上', () => {
    const file = join(directory, 'ecdict.db')
    writeDictionaryFixture(file, {
      entries: [
        {
          word: 'drink',
          phonetic: 'drɪŋk',
          translation: 'v. 喝\\nn. 饮料',
          exchange: 'p:drank/d:drunk/i:drinking/3:drinks'
        }
      ],
      lemmas: [{ form: 'drank', lemma: 'drink' }]
    })
    const dictionary = openDictionary(file)
    if (dictionary === null) throw new Error('fixture 词典打不开')
    try {
      const first = collectSelection(database, selection(article, 5, 'drank'), {
        now: T0,
        dictionary
      })
      const second = collectSelection(database, selection(article, 5, 'drink', { from: 30 }), {
        now: T1,
        dictionary
      })

      expect(first.status).toBe('collected')
      expect(second.status).toBe('collected')
      if (first.status !== 'collected' || second.status !== 'collected') return
      expect(second.entry.id).toBe(first.entry.id)
      expect(second.entry).toMatchObject({
        mainForm: 'drank',
        variants: ['drink'],
        sentenceCount: 2
      })
    } finally {
      dictionary.close()
    }
  })

  it('短语按整条收，来自不同句子时累加原句', () => {
    const first = collect(database, article, 2, 'Language learners')
    const second = collect(database, article, 3, 'Language learners', { now: T1 })

    expect(first.status).toBe('collected')
    expect(second.status).toBe('collected')
    if (first.status !== 'collected' || second.status !== 'collected') return
    expect(second.entry.id).toBe(first.entry.id)
    expect(second.entry.mainForm).toBe('Language learners')
    expect(second.entry).toMatchObject({ sentenceCount: 2, articleCount: 1 })
  })

  it('跨文章的同一个词归到同一词条，文章数跟着涨', () => {
    const first = collect(database, article, 0, 'approach')
    const second = collect(database, otherArticle, 0, 'approaches', { now: T1 })

    expect(first.status).toBe('collected')
    expect(second.status).toBe('collected')
    if (first.status !== 'collected' || second.status !== 'collected') return
    expect(second.entry.id).toBe(first.entry.id)
    expect(second.entry).toMatchObject({ sentenceCount: 2, articleCount: 2 })
  })

  it('选区两端空白会被收紧，存的仍是原文切片', () => {
    const result = collect(database, article, 0, 'approach', { offsetEnd: 1 })

    expect(result.status).toBe('collected')
    if (result.status !== 'collected') return
    expect(result.sentence.surface).toBe('approach')
    expect(result.sentence.end - result.sentence.start).toBe('approach'.length)
  })

  it('不是同一句、越界或空选区都不收，并说明原因', () => {
    const firstParagraph = paragraphAt(article, 0)
    const secondSentenceStarts = firstParagraph.sentences[1]

    expect(
      collectSelection(database, {
        articleId: article.id,
        paragraphId: firstParagraph.id,
        sentenceOrdinal: 0,
        start: 0,
        end: secondSentenceStarts ? secondSentenceStarts.end : 0
      })
    ).toEqual({ status: 'rejected', reason: 'range' })

    expect(
      collectSelection(database, {
        articleId: article.id,
        paragraphId: firstParagraph.id,
        sentenceOrdinal: 0,
        start: 0,
        end: 0
      })
    ).toEqual({ status: 'rejected', reason: 'empty' })

    expect(
      collectSelection(database, {
        articleId: 'nope',
        paragraphId: firstParagraph.id,
        sentenceOrdinal: 0,
        start: 0,
        end: 1
      })
    ).toEqual({ status: 'rejected', reason: 'article' })

    expect(
      collectSelection(database, {
        articleId: article.id,
        paragraphId: 'nope',
        sentenceOrdinal: 0,
        start: 0,
        end: 1
      })
    ).toEqual({ status: 'rejected', reason: 'paragraph' })

    expect(
      collectSelection(database, {
        articleId: article.id,
        paragraphId: firstParagraph.id,
        sentenceOrdinal: 9,
        start: 0,
        end: 1
      })
    ).toEqual({ status: 'rejected', reason: 'sentence' })

    expect(
      collectSelection(database, {
        articleId: article.id,
        paragraphId: firstParagraph.id,
        sentenceOrdinal: 0,
        start: -1,
        end: 4
      })
    ).toEqual({ status: 'rejected', reason: 'range' })

    // 只圈到标点不算一个词。
    const period = firstParagraph.text.indexOf('.')
    expect(
      collectSelection(database, {
        articleId: article.id,
        paragraphId: firstParagraph.id,
        sentenceOrdinal: 0,
        start: period,
        end: period + 1
      })
    ).toEqual({ status: 'rejected', reason: 'empty' })
  })

  it('只返回这一篇的已收集标记', () => {
    collect(database, article, 0, 'approach')
    collect(database, otherArticle, 0, 'approaches')

    const marks = readArticleCollections(database, article.id)
    expect(marks).toHaveLength(1)
    expect(marks[0]).toMatchObject({ surface: 'approach', entryMainForm: 'approach' })
    expect(readArticleCollections(database, otherArticle.id)).toHaveLength(1)
  })
})

describe('readWordEntryCard', () => {
  it('给出词条计数、变体与按收集时间倒序的原句', () => {
    const first = collect(database, article, 0, 'Approaching', { now: T0 })
    collect(database, article, 1, 'approached', { now: T1 })
    collect(database, otherArticle, 0, 'approaches', { now: T2 })

    if (first.status !== 'collected') return
    const card = readWordEntryCard(database, first.entry.id)
    expect(card?.entry).toMatchObject({
      mainForm: 'Approaching',
      variants: ['approached', 'approaches'],
      sentenceCount: 3,
      articleCount: 2
    })
    expect(card?.sentences.map((sentence) => sentence.articleTitle)).toEqual([
      '2026年6月 · 第2套 · 仔细阅读 Passage Two',
      '2026年6月 · 第1套 · 仔细阅读 Passage One',
      '2026年6月 · 第1套 · 仔细阅读 Passage One'
    ])
    expect(card?.sentences[0]).toMatchObject({
      surface: 'approaches',
      paragraphOrdinal: 1,
      sentenceOrdinal: 0,
      sentenceText: 'Another passage approaches the same idea.'
    })
  })

  it('词条不存在时返回 null', () => {
    expect(readWordEntryCard(database, 'nope')).toBeNull()
  })
})

describe('readEntrySentenceTarget', () => {
  it('给出阅读页要定位的原句与它的词条', () => {
    const collected = collect(database, article, 0, 'approach')
    expect(collected.status).toBe('collected')
    if (collected.status !== 'collected') return

    expect(readEntrySentenceTarget(database, collected.sentence.id)).toMatchObject({
      entry: { id: collected.entry.id, mainForm: 'approach' },
      sentence: {
        id: collected.sentence.id,
        articleId: article.id,
        sentenceText: 'Employers approach hiring differently.'
      }
    })
    expect(readEntrySentenceTarget(database, 'nope')).toBeNull()
  })
})

describe('deleteEntrySentence', () => {
  it('删掉一条原句后计数与标记同步更新', () => {
    const first = collect(database, article, 0, 'approach')
    const second = collect(database, article, 1, 'approached')
    expect(first.status).toBe('collected')
    expect(second.status).toBe('collected')
    if (first.status !== 'collected' || second.status !== 'collected') return

    const result = deleteEntrySentence(database, second.sentence.id)

    expect(result).toMatchObject({ status: 'deleted', entryDeleted: false })
    if (result.status !== 'deleted') return
    expect(result.entry).toMatchObject({ sentenceCount: 1, articleCount: 1 })
    expect(result.articleId).toBe(article.id)
    expect(result.marks).toEqual([expect.objectContaining({ id: first.sentence.id })])
    expect(readWordEntryCard(database, first.entry.id)?.entry.sentenceCount).toBe(1)
  })

  it('删另一篇文章里的原句时，返回的标记只属于那一篇', () => {
    const first = collect(database, article, 0, 'approach')
    const second = collect(database, otherArticle, 0, 'approaches')
    expect(first.status).toBe('collected')
    expect(second.status).toBe('collected')
    if (first.status !== 'collected' || second.status !== 'collected') return

    const result = deleteEntrySentence(database, second.sentence.id)

    expect(result.status).toBe('deleted')
    if (result.status !== 'deleted') return
    expect(result.articleId).toBe(otherArticle.id)
    expect(result.marks).toEqual([])
    expect(result.entry).toMatchObject({ sentenceCount: 1, articleCount: 1 })
    // 正在读的那一篇不受影响。
    expect(readArticleCollections(database, article.id)).toHaveLength(1)
  })

  it('删掉最后一条原句时连词条一起删，标记清空', () => {
    const collected = collect(database, article, 0, 'approach')
    expect(collected.status).toBe('collected')
    if (collected.status !== 'collected') return

    const result = deleteEntrySentence(database, collected.sentence.id)

    expect(result).toEqual({
      status: 'deleted',
      entryDeleted: true,
      entry: null,
      articleId: article.id,
      marks: []
    })
    expect(readWordEntryCard(database, collected.entry.id)).toBeNull()
    expect(readArticleCollections(database, article.id)).toEqual([])
  })

  it('删掉最近收集的那条后，词条的最近收集回到剩下最晚的一条', () => {
    const first = collect(database, article, 0, 'approach', { now: T0 })
    const second = collect(database, article, 1, 'approached', { now: T1 })
    expect(first.status).toBe('collected')
    expect(second.status).toBe('collected')
    if (first.status !== 'collected' || second.status !== 'collected') return

    const result = deleteEntrySentence(database, second.sentence.id)

    expect(result.status).toBe('deleted')
    if (result.status !== 'deleted') return
    expect(result.entry?.lastCollectedAt).toBe(T0)
  })

  it('删不存在的原句返回 missing，不碰别的条目', () => {
    const collected = collect(database, article, 0, 'approach')
    expect(collected.status).toBe('collected')
    if (collected.status !== 'collected') return

    expect(deleteEntrySentence(database, 'nope')).toEqual({ status: 'missing' })
    expect(readWordEntryCard(database, collected.entry.id)?.entry.sentenceCount).toBe(1)
  })
})
