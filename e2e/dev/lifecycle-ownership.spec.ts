import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/database'
import { migrate } from '../../src/main/db/migrations'
import { markArticleCompleted } from '../../src/main/library/queries'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { writeDictionaryFixture } from '../../src/testing/dictionary-fixture'
import { expect, test } from '../fixtures/app'
import { holdIpcCall, holdIpcReply } from '../fixtures/bridge'
import { databasePath } from '../fixtures/database'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'

/**
 * 页面生命周期所有权：迟到的完成 / 保存 / 取消已读完回调，不能把用户已经
 * 切走或换过文章的界面拉回旧文章。数据库写仍要照常完成。
 */

const TITLE_A = '2026年6月 · 第1套 · 仔细阅读 Passage One'
const TITLE_B = '2026年6月 · 第1套 · 仔细阅读 Passage Two'

const articleA = fixtureArticle({
  id: 'fixture-lifecycle-a',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE_A,
  sentences: [['The alpha value appears here.'], ['Another alpha value appears again.']]
})

const articleB = fixtureArticle({
  id: 'fixture-lifecycle-b',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE_B,
  sentences: [['The bravo value appears here.'], ['Another bravo value appears again.']]
})

const picks: SeedPick[] = [
  { entry: articleA, paragraphIndex: 0, needle: 'alpha', at: '2026-11-18T08:00:00.000Z' },
  { entry: articleA, paragraphIndex: 1, needle: 'alpha', at: '2026-11-18T08:05:00.000Z' },
  { entry: articleB, paragraphIndex: 0, needle: 'bravo', at: '2026-11-18T08:10:00.000Z' },
  { entry: articleB, paragraphIndex: 1, needle: 'bravo', at: '2026-11-18T08:15:00.000Z' }
]

const dictionary = {
  entries: [
    {
      word: 'alpha',
      phonetic: "'ælfә",
      translation: 'n. 阿尔法\\na. 第一个的',
      exchange: ''
    },
    {
      word: 'bravo',
      phonetic: "'brɑ:vәu",
      translation: 'n. 喝彩\\nint. 好极了',
      exchange: ''
    }
  ],
  lemmas: []
}

let corpusDirectory: string
let dictionaryDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-lifecycle-corpus-'))
  writeCorpusDirectory(corpusDirectory, [articleA, articleB])
  dictionaryDirectory = await mkdtemp(join(tmpdir(), 'english-learning-lifecycle-dictionary-'))
  writeDictionaryFixture(join(dictionaryDirectory, 'ecdict.db'), dictionary)
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  await rm(dictionaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function environment(): Record<string, string> {
  return {
    CORPUS_DIRECTORY: corpusDirectory,
    DICTIONARY_DIRECTORY: dictionaryDirectory
  }
}

async function setHash(page: Page, hash: string): Promise<void> {
  await page.evaluate((next) => {
    window.location.hash = next
  }, hash)
}

async function openWords(page: Page, articleId: string, title: string): Promise<void> {
  await setHash(page, `#/reading/${articleId}/words`)
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  await expect(page.locator('.reading-bar-title')).toHaveText(title)
  await expect(page.locator('.article-words-entry').first()).toBeVisible()
}

/** 展开第一张词条卡，用词典首义起草并返回草稿框。 */
async function draftFirstCard(page: Page, text: string) {
  const card = page.locator('.article-words-entry').first()
  await card.locator('.article-words-entry-link').click()
  await card.getByRole('button', { name: '用这条起草' }).first().click()
  const draft = card.locator('.article-words-draft')
  await expect(draft).toBeVisible()
  await draft.fill(text)
  return draft
}

test('完成回调迟于离开阅读页：不再导航回旧文章的本篇选词', async ({
  launch,
  userDataDirectory
}) => {
  const { page, electronApp } = await launch({ env: environment() })
  if (!electronApp) throw new Error('需要 Electron 主进程句柄')
  await setHash(page, `#/reading/${articleA.id}?from=home`)
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.locator('.reading-bar-title')).toHaveText(TITLE_A)

  const held = await holdIpcReply(electronApp, 'reading:complete')
  await page.getByRole('button', { name: '读完并整理本篇选词' }).click()
  await expect.poll(held.pending).toBe(true)

  // 完成还没回，用户已经退出阅读页回到首页。
  await page.locator('.reading-back').click()
  await expect(page.locator('[data-reading-page="true"]')).toHaveCount(0)
  const leftHash = await page.evaluate(() => window.location.hash)

  await held.release()
  await page.waitForTimeout(300)
  expect(await page.evaluate(() => window.location.hash)).toBe(leftHash)
  expect(leftHash).not.toContain('/words')
  await expect(page.locator('.article-words-sheet')).toHaveCount(0)
  expect(userDataDirectory).not.toBe('')
})

test('A 的保存回调迟到后不覆盖 B 的视图与未保存草稿，但 A 的学习内容照常落库', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const { page, electronApp } = await launch({ env: environment() })
  if (!electronApp) throw new Error('需要 Electron 主进程句柄')
  await openWords(page, articleA.id, TITLE_A)

  const held = await holdIpcReply(electronApp, 'entries:create-note')
  await draftFirstCard(page, 'A 的草稿')
  await page.locator('.article-words-entry').first().getByRole('button', { name: '保存学习内容' }).click()
  await expect.poll(held.pending).toBe(true)

  // 保存还没回，用户已经换到另一篇的本篇选词，并写了自己未保存的草稿。
  await openWords(page, articleB.id, TITLE_B)
  const bDraft = await draftFirstCard(page, 'B 的草稿')

  await held.release()
  await page.waitForTimeout(300)

  await expect(page.locator('.reading-bar-title')).toHaveText(TITLE_B)
  expect(await page.evaluate(() => window.location.hash)).toContain(
    `#/reading/${articleB.id}/words`
  )
  await expect(page.locator('.article-words-draft').first()).toHaveValue(/B 的草稿/)
  await expect(bDraft).toHaveValue(/B 的草稿/)
  await expect(page.getByText('学习内容已保存。')).toHaveCount(0)

  // 数据库那笔写仍要完成：A 的词条已经有一条学习内容。
  const noteCount = await page.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke(channel: string, payload: unknown): Promise<unknown> }
    }).api
    const listing = (await api.invoke('entries:list', { query: 'alpha' })) as {
      entries: { id: string }[]
    }
    const entryId = listing.entries[0]?.id
    if (entryId === undefined) throw new Error('没有 alpha 词条')
    const pageData = (await api.invoke('entries:page', { entryId })) as {
      entry: { noteCount: number }
    } | null
    return pageData?.entry.noteCount ?? 0
  })
  expect(noteCount).toBe(1)
})

test('A 的取消已读完迟到且 A 已删：不把已经打开的 B 踢回文章库', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    migrate(database)
    markArticleCompleted(database, articleA.id)
  } finally {
    database.close()
  }
  const { page, electronApp } = await launch({ env: environment() })
  if (!electronApp) throw new Error('需要 Electron 主进程句柄')
  await openWords(page, articleA.id, TITLE_A)
  await expect(page.getByText('已读完', { exact: true })).toBeVisible()

  const held = await holdIpcCall(electronApp, 'reading:uncomplete')
  await page.getByRole('button', { name: '取消已读完' }).click()
  await expect.poll(held.pending).toBe(true)

  await openWords(page, articleB.id, TITLE_B)

  // 请求还挂着时删掉旧文章 A：处理器真正读库时得到 missing。
  const deleted = await page.evaluate(async (articleId) => {
    const api = (window as unknown as {
      api: { invoke(channel: string, payload: unknown): Promise<unknown> }
    }).api
    const preview = await api.invoke('library:delete-preview', { articleId })
    if (preview === null) throw new Error('没有删除预览')
    return api.invoke('library:delete', { articleId, confirmed: preview })
  }, articleA.id)
  expect(deleted).toMatchObject({ status: 'deleted' })

  await held.release()
  await page.waitForTimeout(300)

  await expect(page.locator('.reading-bar-title')).toHaveText(TITLE_B)
  expect(await page.evaluate(() => window.location.hash)).toContain(
    `#/reading/${articleB.id}/words`
  )
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toHaveCount(0)
})
