import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CollectSelectionRequest } from '../../shared/entries'
import type { ThreadContextItem } from '../../shared/threads'
import { fixtureArticle, writeCorpusDirectory, type FixtureEntry } from '../../testing/corpus-fixture'
import { importCorpus } from '../corpus/import'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { createLearningNote } from '../entries/notes'
import { collectSelection, deleteEntrySentence } from '../entries/queries'
import {
  askQuestion,
  createGroupThread,
  createThread,
  editQuestion,
  listThreads,
  findRecentThreadForMain,
  openThreadForMain,
  readContextCandidates,
  readArticleContextMaterials,
  readThreadView,
  saveAnswer,
  saveContinuation,
  switchAnswer,
  switchQuestion,
  updateThreadContext
} from './threads'

const T0 = '2026-11-18T08:00:00.000Z'
const T1 = '2026-11-18T08:05:00.000Z'
const T2 = '2026-11-18T08:10:00.000Z'
const T3 = '2026-11-18T08:15:00.000Z'
const T4 = '2026-11-18T09:00:00.000Z'

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

const longMatch = fixtureArticle({
  id: 'fixture-2026-06-s1-b',
  year: 2026,
  month: 6,
  set: 1,
  kind: 'long_match',
  sentences: [['First paragraph here.'], ['Nothing on approach.'], ['Another approach appears here.']]
})

/** 每个词只出现一次，用来一次凑够 21 个不同词条。 */
const MANY_WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf',
  'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november',
  'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform'
] as const

const manyWords = fixtureArticle({
  id: 'fixture-many-words',
  sentences: [0, 1, 2].map((paragraph) =>
    MANY_WORDS.slice(paragraph * 7, paragraph * 7 + 7).map(
      (word) => `The ${word} belongs to this practice sentence.`
    )
  )
})

type JsonParagraph = {
  id: string
  text: string
  sentences: { ordinal: number; text: string; start: number; end: number }[]
}

function paragraphAt(entry: FixtureEntry, index: number): JsonParagraph {
  return (entry.json.paragraphs as JsonParagraph[])[index] as JsonParagraph
}

function selection(entry: FixtureEntry, paragraphIndex: number, needle: string): CollectSelectionRequest {
  const paragraph = paragraphAt(entry, paragraphIndex)
  const start = paragraph.text.indexOf(needle)
  if (start < 0) {
    throw new Error(`fixture ${entry.id}: 第 ${paragraphIndex} 段没有 ${needle}`)
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
  database: AppDatabase,
  entry: FixtureEntry,
  paragraphIndex: number,
  needle: string,
  now: string
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
  directory = mkdtempSync(join(tmpdir(), 'english-learning-threads-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
  writeCorpusDirectory(directory, [firstArticle, longMatch, manyWords])
  importCorpus(database, { directory })
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** approach 收 3 句（跨两篇），Context 收 1 句，并给 approach 写一条学习内容。 */
function seed(): {
  approachEntryId: string
  approachSentenceIds: string[]
  contextEntryId: string
  contextSentenceId: string
  latestSentenceId: string
} {
  const first = collect(database, firstArticle, 0, 'approach', T0)
  const second = collect(database, firstArticle, 0, 'Approaching', T1)
  const third = collect(database, longMatch, 2, 'approach', T2)
  const context = collect(database, firstArticle, 2, 'Context', T3)
  createLearningNote(
    database,
    { entryId: first.entry.id, body: 'approach 强调着手；approachable 是形容词。' },
    { now: T3 }
  )
  return {
    approachEntryId: first.entry.id,
    approachSentenceIds: [first.sentence.id, second.sentence.id, third.sentence.id],
    contextEntryId: context.entry.id,
    contextSentenceId: context.sentence.id,
    latestSentenceId: third.sentence.id
  }
}

/** 收下前 count 个互不相同的词，返回词条 id；每个词条只有一条原句。 */
function collectManyWords(count: number): string[] {
  return MANY_WORDS.slice(0, count).map((word, index) => {
    const paragraphIndex = Math.floor(index / 7)
    return collect(
      database,
      manyWords,
      paragraphIndex,
      word,
      new Date(Date.UTC(2026, 10, 19, 8, index)).toISOString()
    ).entry.id
  })
}

function itemIds(items: readonly ThreadContextItem[]): string[] {
  return items.map((item) => item.id)
}

describe('按主对象打开线程', () => {
  it('重复打开同一词条复用原线程', () => {
    const seeded = seed()
    const main = { kind: 'entry' as const, entryId: seeded.approachEntryId }
    const first = openThreadForMain(database, { main }, { now: T1 })
    const second = openThreadForMain(database, { main }, { now: T2 })
    expect(first.status).toBe('created')
    expect(second.status).toBe('reused')
    if (first.status === 'rejected' || second.status === 'rejected') return
    expect(second.thread.id).toBe(first.thread.id)
    expect(listThreads(database).threads).toHaveLength(1)
  })

  it('从阅读页重新提问时补回所点的词和原句，同时保留用户加入的其他上下文', () => {
    const seeded = seed()
    const main = { kind: 'sentence' as const, entrySentenceId: seeded.approachSentenceIds[0] as string }
    const first = openThreadForMain(database, { main }, { now: T0 })
    if (first.status === 'rejected') throw new Error('open failed')
    const extra = readContextCandidates(database, first.thread.id).items.find(
      (item) => item.id === `sentence:${seeded.approachSentenceIds[1]}`
    )
    if (!extra) throw new Error('missing extra context')
    updateThreadContext(database, { threadId: first.thread.id, items: [extra] }, { now: T1 })

    const ordinary = openThreadForMain(database, { main }, { now: T2 })
    if (ordinary.status === 'rejected') throw new Error('open failed')
    expect(itemIds(ordinary.thread.context)).toEqual([extra.id])

    const restored = openThreadForMain(database, { main, ensureSentenceContext: true }, { now: T3 })
    if (restored.status === 'rejected') throw new Error('open failed')
    expect(restored.status).toBe('reused')
    expect(restored.thread.id).toBe(first.thread.id)
    expect(itemIds(restored.thread.context)).toEqual([
      extra.id, `word:${seeded.approachEntryId}`, `sentence:${main.entrySentenceId}`
    ])
    expect(readThreadView(database, first.thread.id)?.context).toEqual(restored.thread.context)
    const again = openThreadForMain(database, { main, ensureSentenceContext: true }, { now: T4 })
    if (again.status === 'rejected') throw new Error('open failed')
    expect(again.thread.context).toEqual(restored.thread.context)
  })

  it('超过一百条材料仍可复用对话并补回原句', () => {
    const seeded = seed()
    const main = { kind: 'sentence' as const, entrySentenceId: seeded.approachSentenceIds[0] as string }
    const first = openThreadForMain(database, { main }, { now: T0 })
    if (first.status === 'rejected') throw new Error('open failed')
    const extras: ThreadContextItem[] = Array.from({ length: 101 }, (_, index) => ({
      id: `note:${index}`, kind: 'note', label: `内容 ${index}`, text: `内容 ${index}`, source: ''
    }))
    updateThreadContext(database, { threadId: first.thread.id, items: extras }, { now: T1 })
    const reopened = openThreadForMain(database, { main, ensureSentenceContext: true }, { now: T2 })
    if (reopened.status === 'rejected') throw new Error('open failed')
    expect(reopened.thread.context).toHaveLength(103)
    expect(itemIds(reopened.thread.context)).toContain(`sentence:${main.entrySentenceId}`)
  })

  it('按完整主对象区分线程，明确新开后按最近更新复用', () => {
    const seeded = seed()
    const main = { kind: 'entry' as const, entryId: seeded.approachEntryId }
    const first = openThreadForMain(database, { main }, { now: T0 })
    const second = openThreadForMain(database, { main, forceNew: true }, { now: T1 })
    const sentence = openThreadForMain(database, {
      main: { kind: 'sentence', entrySentenceId: seeded.approachSentenceIds[0] as string }
    }, { now: T3 })
    const article = openThreadForMain(database, {
      main: { kind: 'article', articleId: firstArticle.id }
    }, { now: T4 })
    if (first.status === 'rejected' || second.status === 'rejected' ||
        sentence.status === 'rejected' || article.status === 'rejected') throw new Error('open failed')
    expect(new Set([first.thread.id, second.thread.id, sentence.thread.id, article.thread.id]).size).toBe(4)
    expect(findRecentThreadForMain(database, main)?.id).toBe(second.thread.id)
    askQuestion(database, { threadId: first.thread.id, text: '继续这个问题' }, { now: T2 })
    expect(findRecentThreadForMain(database, main)?.id).toBe(first.thread.id)
    expect(openThreadForMain(database, { main }, { now: T4 })).toMatchObject({
      status: 'reused', thread: { id: first.thread.id }
    })
  })

  it('空白线程每次新建，不把缺失的对象当作空白线程', () => {
    const seeded = seed()
    const main = { kind: 'sentence' as const, entrySentenceId: seeded.approachSentenceIds[0] as string }
    const existing = openThreadForMain(database, { main }, { now: T0 })
    if (existing.status === 'rejected') throw new Error('open failed')
    deleteEntrySentence(database, main.entrySentenceId)
    expect(findRecentThreadForMain(database, main)).toBeNull()
    expect(openThreadForMain(database, { main })).toEqual({ status: 'rejected', reason: 'missing-main' })
    expect(readThreadView(database, existing.thread.id)?.missingMain).toBe('sentence')
    const firstBlank = openThreadForMain(database, { main: { kind: 'none' } })
    const secondBlank = openThreadForMain(database, { main: { kind: 'none' } })
    if (firstBlank.status === 'rejected' || secondBlank.status === 'rejected') throw new Error('open failed')
    expect(firstBlank.thread.id).not.toBe(secondBlank.thread.id)
    expect(findRecentThreadForMain(database, { kind: 'none' })).toBeNull()
  })

  it('同时刻新开的两条线程以后一条作为最近线程', () => {
    const main = { kind: 'article' as const, articleId: firstArticle.id }
    const first = openThreadForMain(database, { main, forceNew: true }, { now: T4 })
    const second = openThreadForMain(database, { main, forceNew: true }, { now: T4 })
    if (first.status === 'rejected' || second.status === 'rejected') throw new Error('open failed')
    expect(second.thread.id).not.toBe(first.thread.id)
    expect(findRecentThreadForMain(database, main)?.id).toBe(second.thread.id)
  })
})

describe('createThread', () => {
  it('挂词条时预填主词形与最近收的原句，标题用主词形', () => {
    const seeded = seed()
    const result = createThread(database, { main: { kind: 'entry', entryId: seeded.approachEntryId } }, { now: T4 })
    expect(result.status).toBe('created')
    if (result.status !== 'created') return

    const thread = result.thread
    expect(thread.title).toBe('approach')
    expect(thread.main).toMatchObject({
      kind: 'entry',
      entryId: seeded.approachEntryId,
      mainForm: 'approach',
      sentenceCount: 3,
      articleCount: 2
    })
    expect(itemIds(thread.context)).toEqual([
      `word:${seeded.approachEntryId}`,
      `sentence:${seeded.latestSentenceId}`
    ])
    expect(thread.context[0]).toMatchObject({ kind: 'word', text: 'approach' })
    expect(thread.context[1]).toMatchObject({
      kind: 'sentence',
      label: 'approach',
      text: 'Another approach appears here.'
    })
    expect(thread.contextSummary.sentenceCount).toBe(1)
    expect(thread.contextSummary.charCount).toBe(
      Array.from('approachAnother approach appears here.').length
    )
    expect(thread.turns).toEqual([])
  })

  it('挂原句时预填词与这一句，并给出出处', () => {
    const seeded = seed()
    const sentenceId = seeded.approachSentenceIds[1] as string
    const result = createThread(database, { main: { kind: 'sentence', entrySentenceId: sentenceId } }, { now: T4 })
    expect(result.status).toBe('created')
    if (result.status !== 'created') return

    expect(result.thread.main).toMatchObject({
      kind: 'sentence',
      entrySentenceId: sentenceId,
      surface: 'Approaching',
      sentenceText: 'Approaching a new desk takes patience.'
    })
    expect(itemIds(result.thread.context)).toEqual([
      `word:${seeded.approachEntryId}`,
      `sentence:${sentenceId}`
    ])
    expect(result.thread.context[1]?.source).toContain('2026年6月 · 第1套 · 仔细阅读 Passage One')
    expect(result.thread.context[1]?.source).toContain('段 1')
  })

  it('文章对话预填完整正文，复用时保留用户调整', () => {
    const main = { kind: 'article' as const, articleId: longMatch.id }
    const created = openThreadForMain(database, { main }, { now: T0 })
    if (created.status !== 'created') throw new Error('create failed')
    expect(created.thread.context).toMatchObject([{ id: `article:${longMatch.id}`, kind: 'article', text: 'A. First paragraph here.\n\nB. Nothing on approach.\n\nC. Another approach appears here.' }])
    updateThreadContext(database, { threadId: created.thread.id, items: [] })
    const reused = openThreadForMain(database, { main })
    expect(reused.status).toBe('reused')
    if (reused.status === 'reused') expect(reused.thread.context).toEqual([])
  })

  it('空白线程不带上下文，也不允许挂不存在的对象', () => {
    const blank = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    expect(blank.status).toBe('created')
    if (blank.status !== 'created') return
    expect(blank.thread.title).toBe('新的学习')
    expect(blank.thread.main).toEqual({ kind: 'none' })
    expect(blank.thread.context).toEqual([])
    expect(blank.thread.contextSummary).toEqual({ articleCount: 0, paragraphCount: 0, wordCount: 0, sentenceCount: 0, excerptCount: 0, charCount: 0 })

    expect(
      createThread(database, { main: { kind: 'entry', entryId: 'nope' } }, { now: T4 })
    ).toEqual({ status: 'rejected', reason: 'missing-main' })
    expect(
      createThread(database, { main: { kind: 'article', articleId: 'nope' } }, { now: T4 })
    ).toEqual({ status: 'rejected', reason: 'missing-main' })
  })

  it('读不到的线程返回 null', () => {
    expect(readThreadView(database, 'nope')).toBeNull()
  })
})

describe('用一组词开线程', () => {
  it('每次新建一条无主对象的线程，默认上下文是每个词与它最近收的原句', () => {
    const seeded = seed()
    const request = { entryIds: [seeded.approachEntryId, seeded.contextEntryId] }
    const first = createGroupThread(database, request, { now: T4 })
    expect(first.status).toBe('created')
    if (first.status !== 'created') return

    // 不新增主对象类型：组词线程就是一条空白线程，落点自然回到未归档。
    expect(first.thread.main).toEqual({ kind: 'none' })
    expect(first.thread.title).toBe('approach 等 2 个词')
    expect(first.thread.context.map((item) => item.kind)).toEqual([
      'word',
      'sentence',
      'word',
      'sentence'
    ])
    expect(itemIds(first.thread.context)).toEqual([
      `word:${seeded.approachEntryId}`,
      `sentence:${seeded.latestSentenceId}`,
      `word:${seeded.contextEntryId}`,
      `sentence:${seeded.contextSentenceId}`
    ])
    expect(first.thread.context[1]?.text).toBe('Another approach appears here.')
    expect(first.thread.context[3]?.text).toBe('Context keeps the skill alive.')
    expect(first.thread.contextSummary).toEqual({
      articleCount: 0,
      paragraphCount: 0,
      wordCount: 2,
      sentenceCount: 2,
      excerptCount: 0,
      charCount: 75
    })

    // 「用这些词学习」每次都是新线程，不复用空白或组词线程。
    const second = createGroupThread(database, request, { now: '2026-11-18T09:30:00.000Z' })
    expect(second.status).toBe('created')
    if (second.status !== 'created') return
    expect(second.thread.id).not.toBe(first.thread.id)
    const threads = listThreads(database).threads
    expect(threads).toHaveLength(2)
    expect(threads.every((thread) => thread.mainKind === 'none')).toBe(true)
  })

  it('每一问都带提这一问时的词数快照，之后改线程上下文不改变它', () => {
    const seeded = seed()
    const created = createGroupThread(
      database,
      { entryIds: [seeded.approachEntryId, seeded.contextEntryId] },
      { now: T4 }
    )
    if (created.status !== 'created') throw new Error('线程没建起来')
    const asked = askQuestion(
      database,
      { threadId: created.thread.id, text: '用这两个词写一段话。' },
      { now: T4 }
    )
    if (asked.status !== 'asked') throw new Error('提问没写进去')

    const before = readThreadView(database, created.thread.id)
    expect(before?.turns[0]?.question.wordCount).toBe(2)

    // 回答之后把上下文改成只剩一个词：这一问的来源快照仍是两个词。
    updateThreadContext(
      database,
      {
        threadId: created.thread.id,
        items: before?.context.filter((item) => item.id === `word:${seeded.approachEntryId}`) ?? []
      },
      { now: T4 }
    )
    const after = readThreadView(database, created.thread.id)
    expect(after?.contextSummary.wordCount).toBe(1)
    expect(after?.turns[0]?.question.wordCount).toBe(2)
  })

  it('重复词条只算一个；空选择、缺失词条与超过 20 个词条都被拒绝，不静默少词', () => {
    const ids = collectManyWords(21)
    const twenty = createGroupThread(database, { entryIds: ids.slice(0, 20) }, { now: T4 })
    expect(twenty.status).toBe('created')
    if (twenty.status !== 'created') return
    expect(twenty.thread.contextSummary.wordCount).toBe(20)
    expect(twenty.thread.contextSummary.sentenceCount).toBe(20)
    expect(
      twenty.thread.context.filter((item) => item.kind === 'word')
    ).toHaveLength(20)

    expect(createGroupThread(database, { entryIds: ids }, { now: T4 })).toEqual({
      status: 'rejected',
      reason: 'too-many-words'
    })
    expect(createGroupThread(database, { entryIds: [] }, { now: T4 })).toEqual({
      status: 'rejected',
      reason: 'empty'
    })
    expect(
      createGroupThread(database, { entryIds: [ids[0] as string, 'nope'] }, { now: T4 })
    ).toEqual({ status: 'rejected', reason: 'missing-word' })

    // 拒绝的请求一条线程都没有留下。
    expect(listThreads(database).threads).toHaveLength(1)

    const repeated = createGroupThread(
      database,
      { entryIds: [ids[1] as string, ids[1] as string] },
      { now: T4 }
    )
    expect(repeated.status).toBe('created')
    if (repeated.status !== 'created') return
    expect(repeated.thread.title).toBe('bravo')
    expect(repeated.thread.contextSummary.wordCount).toBe(1)
    expect(repeated.thread.contextSummary.sentenceCount).toBe(1)
  })

  it('超过 20 个词的上下文改不动，已经存下的上下文保持原样', () => {
    const ids = collectManyWords(21)
    const created = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    if (created.status !== 'created') throw new Error('create failed')
    const wordItem = (index: number): ThreadContextItem => ({
      id: `word:${ids[index]}`,
      kind: 'word',
      label: `词 ${index}`,
      text: `词 ${index}`,
      source: ''
    })

    const twenty = updateThreadContext(
      database,
      { threadId: created.thread.id, items: ids.slice(0, 20).map((_, index) => wordItem(index)) },
      { now: T4 }
    )
    expect(twenty.status).toBe('saved')
    if (twenty.status !== 'saved') return
    expect(twenty.thread.contextSummary.wordCount).toBe(20)

    expect(
      updateThreadContext(
        database,
        {
          threadId: created.thread.id,
          items: ids.map((_, index) => wordItem(index))
        },
        { now: T4 }
      )
    ).toEqual({ status: 'rejected', reason: 'too-many-words' })
    expect(readThreadView(database, created.thread.id)?.contextSummary.wordCount).toBe(20)
  })

  it('提问时临时带上的上下文同样受 20 个词限制', () => {
    const ids = collectManyWords(21)
    const created = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    if (created.status !== 'created') throw new Error('create failed')
    const items = ids.map((id, index): ThreadContextItem => ({
      id: `word:${id}`,
      kind: 'word',
      label: `词 ${index}`,
      text: `词 ${index}`,
      source: ''
    }))

    expect(
      askQuestion(
        database,
        { threadId: created.thread.id, text: '这些问题怎么用？', context: items },
        { now: T4 }
      )
    ).toEqual({ status: 'rejected', reason: 'too-many-words' })
    expect(readThreadView(database, created.thread.id)?.turns).toHaveLength(0)

    const accepted = askQuestion(
      database,
      { threadId: created.thread.id, text: '这些问题怎么用？', context: items.slice(0, 20) },
      { now: T4 }
    )
    expect(accepted.status).toBe('asked')
  })
})

describe('askQuestion 与回答版本', () => {
  it('提问立刻落库，回答还没来时这条是空的；空白线程用第一问做标题', () => {
    const created = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    if (created.status !== 'created') throw new Error('create failed')

    const asked = askQuestion(
      database,
      {
        threadId: created.thread.id,
        text: '这两个例句里哪个更常用于书面语？'
      },
      { now: '2026-11-18T09:01:00.000Z' }
    )
    expect(asked.status).toBe('asked')
    if (asked.status !== 'asked') return

    expect(asked.thread.title).toBe('这两个例句里哪个更常用于书面语？')
    expect(asked.thread.turns).toHaveLength(1)
    expect(asked.thread.turns[0]?.question).toMatchObject({
      id: asked.questionId,
      text: '这两个例句里哪个更常用于书面语？'
    })
    expect(asked.thread.turns[0]?.answer).toBeNull()
    expect(asked.thread.turns[0]?.question.versions).toEqual([
      { id: asked.questionId, selected: true }
    ])
  })

  it('空提问被拒绝，线程不存在时返回 missing', () => {
    const thread = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    if (thread.status !== 'created') throw new Error('create failed')
    expect(
      askQuestion(database, { threadId: thread.thread.id, text: '   ' }, { now: T4 })
    ).toEqual({ status: 'rejected', reason: 'empty' })
    expect(askQuestion(database, { threadId: 'nope', text: '你好' }, { now: T4 })).toEqual({
      status: 'missing'
    })
  })

  it('回答写进来后成为第一版；重新生成产生第二版，切换回第一版文本还在', () => {
    const thread = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    if (thread.status !== 'created') throw new Error('create failed')
    const asked = askQuestion(
      database,
      { threadId: thread.thread.id, text: '给我两个例句' },
      { now: '2026-11-18T09:01:00.000Z' }
    )
    if (asked.status !== 'asked') throw new Error('ask failed')

    const first = saveAnswer(
      database,
      {
        threadId: thread.thread.id,
        questionId: asked.questionId,
        text: '第一版回答。',
        thinking: '先想一下。',
        phase: 'done'
      },
      { now: '2026-11-18T09:02:00.000Z' }
    )
    expect(first.status).toBe('saved')
    if (first.status !== 'saved') return
    const firstAnswer = first.thread.turns[0]?.answer
    expect(firstAnswer).toMatchObject({ text: '第一版回答。', phase: 'done', thinking: '先想一下。' })
    expect(firstAnswer?.versions).toHaveLength(1)

    const second = saveAnswer(
      database,
      {
        threadId: thread.thread.id,
        questionId: asked.questionId,
        text: '第二版回答。',
        thinking: '',
        phase: 'done'
      },
      { now: '2026-11-18T09:03:00.000Z' }
    )
    if (second.status !== 'saved') throw new Error('second answer failed')
    const secondAnswer = second.thread.turns[0]?.answer
    expect(secondAnswer?.text).toBe('第二版回答。')
    expect(secondAnswer?.versions.map((version) => version.selected)).toEqual([false, true])
    expect(secondAnswer?.versions).toHaveLength(2)

    const switched = switchAnswer(
      database,
      {
        threadId: thread.thread.id,
        questionId: asked.questionId,
        answerId: firstAnswer?.id as string
      },
      { now: '2026-11-18T09:04:00.000Z' }
    )
    expect(switched.status).toBe('switched')
    if (switched.status !== 'switched') return
    expect(switched.thread.turns[0]?.answer?.text).toBe('第一版回答。')
    expect(switched.thread.turns[0]?.answer?.versions[0]?.selected).toBe(true)
  })

  it('回答的 phase 与错误一起保存，停止的这条标未完成', () => {
    const thread = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    if (thread.status !== 'created') throw new Error('create failed')
    const asked = askQuestion(database, { threadId: thread.thread.id, text: '问' }, { now: T4 })
    if (asked.status !== 'asked') throw new Error('ask failed')
    const saved = saveAnswer(
      database,
      {
        threadId: thread.thread.id,
        questionId: asked.questionId,
        text: '写到这里',
        thinking: '',
        phase: 'stopped'
      },
      { now: T4 }
    )
    if (saved.status !== 'saved') throw new Error('save failed')
    expect(saved.thread.turns[0]?.answer?.phase).toBe('stopped')

    const error = saveAnswer(
      database,
      {
        threadId: thread.thread.id,
        questionId: asked.questionId,
        text: '',
        thinking: '',
        phase: 'error',
        error: { code: 'rate-limited', status: 429 }
      },
      { now: T4 }
    )
    if (error.status !== 'saved') throw new Error('error save failed')
    expect(error.thread.turns[0]?.answer?.phase).toBe('error')
    expect(error.thread.turns[0]?.answer?.error).toEqual({ code: 'rate-limited', status: 429 })
  })
})

describe('改口与分支', () => {
  it('改上一条提问走新分支，旧提问与旧回答都还在，切回去能看到', () => {
    const thread = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    if (thread.status !== 'created') throw new Error('create failed')
    const firstQuestion = askQuestion(
      database,
      { threadId: thread.thread.id, text: '原来的问法' },
      { now: '2026-11-18T09:01:00.000Z' }
    )
    if (firstQuestion.status !== 'asked') throw new Error('ask failed')
    saveAnswer(
      database,
      {
        threadId: thread.thread.id,
        questionId: firstQuestion.questionId,
        text: '原来的回答',
        thinking: '',
        phase: 'done'
      },
      { now: '2026-11-18T09:02:00.000Z' }
    )

    const edited = editQuestion(
      database,
      {
        threadId: thread.thread.id,
        questionId: firstQuestion.questionId,
        text: '改过的问法'
      },
      { now: '2026-11-18T09:03:00.000Z' }
    )
    expect(edited.status).toBe('asked')
    if (edited.status !== 'asked') return
    expect(edited.questionId).not.toBe(firstQuestion.questionId)
    expect(edited.thread.turns).toHaveLength(1)
    expect(edited.thread.turns[0]?.question).toMatchObject({ id: edited.questionId, text: '改过的问法' })
    expect(edited.thread.turns[0]?.answer).toBeNull()
    expect(edited.thread.turns[0]?.question.versions.map((version) => version.selected)).toEqual([
      false,
      true
    ])

    const newAnswer = saveAnswer(
      database,
      {
        threadId: thread.thread.id,
        questionId: edited.questionId,
        text: '新分支的回答',
        thinking: '',
        phase: 'done'
      },
      { now: '2026-11-18T09:04:00.000Z' }
    )
    if (newAnswer.status !== 'saved') throw new Error('save failed')
    expect(newAnswer.thread.turns[0]?.question.versions).toHaveLength(2)

    const back = switchQuestion(
      database,
      { threadId: thread.thread.id, questionId: firstQuestion.questionId },
      { now: '2026-11-18T09:05:00.000Z' }
    )
    expect(back.status).toBe('switched')
    if (back.status !== 'switched') return
    expect(back.thread.turns[0]?.question.text).toBe('原来的问法')
    expect(back.thread.turns[0]?.answer?.text).toBe('原来的回答')
  })

  it('空的新提问被拒绝', () => {
    const thread = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    if (thread.status !== 'created') throw new Error('create failed')
    const asked = askQuestion(database, { threadId: thread.thread.id, text: '问' }, { now: T4 })
    if (asked.status !== 'asked') throw new Error('ask failed')
    expect(
      editQuestion(
        database,
        { threadId: thread.thread.id, questionId: asked.questionId, text: '  ' },
        { now: T4 }
      )
    ).toEqual({ status: 'rejected', reason: 'empty' })
  })
})

describe('继续生成', () => {
  it('接在同一回答后面，不产生新版本；之后的新提问跟在它后面', () => {
    const thread = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    if (thread.status !== 'created') throw new Error('create failed')
    const answered = askQuestion(database, { threadId: thread.thread.id, text: '第一问' }, { now: T4 })
    if (answered.status !== 'asked') throw new Error('ask failed')
    const first = saveAnswer(
      database,
      {
        threadId: thread.thread.id,
        questionId: answered.questionId,
        text: '第一段。',
        thinking: '想第一段。',
        phase: 'done'
      },
      { now: '2026-11-18T09:01:00.000Z' }
    )
    if (first.status !== 'saved') throw new Error('save failed')
    const answerId = first.thread.turns[0]?.answer?.id as string

    const continued = saveContinuation(
      database,
      {
        threadId: thread.thread.id,
        answerId,
        text: '第二段。',
        thinking: '想第二段。',
        phase: 'done'
      },
      { now: '2026-11-18T09:02:00.000Z' }
    )
    expect(continued.status).toBe('saved')
    if (continued.status !== 'saved') return
    const answer = continued.thread.turns[0]?.answer
    expect(answer?.text).toBe('第一段。第二段。')
    expect(answer?.thinking).toBe('想第一段。\n\n想第二段。')
    expect(answer?.versions).toHaveLength(1)
    expect(answer?.continuationIds).toHaveLength(1)

    const next = askQuestion(
      database,
      { threadId: thread.thread.id, text: '第二问' },
      { now: '2026-11-18T09:03:00.000Z' }
    )
    if (next.status !== 'asked') throw new Error('second ask failed')
    expect(next.thread.turns).toHaveLength(2)
    expect(next.thread.turns[0]?.answer?.text).toBe('第一段。第二段。')
    expect(next.thread.turns[1]?.question.text).toBe('第二问')
  })

  it('继续生成中断时整条算未完成；切到别的版本再切回来，续写还在', () => {
    const thread = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    if (thread.status !== 'created') throw new Error('create failed')
    const answered = askQuestion(database, { threadId: thread.thread.id, text: '问' }, { now: T4 })
    if (answered.status !== 'asked') throw new Error('ask failed')
    const first = saveAnswer(
      database,
      {
        threadId: thread.thread.id,
        questionId: answered.questionId,
        text: '正文。',
        thinking: '',
        phase: 'done'
      },
      { now: '2026-11-18T09:01:00.000Z' }
    )
    if (first.status !== 'saved') throw new Error('save failed')
    const answerId = first.thread.turns[0]?.answer?.id as string
    const continued = saveContinuation(
      database,
      {
        threadId: thread.thread.id,
        answerId,
        text: '续写一半',
        thinking: '',
        phase: 'stopped'
      },
      { now: '2026-11-18T09:02:00.000Z' }
    )
    if (continued.status !== 'saved') throw new Error('continue failed')
    expect(continued.thread.turns[0]?.answer?.phase).toBe('stopped')

    const second = saveAnswer(
      database,
      {
        threadId: thread.thread.id,
        questionId: answered.questionId,
        text: '另一个版本。',
        thinking: '',
        phase: 'done'
      },
      { now: '2026-11-18T09:03:00.000Z' }
    )
    if (second.status !== 'saved') throw new Error('second failed')
    expect(second.thread.turns[0]?.answer?.text).toBe('另一个版本。')

    const back = switchAnswer(
      database,
      { threadId: thread.thread.id, questionId: answered.questionId, answerId },
      { now: '2026-11-18T09:04:00.000Z' }
    )
    if (back.status !== 'switched') throw new Error('switch failed')
    expect(back.thread.turns[0]?.answer?.text).toBe('正文。续写一半')
    expect(back.thread.turns[0]?.answer?.phase).toBe('stopped')
  })
})

describe('上下文', () => {
  it('自由摘录保存并恢复原文和出处，不计入词数', () => {
    const created = createThread(database, { main: { kind: 'article', articleId: firstArticle.id } })
    if (created.status !== 'created') throw new Error('create failed')
    const excerpt: ThreadContextItem = { id: 'excerpt:one', kind: 'excerpt', label: '摘录', text: 'First sentence. Second sentence.', source: '文章 · 第 1 段' }
    const saved = updateThreadContext(database, { threadId: created.thread.id, items: [excerpt] })
    if (saved.status !== 'saved') throw new Error('save failed')
    expect(readThreadView(database, created.thread.id)?.context).toEqual([excerpt])
    expect(saved.thread.contextSummary).toMatchObject({ wordCount: 0, excerptCount: 1, charCount: 32 })
  })

  it('可以整体替换，坏条目与重复 id 被丢掉，计数跟着变', () => {
    const seeded = seed()
    const created = createThread(database, { main: { kind: 'entry', entryId: seeded.approachEntryId } }, { now: T4 })
    if (created.status !== 'created') throw new Error('create failed')
    const sentenceId = seeded.approachSentenceIds[0] as string

    const result = updateThreadContext(
      database,
      {
        threadId: created.thread.id,
        items: [
          {
            id: `sentence:${sentenceId}`,
            kind: 'sentence',
            label: 'approach',
            text: 'Employers approach hiring differently.',
            source: '出处'
          },
          {
            id: `sentence:${sentenceId}`,
            kind: 'sentence',
            label: '重复',
            text: '重复的不算',
            source: ''
          },
          { id: 'bad', kind: 'unknown', label: '', text: '不认识', source: '' },
          { id: 'empty', kind: 'note', label: '', text: '   ', source: '' }
        ] as unknown as ThreadContextItem[]
      },
      { now: '2026-11-18T10:00:00.000Z' }
    )
    expect(result.status).toBe('saved')
    if (result.status !== 'saved') return
    expect(itemIds(result.thread.context)).toEqual([`sentence:${sentenceId}`])
    expect(result.thread.contextSummary).toEqual({
      articleCount: 0,
      paragraphCount: 0,
      wordCount: 0,
      sentenceCount: 1,
      excerptCount: 0,
      charCount: Array.from('Employers approach hiring differently.').length
    })
  })

  it('复用旧对话时补齐标题形式的文章正文并保留其余所选材料', () => {
    const main = { kind: 'article' as const, articleId: firstArticle.id }
    const created = createThread(database, { main })
    if (created.status !== 'created') throw new Error('create failed')
    const legacy = [
      { id: `article:${firstArticle.id}`, kind: 'article', label: '旧篇名', text: '旧篇名', source: '' },
      { id: `paragraph:${firstArticle.id}:1`, kind: 'paragraph', label: '段 1', text: '原段', source: '' },
      { id: 'note:1', kind: 'note', label: '笔记', text: '我的选择', source: '' }
    ]
    database.prepare('UPDATE thread SET context_json = ? WHERE id = ?').run(JSON.stringify(legacy), created.thread.id)
    const reused = openThreadForMain(database, { main })
    if (reused.status !== 'reused') throw new Error('reuse failed')
    expect(reused.thread.context[0]?.text).toContain('Employers approach hiring differently.')
    expect(reused.thread.context[0]?.text).toContain('Context keeps the skill alive.')
    expect(reused.thread.context.slice(1)).toEqual(legacy.slice(1))
  })

  it('全文与同篇段落不会重复带入，其他文章段落保留', () => {
    const created = createThread(database, { main: { kind: 'article', articleId: firstArticle.id } })
    if (created.status !== 'created') throw new Error('create failed')
    const full = created.thread.context[0]!
    const same = { id: `paragraph:${firstArticle.id}:1`, kind: 'paragraph' as const, label: '段 1', text: 'same', source: '' }
    const other = { id: `paragraph:${longMatch.id}:A`, kind: 'paragraph' as const, label: '段 A', text: 'other', source: '' }
    for (const items of [[same, other, full], [full, same, other]]) {
      const result = updateThreadContext(database, { threadId: created.thread.id, items })
      if (result.status !== 'saved') throw new Error('save failed')
      expect(itemIds(result.thread.context)).toEqual(items.filter((item) => item !== same).map((item) => item.id))
    }
  })

  it('任意对话可浏览其他文章与词条，并按篇读取全文和全部段落', () => {
    const seeded = seed()
    const created = createThread(database, { main: { kind: 'entry', entryId: seeded.contextEntryId } })
    if (created.status !== 'created') throw new Error('create failed')
    const candidates = readContextCandidates(database, created.thread.id)
    expect(candidates.articles.map((article) => article.id)).toContain(longMatch.id)
    expect(itemIds(candidates.items)).toContain(`article:${firstArticle.id}`)
    expect(candidates.items.filter((item) => item.kind === 'paragraph' && item.id.startsWith(`paragraph:${firstArticle.id}:`))).toHaveLength(3)
    expect(itemIds(candidates.libraryItems)).toContain(`word:${seeded.approachEntryId}`)
    expect(itemIds(candidates.libraryItems)).toContain(`sentence:${seeded.approachSentenceIds[0]}`)
    expect(candidates.libraryItems.some((item) => item.kind === 'note')).toBe(true)
    const materials = readArticleContextMaterials(database, longMatch.id)
    expect(materials.article?.text).toContain('First paragraph here.')
    expect(materials.paragraphs.map((item) => item.text)).toEqual([
      'First paragraph here.', 'Nothing on approach.', 'Another approach appears here.'
    ])
  })

  it('候选里是这次还能加的原句、段落与学习内容，已带上的不再出现', () => {
    const seeded = seed()
    const created = createThread(database, { main: { kind: 'entry', entryId: seeded.approachEntryId } }, { now: T4 })
    if (created.status !== 'created') throw new Error('create failed')

    const before = readContextCandidates(database, created.thread.id)
    const beforeIds = itemIds(before.items)
    // 默认已经带上主词形与最近一句，候选里只剩另外两句、所在段落与那条学习内容。
    expect(beforeIds).toContain(`sentence:${seeded.approachSentenceIds[0]}`)
    expect(beforeIds).toContain(`sentence:${seeded.approachSentenceIds[1]}`)
    expect(beforeIds).not.toContain(`sentence:${seeded.latestSentenceId}`)
    expect(beforeIds).not.toContain(`word:${seeded.approachEntryId}`)
    expect(beforeIds.some((id) => id.startsWith('paragraph:'))).toBe(true)
    expect(beforeIds.filter((id) => id.startsWith('note:'))).toHaveLength(1)
    expect(before.items.find((item) => item.kind === 'note')?.text).toBe(
      'approach 强调着手；approachable 是形容词。'
    )

    updateThreadContext(database, { threadId: created.thread.id, items: [] }, { now: T4 })
    const after = readContextCandidates(database, created.thread.id)
    expect(itemIds(after.items)).toContain(`word:${seeded.approachEntryId}`)
    expect(itemIds(after.items)).toContain(`sentence:${seeded.latestSentenceId}`)
  })

  it('文章线程的候选覆盖这篇的段落、原句与相关学习内容', () => {
    const seeded = seed()
    const created = createThread(database, { main: { kind: 'article', articleId: firstArticle.id } }, { now: T4 })
    if (created.status !== 'created') throw new Error('create failed')
    const candidates = readContextCandidates(database, created.thread.id).items
    const ids = itemIds(candidates)
    // 候选保留段落供移除全文后使用；界面在全文仍存在时隐藏这些段落。
    expect(ids).not.toContain(`article:${firstArticle.id}`)
    expect(ids.filter((id) => id.startsWith('paragraph:')).length).toBe(3)
    expect(ids).toContain(`sentence:${seeded.approachSentenceIds[0]}`)
    expect(ids).toContain(`sentence:${seeded.approachSentenceIds[1]}`)
    expect(ids.some((id) => id.startsWith('note:'))).toBe(true)

    updateThreadContext(database, { threadId: created.thread.id, items: [] }, { now: T4 })
    expect(itemIds(readContextCandidates(database, created.thread.id).items)).toContain(
      `article:${firstArticle.id}`
    )
  })

  it('空白线程也能从库里加词，加进来之后再给这个词的原句与学习内容', () => {
    const seeded = seed()
    const created = createThread(database, { main: { kind: 'none' } }, { now: T4 })
    if (created.status !== 'created') throw new Error('create failed')

    // 空白线程没有主对象可围着找材料，但自由学习要能自己挑词：候选是库里全部词条。
    const before = readContextCandidates(database, created.thread.id)
    expect(itemIds(before.items)).toEqual([
      `word:${seeded.contextEntryId}`,
      `word:${seeded.approachEntryId}`
    ])
    expect(before.items[1]?.source).toBe('已收 3 条原句 · 2 篇')

    updateThreadContext(
      database,
      {
        threadId: created.thread.id,
        items: [before.items[1] as ThreadContextItem]
      },
      { now: T4 }
    )
    const after = itemIds(readContextCandidates(database, created.thread.id).items)
    expect(after).not.toContain(`word:${seeded.approachEntryId}`)
    expect(after).toContain(`sentence:${seeded.latestSentenceId}`)
    expect(after.some((id) => id.startsWith('note:'))).toBe(true)
  })

  it('组词线程的候选是这些词更多的原句、段落与学习内容，移除的词句重启后还能加回来', () => {
    const seeded = seed()
    const created = createGroupThread(
      database,
      { entryIds: [seeded.approachEntryId, seeded.contextEntryId] },
      { now: T4 }
    )
    if (created.status !== 'created') throw new Error('create failed')
    const threadId = created.thread.id

    const before = itemIds(readContextCandidates(database, threadId).items)
    // 已带上的词与最近一句不再出现在候选里。
    expect(before).not.toContain(`word:${seeded.approachEntryId}`)
    expect(before).not.toContain(`sentence:${seeded.latestSentenceId}`)
    // 这些词更多的原句可以从 picker 加进来。
    expect(before).toContain(`sentence:${seeded.approachSentenceIds[0]}`)
    expect(before).toContain(`sentence:${seeded.approachSentenceIds[1]}`)
    expect(before.some((id) => id.startsWith('paragraph:'))).toBe(true)
    expect(before.some((id) => id.startsWith('note:'))).toBe(true)

    // 移除词与原句后：词重新成为可加材料；把词加回来，它的原句又出现在候选里。
    const remaining = created.thread.context.filter(
      (item) =>
        item.id !== `word:${seeded.approachEntryId}` &&
        item.id !== `sentence:${seeded.latestSentenceId}`
    )
    updateThreadContext(database, { threadId, items: remaining }, { now: T4 })
    const afterRemove = readContextCandidates(database, threadId).items
    expect(itemIds(afterRemove)).toContain(`word:${seeded.approachEntryId}`)
    const word = afterRemove.find((item) => item.id === `word:${seeded.approachEntryId}`)
    if (!word) throw new Error('missing removed word candidate')
    updateThreadContext(
      database,
      { threadId, items: [...remaining, word] },
      { now: T4 }
    )
    const afterWord = itemIds(readContextCandidates(database, threadId).items)
    expect(afterWord).toContain(`sentence:${seeded.latestSentenceId}`)

    // 重启（关库再开）后线程还在，移除的词句仍能从候选加回来并继续编辑。
    database.close()
    database = openDatabase(join(directory, 'test.db'))
    const restarted = readThreadView(database, threadId)
    expect(restarted?.main).toEqual({ kind: 'none' })
    expect(restarted?.contextSummary.wordCount).toBe(2)
    const candidates = readContextCandidates(database, threadId).items
    const sentence = candidates.find(
      (item) => item.id === `sentence:${seeded.latestSentenceId}`
    )
    expect(sentence).toBeDefined()
    const restored = updateThreadContext(
      database,
      {
        threadId,
        items: [...(restarted?.context ?? []), sentence as ThreadContextItem]
      },
      { now: '2026-11-18T10:00:00.000Z' }
    )
    expect(restored.status).toBe('saved')
    if (restored.status !== 'saved') return
    expect(restored.thread.contextSummary).toEqual({
      articleCount: 0,
      paragraphCount: 0,
      wordCount: 2,
      sentenceCount: 2,
      excerptCount: 0,
      charCount: 75
    })
  })
})

describe('线程列表', () => {
  it('按更新时间倒序，标题与主对象摘要都在，问过几句标几轮', () => {
    const seeded = seed()
    const first = createThread(database, { main: { kind: 'entry', entryId: seeded.approachEntryId } }, { now: T0 })
    if (first.status !== 'created') throw new Error('create failed')
    const second = createThread(database, { main: { kind: 'article', articleId: longMatch.id } }, { now: T1 })
    if (second.status !== 'created') throw new Error('create failed')
    askQuestion(database, { threadId: first.thread.id, text: '问一句' }, { now: T2 })

    const listing = listThreads(database)
    expect(listing.threads.map((thread) => thread.id)).toEqual([first.thread.id, second.thread.id])
    expect(listing.threads[0]).toMatchObject({
      title: 'approach',
      mainKind: 'entry',
      mainLabel: '词条 approach',
      turnCount: 1
    })
    expect(listing.threads[1]).toMatchObject({
      title: '2026年6月 · 第1套 · 长篇匹配',
      mainKind: 'article',
      turnCount: 0
    })
  })

  it('空白学习在列表里用自己的说法，不露出「未挂对象」这类内部词', () => {
    const blank = createThread(database, { main: { kind: 'none' } }, { now: T0 })
    if (blank.status !== 'created') throw new Error('create failed')

    expect(listThreads(database).threads[0]?.mainLabel).toBe('空白学习')
  })

  it('轮数按当前分支算，改口留下的旧提问不算一轮', () => {
    const thread = createThread(database, { main: { kind: 'none' } }, { now: T0 })
    if (thread.status !== 'created') throw new Error('create failed')
    const asked = askQuestion(database, { threadId: thread.thread.id, text: '第一问' }, { now: T1 })
    if (asked.status !== 'asked') throw new Error('ask failed')
    saveAnswer(
      database,
      {
        threadId: thread.thread.id,
        questionId: asked.questionId,
        text: '回答',
        thinking: '',
        phase: 'done'
      },
      { now: T2 }
    )
    const edited = editQuestion(
      database,
      { threadId: thread.thread.id, questionId: asked.questionId, text: '改过的问法' },
      { now: T3 }
    )
    if (edited.status !== 'asked') throw new Error('edit failed')

    const listed = listThreads(database).threads.find((item) => item.id === thread.thread.id)
    expect(listed?.turnCount).toBe(1)
  })
})
