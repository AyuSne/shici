import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EntrySentenceSnapshot } from '../../shared/entries'
import {
  fixtureArticle,
  writeCorpusDirectory,
  type FixtureEntry
} from '../../testing/corpus-fixture'
import { importCorpus } from '../corpus/import'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { deleteArticle, readArticleDeletionPreview } from '../library/articles'
import {
  collectSelection,
  deleteEntrySentence,
  readArticleCollections,
  readWordEntryCard
} from './queries'
import { restoreEntrySentence } from './sentence-undo'
import { changeEntryMainForm, reselectEntrySentence } from './curation'

const T0 = '2026-11-18T08:00:00.000Z'
const T1 = '2026-11-18T08:05:00.000Z'

const article = fixtureArticle({
  id: 'fixture-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['She approached the counter quietly.', 'The approachable clerk smiled.']
  ]
})

type JsonParagraph = {
  id: string
  text: string
  sentences: { ordinal: number; text: string; start: number; end: number }[]
}

function paragraphAt(entry: FixtureEntry, index: number): JsonParagraph {
  return (entry.json.paragraphs as JsonParagraph[])[index] as JsonParagraph
}

function collect(
  entry: FixtureEntry,
  paragraphIndex: number,
  needle: string,
  now: string,
  options: { from?: number } = {}
) {
  const paragraph = paragraphAt(entry, paragraphIndex)
  const start = paragraph.text.indexOf(needle, options.from ?? 0)
  if (start < 0) throw new Error(`fixture ${entry.id} 第 ${paragraphIndex} 段没有 ${needle}`)
  const sentenceOrdinal = paragraph.sentences.findIndex(
    (candidate) => candidate.start <= start && start < candidate.end
  )
  return collectSelection(
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
}

/*
 * 这些夹具步骤必须让「没准备好」立刻失败：以前的 `if (status !== ...) return`
 * 会在上游行为变化时静默跳过整段断言，测试仍然显示通过。
 */
type CollectedSelection = Extract<
  Awaited<ReturnType<typeof collectSelection>>,
  { status: 'collected' }
>
type DeletedSentence = Extract<
  Awaited<ReturnType<typeof deleteEntrySentence>>,
  { status: 'deleted' }
>
type RestoredSentence = Extract<
  Awaited<ReturnType<typeof restoreEntrySentence>>,
  { status: 'restored' }
>

function requireCollected(result: ReturnType<typeof collect>): CollectedSelection {
  if (result.status !== 'collected') {
    throw new Error(`夹具收词没有成功：${result.status}`)
  }
  return result
}

function requireDeleted(result: ReturnType<typeof deleteEntrySentence>): DeletedSentence {
  if (result.status !== 'deleted') {
    throw new Error(`夹具删除没有成功：${result.status}`)
  }
  return result
}

function requireRestored(result: ReturnType<typeof restoreEntrySentence>): RestoredSentence {
  if (result.status !== 'restored') {
    throw new Error(`夹具恢复没有成功：${result.status}`)
  }
  return result
}

const secondArticle = fixtureArticle({  id: 'fixture-2026-06-s2-c2',
  year: 2026,
  month: 6,
  set: 2,
  label: '2026年6月 · 第2套 · 仔细阅读 Passage Two',
  sentences: [['Another passage approaches the same idea.', 'It reaches a different conclusion.']]
})

let directory: string
let database: AppDatabase

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-sentence-undo-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
  writeCorpusDirectory(directory, [article, secondArticle])
  importCorpus(database, { directory })
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function snapshotOf(
  sentence: {
    id: string
    articleId: string
    paragraphId: string
    sentenceOrdinal: number
    surface: string
    start: number
    end: number
    collectedAt: string
  },
  entryId: string
): EntrySentenceSnapshot {
  return {
    id: sentence.id,
    entryId,
    articleId: sentence.articleId,
    paragraphId: sentence.paragraphId,
    sentenceOrdinal: sentence.sentenceOrdinal,
    surface: sentence.surface,
    start: sentence.start,
    end: sentence.end,
    collectedAt: sentence.collectedAt
  }
}

describe('restoreEntrySentence', () => {
  it('非最后一条原句的删除结果带回可撤销快照', () => {
    const first = requireCollected(collect(article, 0, 'approach', T0))
    requireCollected(collect(article, 1, 'approached', T1))

    const deleted = requireDeleted(deleteEntrySentence(database, first.sentence.id))

    expect(deleted.snapshot).toEqual({
      id: first.sentence.id,
      entryId: first.entry.id,
      articleId: article.id,
      paragraphId: first.sentence.paragraphId,
      sentenceOrdinal: first.sentence.sentenceOrdinal,
      surface: 'approach',
      start: first.sentence.start,
      end: first.sentence.end,
      collectedAt: T0
    })
  })

  it('按快照恢复非最后一条原句：原 id、词形、句锚点与收集时间都不变', () => {
    const first = requireCollected(collect(article, 0, 'approach', T0))
    const second = requireCollected(collect(article, 1, 'approached', T1))

    const snapshot = snapshotOf(first.sentence, first.entry.id)
    const deleted = deleteEntrySentence(database, first.sentence.id)
    expect(deleted.status).toBe('deleted')
    expect(readWordEntryCard(database, first.entry.id)?.entry.sentenceCount).toBe(1)

    const restored = requireRestored(restoreEntrySentence(database, snapshot))
    expect(restored.entry).toMatchObject({
      id: first.entry.id,
      sentenceCount: 2,
      articleCount: 1,
      lastCollectedAt: T1
    })
    expect(restored.sentence).toMatchObject({
      id: first.sentence.id,
      surface: 'approach',
      articleId: article.id,
      paragraphId: snapshot.paragraphId,
      sentenceOrdinal: snapshot.sentenceOrdinal,
      start: snapshot.start,
      end: snapshot.end,
      collectedAt: T0
    })
    expect(readArticleCollections(database, article.id).map((mark) => mark.id)).toEqual([
      first.sentence.id,
      second.sentence.id
    ])
  })

  it('重复恢复同一条不新增关联、不改变计数', () => {
    const first = requireCollected(collect(article, 0, 'approach', T0))
    requireCollected(collect(article, 1, 'approached', T1))
    const snapshot = snapshotOf(first.sentence, first.entry.id)
    expect(deleteEntrySentence(database, first.sentence.id).status).toBe('deleted')

    const once = requireRestored(restoreEntrySentence(database, snapshot))
    const twice = requireRestored(restoreEntrySentence(database, snapshot))

    expect(once.entry.sentenceCount).toBe(2)
    expect(twice).toMatchObject({ entry: { sentenceCount: 2 } })
    expect(twice.sentence.collectedAt).toBe(T0)
    expect(readWordEntryCard(database, first.entry.id)?.entry.sentenceCount).toBe(2)
    expect(readArticleCollections(database, article.id)).toHaveLength(2)
  })

  it('原文已删除时拒绝恢复，不复活已删文章与原句', () => {
    const inDeleted = requireCollected(collect(article, 0, 'approach', T0))
    requireCollected(collect(secondArticle, 0, 'approaches', T1))
    const snapshot = snapshotOf(inDeleted.sentence, inDeleted.entry.id)
    expect(deleteEntrySentence(database, inDeleted.sentence.id).status).toBe('deleted')
    const preview = readArticleDeletionPreview(database, article.id)
    if (preview === null) throw new Error('文章应当在库里')
    expect(deleteArticle(database, { articleId: article.id, confirmed: preview }).status).toBe('deleted')

    const restored = restoreEntrySentence(database, snapshot)

    expect(restored).toEqual({ status: 'rejected', reason: 'source' })
    expect(readWordEntryCard(database, inDeleted.entry.id)?.entry.sentenceCount).toBe(1)
  })

  it('词条已被删除时拒绝恢复，不新建空词条', () => {
    const first = requireCollected(collect(article, 0, 'approach', T0))
    const last = requireCollected(collect(article, 1, 'approached', T1))
    const snapshot = snapshotOf(first.sentence, first.entry.id)
    expect(deleteEntrySentence(database, first.sentence.id).status).toBe('deleted')
    expect(deleteEntrySentence(database, last.sentence.id)).toMatchObject({ entryDeleted: true })

    const restored = restoreEntrySentence(database, snapshot)

    expect(restored).toEqual({ status: 'rejected', reason: 'entry' })
    expect(readWordEntryCard(database, first.entry.id)).toBeNull()
  })

  it('快照与现存原文不再逐字对应时拒绝恢复', () => {
    const first = requireCollected(collect(article, 0, 'approach', T0))
    requireCollected(collect(article, 1, 'approached', T1))
    const snapshot = snapshotOf(first.sentence, first.entry.id)
    expect(deleteEntrySentence(database, first.sentence.id).status).toBe('deleted')

    const restored = restoreEntrySentence(database, {
      ...snapshot,
      surface: 'approachable'
    })

    expect(restored).toEqual({ status: 'rejected', reason: 'source' })
    expect(readWordEntryCard(database, first.entry.id)?.entry.sentenceCount).toBe(1)
  })

  it('删除后同一句又被收过时不覆盖后来的关联', () => {
    const first = requireCollected(collect(article, 0, 'approach', T0))
    requireCollected(collect(article, 1, 'approached', T1))
    const snapshot = snapshotOf(first.sentence, first.entry.id)
    expect(deleteEntrySentence(database, first.sentence.id).status).toBe('deleted')
    const again = requireCollected(collect(article, 0, 'approach', T1))

    const restored = restoreEntrySentence(database, snapshot)

    expect(restored).toEqual({ status: 'rejected', reason: 'conflict' })
    const card = readWordEntryCard(database, first.entry.id)
    expect(card?.entry.sentenceCount).toBe(2)
    expect(card?.sentences.map((sentence) => sentence.id)).toContain(again.sentence.id)
    expect(card?.sentences.map((sentence) => sentence.id)).not.toContain(first.sentence.id)
  })

  it('恢复不覆盖后来改过的主词形', () => {
    const first = requireCollected(collect(article, 0, 'approach', T0))
    requireCollected(collect(article, 1, 'approached', T1))
    const snapshot = snapshotOf(first.sentence, first.entry.id)
    expect(deleteEntrySentence(database, first.sentence.id).status).toBe('deleted')
    const changed = changeEntryMainForm(database, {
      entryId: first.entry.id,
      mainForm: 'approached'
    })
    expect(changed.status).toBe('changed')

    const restored = requireRestored(restoreEntrySentence(database, snapshot))

    expect(restored.entry.mainForm).toBe('approached')
    expect(restored.sentence.surface).toBe('approach')
  })

  it('同 id 同锚点后来重新圈定过：旧快照必须 conflict，绝不谎报恢复并保留新 quote', () => {
    const first = requireCollected(collect(article, 0, 'approach', T0))
    const second = requireCollected(collect(article, 1, 'approached', T1))
    const snapshot = snapshotOf(first.sentence, first.entry.id)
    expect(deleteEntrySentence(database, first.sentence.id).status).toBe('deleted')
    expect(restoreEntrySentence(database, snapshot).status).toBe('restored')

    // 恢复之后，用户又用同一条关联在同一句里重新圈定了另一个词形。
    const reselected = reselectEntrySentence(database, {
      entrySentenceId: first.sentence.id,
      start: 0,
      end: 'Employers'.length
    })
    expect(reselected.status).toBe('resaved')
    if (reselected.status !== 'resaved') throw new Error('重新圈定没有成功')
    expect(reselected.sentence.surface).toBe('Employers')

    const stale = restoreEntrySentence(database, snapshot)

    expect(stale).toEqual({ status: 'rejected', reason: 'conflict' })
    const card = readWordEntryCard(database, first.entry.id)
    const stored = card?.sentences.find((sentence) => sentence.id === first.sentence.id)
    expect(stored).toMatchObject({ surface: 'Employers', start: 0, end: 9 })
    expect(readArticleCollections(database, article.id).map((mark) => mark.id)).toEqual([
      first.sentence.id,
      second.sentence.id
    ])
  })

  it('非整数 / 非有限 / 越界的快照区间一律拒绝，不写脏数据', () => {
    const first = requireCollected(collect(article, 0, 'approach', T0))
    const second = requireCollected(collect(article, 1, 'approached', T1))
    const snapshot = snapshotOf(first.sentence, first.entry.id)
    expect(deleteEntrySentence(database, first.sentence.id).status).toBe('deleted')

    const malformed = [
      { ...snapshot, start: snapshot.start + 0.5 },
      { ...snapshot, end: snapshot.end + 0.5 },
      { ...snapshot, start: Number.NaN },
      { ...snapshot, end: Number.POSITIVE_INFINITY },
      { ...snapshot, sentenceOrdinal: snapshot.sentenceOrdinal + 0.5 }
    ]
    for (const candidate of malformed) {
      expect(restoreEntrySentence(database, candidate)).toEqual({
        status: 'rejected',
        reason: 'conflict'
      })
    }
    // 有限但越界的整数区间按「与原文对不上」拒绝。
    expect(restoreEntrySentence(database, { ...snapshot, end: 999999 })).toEqual({
      status: 'rejected',
      reason: 'source'
    })
    expect(readWordEntryCard(database, first.entry.id)?.entry.sentenceCount).toBe(1)
    expect(readArticleCollections(database, article.id).map((mark) => mark.id)).toEqual([
      second.sentence.id
    ])
  })

  it('同 id 但收集时间已经被改写的旧快照也判 conflict', () => {
    const first = requireCollected(collect(article, 0, 'approach', T0))
    requireCollected(collect(article, 1, 'approached', T1))
    const snapshot = snapshotOf(first.sentence, first.entry.id)
    expect(deleteEntrySentence(database, first.sentence.id).status).toBe('deleted')
    expect(restoreEntrySentence(database, snapshot).status).toBe('restored')

    const stale = restoreEntrySentence(database, {
      ...snapshot,
      collectedAt: '2026-11-18T07:00:00.000Z'
    })

    expect(stale).toEqual({ status: 'rejected', reason: 'conflict' })
    expect(
      readWordEntryCard(database, first.entry.id)?.sentences.find(
        (sentence) => sentence.id === first.sentence.id
      )?.collectedAt
    ).toBe(T0)
  })
})
