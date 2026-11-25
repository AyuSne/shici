import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importCorpus } from '../../src/main/corpus/import'
import { openDatabase } from '../../src/main/db/database'
import { migrate } from '../../src/main/db/migrations'
import { collectSelection } from '../../src/main/entries/queries'
import { openArticle } from '../../src/main/library/queries'
import { fixtureArticle, writeCorpusDirectory, type FixtureEntry } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { databasePath } from '../fixtures/database'

/**
 * #80 全局瞬移：任意页面 Ctrl/Cmd+K 唤起搜索；空输入列出最近 3 篇文章、
 * 最近 5 条词条与常用跳转；侧栏入口旁轻标 Ctrl K；输入后无缝进入既有全文搜索。
 */

const articles = [
  fixtureArticle({
    id: 'fixture-shortcut-a',
    year: 2023,
    month: 6,
    set: 1,
    sentences: [['Employers approach hiring differently.', 'Context keeps the skill alive.']]
  }),
  fixtureArticle({
    id: 'fixture-shortcut-b',
    year: 2024,
    month: 6,
    set: 2,
    sentences: [['Patience pays off in the long run.']]
  }),
  fixtureArticle({
    id: 'fixture-shortcut-c',
    year: 2025,
    month: 12,
    set: 3,
    sentences: [['Luminous lanterns mark the final line.']]
  }),
  fixtureArticle({
    id: 'fixture-shortcut-d',
    year: 2026,
    month: 6,
    set: 1,
    sentences: [['A fourth article closes the set.']]
  })
]

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-search-shortcuts-e2e-'))
  writeCorpusDirectory(corpusDirectory, articles)
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

type JsonParagraph = {
  id: string
  text: string
  sentences: { ordinal: number; text: string; start: number; end: number }[]
}

function collect(database: ReturnType<typeof openDatabase>, entry: FixtureEntry, needle: string, now: string): void {
  const paragraph = (entry.json.paragraphs as JsonParagraph[])[0]!
  const start = paragraph.text.indexOf(needle)
  const sentenceOrdinal = paragraph.sentences.findIndex(
    (sentence) => sentence.start <= start && start < sentence.end
  )
  const result = collectSelection(database, {
    articleId: entry.id,
    paragraphId: paragraph.id,
    sentenceOrdinal,
    start,
    end: start + needle.length
  })
  if (result.status === 'rejected') throw new Error(`收 ${needle} 被拒绝：${result.reason}`)
  void now
}

/** 四篇都打开过（最近 D、C、B），并收 6 个词条（最近的是 keeps）。 */
function seed(userDataDirectory: string): void {
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    migrate(database)
    importCorpus(database, { directory: corpusDirectory })
    openArticle(database, articles[0]!.id, { now: '2026-11-18T09:01:00.000Z' })
    openArticle(database, articles[1]!.id, { now: '2026-11-18T09:02:00.000Z' })
    openArticle(database, articles[2]!.id, { now: '2026-11-18T09:03:00.000Z' })
    openArticle(database, articles[3]!.id, { now: '2026-11-18T09:04:00.000Z' })
    const words = ['Employers', 'approach', 'hiring', 'differently', 'Context', 'keeps']
    words.forEach((word, index) => {
      collect(database, articles[0]!, word, `2026-11-18T09:1${index}:00.000Z`)
    })
  } finally {
    database.close()
  }
}

function environment(): Record<string, string> {
  return { CORPUS_DIRECTORY: corpusDirectory }
}

function searchDialog(page: Page) {
  return page.getByRole('dialog', { name: '全局搜索' })
}

function searchInput(page: Page) {
  return page.getByRole('searchbox', { name: '搜索词条与文章' })
}

async function openWithHotkey(page: Page): Promise<void> {
  await page.keyboard.press('Control+k')
  await expect(searchDialog(page)).toBeVisible()
  await expect(searchInput(page)).toBeFocused()
}

test('侧栏搜索入口右侧标 Ctrl K；Ctrl/Cmd+K 在任意页唤起并聚焦输入框', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: environment() })

  const nav = page.getByRole('navigation', { name: '全局导航' })
  const searchEntry = page.getByRole('button', { name: '全局搜索' })
  await expect(searchEntry.locator('.nav-kbd')).toHaveText('Ctrl K')

  await openWithHotkey(page)
  // 覆盖层开着时再按 Ctrl+K 只把焦点放回输入框，不重开、不关闭。
  await page.keyboard.press('Control+k')
  await expect(searchDialog(page)).toHaveCount(1)
  await expect(searchInput(page)).toBeFocused()

  // 输入法组合态与长按重复不触发。
  await page.keyboard.press('Escape')
  await expect(searchDialog(page)).toHaveCount(0)
  await page.evaluate(() => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        isComposing: true,
        bubbles: true,
        cancelable: true
      })
    )
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        repeat: true,
        bubbles: true,
        cancelable: true
      })
    )
  })
  await page.waitForTimeout(250)
  await expect(searchDialog(page)).toHaveCount(0)

  // 覆盖层开着时 Ctrl+B 不动底下的侧栏。
  const widthBefore = Math.round((await page.locator('.globals').boundingBox())?.width ?? 0)
  await openWithHotkey(page)
  await page.keyboard.press('Control+b')
  await page.waitForTimeout(300)
  expect(Math.round((await page.locator('.globals').boundingBox())?.width ?? 0)).toBe(widthBefore)
  await page.keyboard.press('Escape')

  // 阅读页也认同一个快捷键。
  await nav.getByRole('button', { name: '文章库' }).click()
  await page.locator('.library-row').first().click()
  await page
    .getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' })
    .click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await openWithHotkey(page)
  await page.keyboard.press('Escape')
  await expect(searchDialog(page)).toHaveCount(0)
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
})

test('空输入列出最近 3 篇文章、最近 5 条词条与常用跳转，点一下直接瞬移', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: environment() })
  await expect(page.getByRole('navigation', { name: '全局导航' })).toBeVisible()
  await openWithHotkey(page)
  const articleGroup = page.getByRole('region', { name: '最近打开的文章' })
  await expect(articleGroup.locator('[data-shortcut="article"]')).toHaveCount(3)
  await expect(articleGroup.locator('.global-search-shortcut-title')).toHaveText([
    '2026年6月 · 第1套 · 仔细阅读 Passage One',
    '2025年12月 · 第3套 · 仔细阅读 Passage One',
    '2024年6月 · 第2套 · 仔细阅读 Passage One'
  ])

  const entryGroup = page.getByRole('region', { name: '最近收集的词条' })
  await expect(entryGroup.locator('[data-shortcut="entry"]')).toHaveCount(5)
  await expect(entryGroup.locator('.global-search-shortcut-title')).toHaveText([
    'keeps',
    'Context',
    'differently',
    'hiring',
    'approach'
  ])

  const pageGroup = page.getByRole('region', { name: '常用跳转' })
  await expect(pageGroup.locator('[data-shortcut="page"]')).toHaveCount(6)
  await expect(pageGroup.getByRole('button', { name: '词条', exact: true })).toBeVisible()

  // 点最近文章：进阅读页；返回「搜索结果」重新打开空搜索。
  await articleGroup.locator('[data-shortcut="article"]').first().click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: '2026年6月 · 第1套 · 仔细阅读 Passage One', level: 1 })
  ).toBeVisible()
  await page.getByRole('button', { name: '返回搜索结果' }).click()
  await expect(searchDialog(page)).toBeVisible()
  await expect(searchInput(page)).toHaveValue('')
  await expect(page.getByRole('region', { name: '最近打开的文章' })).toBeVisible()

  // 点最近词条：直接进对应词条。
  await page
    .getByRole('region', { name: '最近收集的词条' })
    .locator('[data-shortcut="entry"]')
    .filter({ hasText: 'keeps' })
    .click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await expect(
    page.getByRole('region', { name: '词条内容' }).getByRole('heading', { name: 'keeps', level: 2 })
  ).toBeVisible()

  // 常用跳转同样直达。
  await openWithHotkey(page)
  await page
    .getByRole('region', { name: '常用跳转' })
    .getByRole('button', { name: '文章库', exact: true })
    .click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
})

test('空态输入关键词后无缝进入既有全文搜索，清空又回到最近列表', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: environment() })
  await expect(page.getByRole('navigation', { name: '全局导航' })).toBeVisible()
  await openWithHotkey(page)
  await expect(page.getByRole('region', { name: '最近打开的文章' })).toBeVisible()

  await searchInput(page).fill('hiring')
  const entryResults = page.getByRole('region', { name: '词条' }).locator('.global-search-entry')
  await expect(entryResults).toHaveCount(4)
  await expect(entryResults.first()).toContainText('Employers approach hiring differently.')
  await expect(page.getByRole('region', { name: '文章' }).locator('.global-search-article')).toHaveCount(1)

  await searchInput(page).fill('')
  await expect(page.getByRole('region', { name: '最近打开的文章' })).toBeVisible()
  await expect(page.getByRole('region', { name: '最近收集的词条' })).toBeVisible()
})
