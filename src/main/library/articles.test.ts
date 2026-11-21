import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CollectSelectionRequest, EntrySummary } from '../../shared/entries'
import type { CreatePinRequest, Pin, PinTarget } from '../../shared/pins'
import {
  fixtureArticle,
  writeCorpusDirectory,
  type FixtureEntry
} from '../../testing/corpus-fixture'
import { askQuestion, createThread, saveAnswer } from '../chat/threads'
import { importCorpus } from '../corpus/import'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { createLearningNote, readLearningNotes } from '../entries/notes'
import { readEntryList, readEntryPage } from '../entries/page'
import { collectSelection } from '../entries/queries'
import { createPin, readPinBoard, readPinSource } from '../pins/pins'
import {
  readArticleDetail,
  readLibrary
} from './queries'
import {
  deleteArticle,
  readArticleDeletionPreview,
  renameArticle
} from './articles'

const T0 = '2026-11-18T08:00:00.000Z'
const T1 = '2026-11-18T08:05:00.000Z'
const T2 = '2026-11-18T08:10:00.000Z'
const T3 = '2026-11-18T08:15:00.000Z'
const T4 = '2026-11-18T08:20:00.000Z'
const ANSWER = '第一段：lament 是惋惜。\n\n第二段：complain 只是抱怨。'

const articleA = fixtureArticle({
  id: 'fixture-2024-06-s1-c1',
  year: 2024,
  month: 6,
  set: 1,
  sentences: [
    ['Alpha opens the shared passage.', 'Beta closes the first paragraph.'],
    ['Shared words appear in both articles.']
  ]
})

const articleB = fixtureArticle({
  id: 'fixture-2024-06-s1-c2',
  year: 2024,
  month: 6,
  set: 1,
  sentences: [['Shared words appear in both articles.']]
})

let directory: string
let db: AppDatabase
let alpha: EntrySummary
let shared: EntrySummary
let pins: Pin[]
let threadId: string

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
    throw new Error(`第 ${paragraphIndex} 段没有 ${needle}`)
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

function collect(entry: FixtureEntry, paragraphIndex: number, needle: string, now: string): EntrySummary {
  const result = collectSelection(db, selection(entry, paragraphIndex, needle), { now })
  if (result.status === 'rejected') {
    throw new Error(`collect ${needle} rejected: ${result.reason}`)
  }
  return result.entry
}

function pinAt(target: PinTarget, needle: string, now: string): Pin {
  const start = ANSWER.indexOf(needle)
  const request: CreatePinRequest = {
    threadId,
    answerId: '',
    start,
    end: start + needle.length,
    target
  }
  const view = db.prepare('SELECT id FROM thread_entry WHERE thread_id = ? AND kind = ?').get(threadId, 'answer') as
    | { id: string }
    | undefined
  if (!view) throw new Error('回答没写进去')
  request.answerId = view.id
  const result = createPin(db, request, { now, model: 'deepseek-flash' })
  if (result.status !== 'pinned') throw new Error(`pin rejected: ${result.reason}`)
  return result.pin
}

function seedThreadAndPins(): void {
  const created = createThread(db, { main: { kind: 'entry', entryId: alpha.id } }, { now: T2 })
  if (created.status !== 'created') throw new Error('线程没建起来')
  threadId = created.thread.id
  const asked = askQuestion(db, { threadId, text: 'lament 和 complain 有什么区别？' }, { now: T3 })
  if (asked.status !== 'asked') throw new Error('问题没写进去')
  const saved = saveAnswer(
    db,
    { threadId, questionId: asked.questionId, text: ANSWER, thinking: '', phase: 'done' },
    { now: T4 }
  )
  if (saved.status !== 'saved') throw new Error('回答没写进去')

  pins = [
    pinAt({ kind: 'article', articleId: articleA.id }, 'lament', T4),
    pinAt({ kind: 'article', articleId: articleA.id }, 'complain', T4),
    pinAt({ kind: 'entry', entryId: alpha.id }, 'lament', T4),
    pinAt({ kind: 'entry', entryId: shared.id }, 'lament', T4),
    pinAt({ kind: 'article', articleId: articleB.id }, 'lament', T4)
  ]
}

function open(): void {
  db = openDatabase(join(directory, 'test.db'))
  migrate(db)
}

function close(): void {
  db.close()
}

/** 按当前影响面发一次删除，等价于界面「先看影响面、再确认」。 */
function deleteCurrent(articleId: string = articleA.id) {
  const confirmed = readArticleDeletionPreview(db, articleId)
  if (confirmed === null) throw new Error(`文章 ${articleId} 不在库里`)
  return deleteArticle(db, { articleId, confirmed })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-articles-'))
  writeCorpusDirectory(directory, [articleA, articleB])
  open()
  importCorpus(db, { directory })

  alpha = collect(articleA, 0, 'Alpha', T0)
  shared = collect(articleA, 1, 'Shared', T1)
  collect(articleB, 0, 'Shared', T1)
  createLearningNote(db, { entryId: alpha.id, body: '第一条学习内容' }, { now: T1 })
  createLearningNote(db, { entryId: alpha.id, body: '第二条学习内容' }, { now: T1 })
  seedThreadAndPins()
})

afterEach(() => {
  close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('renameArticle', () => {
  it('只改显示名，列表、详情与阅读标题读到同一个新名字', () => {
    expect(renameArticle(db, { articleId: articleA.id, title: '  我的文章  ' })).toEqual({
      status: 'renamed',
      articleId: articleA.id,
      title: '我的文章'
    })

    expect(readArticleDetail(db, articleA.id)?.title).toBe('我的文章')
    expect(readLibrary(db).sessions[0]?.sets.flatMap((set) => set.articles).find((article) => article.id === articleA.id)?.title).toBe(
      '我的文章'
    )
    expect(
      db.prepare('SELECT title FROM article WHERE id = ?').get(articleA.id)
    ).toEqual({ title: '我的文章' })
  })

  it('空篇名与不存在的文章都明确拒绝', () => {
    expect(renameArticle(db, { articleId: articleA.id, title: '   ' })).toEqual({
      status: 'rejected',
      reason: 'empty'
    })
    expect(renameArticle(db, { articleId: 'nope', title: '新名字' })).toEqual({ status: 'missing' })
    expect(readArticleDetail(db, articleA.id)?.title).toBe(
      '2024年6月 · 第1套 · 仔细阅读 Passage One'
    )
  })

  it('篇名上限 200 只有一份：服务与输入框共用，201 个字拒绝', () => {
    expect(
      renameArticle(db, { articleId: articleA.id, title: 'a'.repeat(200) })
    ).toMatchObject({ status: 'renamed' })
    expect(
      renameArticle(db, { articleId: articleA.id, title: 'b'.repeat(201) })
    ).toEqual({ status: 'rejected', reason: 'too-long' })
    expect(readArticleDetail(db, articleA.id)?.title).toBe('a'.repeat(200))
  })

  it('重启与语料刷新都保留用户改的显示名', () => {
    renameArticle(db, { articleId: articleA.id, title: '我的文章' })
    close()
    open()
    importCorpus(db, { directory })
    expect(readArticleDetail(db, articleA.id)?.title).toBe('我的文章')

    const replaced = fixtureArticle({
      id: articleA.id,
      sha256: 'f'.repeat(64),
      sentences: [['The source PDF was replaced.', 'A new sentence arrives.']]
    })
    writeCorpusDirectory(directory, [replaced, articleB])
    const report = importCorpus(db, { directory })

    expect(report).toMatchObject({ total: 2, imported: 0, updated: 1, skipped: 1 })
    expect(readArticleDetail(db, articleA.id)?.title).toBe('我的文章')
    expect(
      db.prepare('SELECT body_text FROM article WHERE id = ?').get(articleA.id)
    ).toEqual({ body_text: 'The source PDF was replaced. A new sentence arrives.' })
  })
})

describe('readArticleDeletionPreview', () => {
  it('数清原句关联、含存活与消失的全部词条、学习内容与挂在本篇的钉住', () => {
    expect(readArticleDeletionPreview(db, articleA.id)).toEqual({
      articleId: articleA.id,
      sentenceAssociationCount: 2,
      affectedEntryCount: 2,
      disappearingEntryCount: 1,
      survivingEntryCount: 1,
      disappearingLearningNoteCount: 3,
      articlePinCount: 2
    })
    expect(readArticleDeletionPreview(db, 'nope')).toBeNull()
  })
})

describe('deleteArticle', () => {
  it('删文章、段落、句子与原句关联，只删没有原句的词条及其学习内容', () => {
    const originalPreview = readArticleDeletionPreview(db, articleA.id)
    expect(originalPreview).not.toBeNull()

    const result = deleteCurrent()

    expect(result).toEqual({
      status: 'deleted',
      articleId: articleA.id,
      preview: originalPreview
    })
    expect(readLibrary(db).sessions[0]?.sets.flatMap((set) => set.articles).map((article) => article.id)).toEqual([articleB.id])
    expect(readArticleDetail(db, articleA.id)).toBeNull()
    expect(readEntryPage(db, alpha.id)).toBeNull()
    expect(readLearningNotes(db, alpha.id)).toEqual([])
    expect(readEntryList(db, {}).entries.map((entry) => entry.id)).toEqual([shared.id])
    expect(readEntryPage(db, shared.id)?.entry).toMatchObject({
      sentenceCount: 1,
      articleCount: 1,
      noteCount: 1
    })
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM paragraph WHERE article_id = ?) AS paragraphs,
           (SELECT COUNT(*) FROM sentence WHERE article_id = ?) AS sentences,
           (SELECT COUNT(*) FROM entry_sentence WHERE article_id = ?) AS associations`
      )
      .get(articleA.id, articleA.id, articleA.id)
    expect(counts).toEqual({ paragraphs: 0, sentences: 0, associations: 0 })
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM entry_sentence WHERE entry_id = ?').get(alpha.id)
    ).toEqual({ count: 0 })
  })

  it('挂在本篇的钉住保留快照并转为未归档，其他落点的钉住不受影响', () => {
    const articleAPins = pins.filter((pin) => pin.target.kind === 'article' && pin.target.articleId === articleA.id)
    const alphaPin = pins.find(
      (pin) => pin.target.kind === 'entry' && pin.target.entryId === alpha.id
    )
    const sharedPin = pins.find(
      (pin) => pin.target.kind === 'entry' && pin.target.entryId === shared.id
    )
    const articleBPin = pins.find(
      (pin) => pin.target.kind === 'article' && pin.target.articleId === articleB.id
    )
    if (!alphaPin || !sharedPin || !articleBPin) throw new Error('种子钉住不完整')

    deleteCurrent(articleA.id)

    const board = readPinBoard(db, threadId)
    expect(board.unfiledPins.map((pin) => pin.id).sort()).toEqual(
      [...articleAPins, alphaPin].map((pin) => pin.id).sort()
    )
    for (const original of articleAPins) {
      const kept = board.unfiledPins.find((pin) => pin.id === original.id)
      expect(kept).toMatchObject({
        capturedText: original.capturedText,
        start: original.start,
        end: original.end,
        target: { kind: 'unfiled' },
        provenance: {
          threadTitle: 'Alpha',
          sourceSentence: { text: 'Alpha opens the shared passage.' }
        }
      })
    }
    // 消失词条上的钉住也退回未归档，快照可读。
    expect(
      board.unfiledPins.some(
        (pin) => pin.target.kind === 'unfiled' && pin.capturedText === 'lament'
      )
    ).toBe(true)
    const keptPin = articleAPins[0]
    if (!keptPin) throw new Error('没有挂在本篇的钉住')
    expect(readPinSource(db, keptPin.id)).toMatchObject({
      thread: { id: threadId },
      onBranch: true,
      pin: {
        id: keptPin.id,
        capturedText: keptPin.capturedText,
        target: { kind: 'unfiled' },
        provenance: { sourceSentence: { text: 'Alpha opens the shared passage.' } }
      }
    })
    expect(readPinBoard(db, null).unfiledCount).toBe(3)
    expect(readPinBoard(db, threadId).threadPins.map((pin) => pin.id).sort()).toEqual(
      [sharedPin.id, articleBPin.id].sort()
    )
    expect(readPinBoard(db, threadId).threadPins.find((pin) => pin.id === sharedPin.id)?.target).toMatchObject({
      kind: 'entry',
      entryId: shared.id
    })
    expect(readPinBoard(db, threadId).threadPins.find((pin) => pin.id === articleBPin.id)?.target).toMatchObject({
      kind: 'article',
      articleId: articleB.id
    })
  })

  it('删除后重启再对一遍语料也不会把这篇文章导回来', () => {
    deleteCurrent(articleA.id)
    close()
    open()

    const report = importCorpus(db, { directory })

    expect(report).toMatchObject({ total: 2, imported: 0, updated: 0, skipped: 2 })
    expect(readArticleDetail(db, articleA.id)).toBeNull()
    expect(readLibrary(db).articleCount).toBe(1)
  })

  it('文章不存在时什么也不动', () => {
    const before = readLibrary(db).articleCount
    const confirmed = readArticleDeletionPreview(db, articleA.id)
    if (confirmed === null) throw new Error('文章不在了')
    expect(
      deleteArticle(db, {
        articleId: 'nope',
        confirmed: { ...confirmed, articleId: 'nope' }
      })
    ).toEqual({ status: 'missing' })
    expect(readLibrary(db).articleCount).toBe(before)
  })

  it('预览之后库变了就整体拒绝：不删文章、不动原句与钉住，带回最新影响面', () => {
    const confirmed = readArticleDeletionPreview(db, articleA.id)
    if (confirmed === null) throw new Error('文章不在了')
    // 预览之后又在这篇收了一个词：原句关联、词条与学习内容都可能变。
    collect(articleA, 0, 'Beta', T4)

    const rowsBefore = db
      .prepare('SELECT COUNT(*) AS count FROM entry_sentence WHERE article_id = ?')
      .get(articleA.id)
    const pinsBefore = db.prepare('SELECT COUNT(*) AS count FROM pin').get()

    const result = deleteArticle(db, { articleId: articleA.id, confirmed })

    expect(result.status).toBe('stale')
    if (result.status !== 'stale') return
    expect(result.preview.articleId).toBe(articleA.id)
    expect(result.preview.sentenceAssociationCount).toBe(3)
    expect(result.preview).not.toEqual(confirmed)
    expect(readArticleDetail(db, articleA.id)).not.toBeNull()
    expect(readEntryPage(db, alpha.id)).not.toBeNull()
    expect(
      db.prepare('SELECT COUNT(*) AS count FROM entry_sentence WHERE article_id = ?').get(articleA.id)
    ).toEqual(rowsBefore)
    expect(db.prepare('SELECT COUNT(*) AS count FROM pin').get()).toEqual(pinsBefore)

    // 拿最新一份重新确认才真的删。
    expect(deleteArticle(db, { articleId: articleA.id, confirmed: result.preview })).toMatchObject({
      status: 'deleted',
      articleId: articleA.id,
      preview: result.preview
    })
    expect(readArticleDetail(db, articleA.id)).toBeNull()
  })

  it('确认的是另一篇文章的影响面时也不删', () => {
    const other = readArticleDeletionPreview(db, articleB.id)
    if (other === null) throw new Error('另一篇也不在')
    const result = deleteArticle(db, { articleId: articleA.id, confirmed: other })
    expect(result).toMatchObject({
      status: 'stale',
      articleId: articleA.id,
      preview: { articleId: articleA.id }
    })
    expect(readArticleDetail(db, articleA.id)).not.toBeNull()
    expect(readArticleDetail(db, articleB.id)).not.toBeNull()
  })
})
