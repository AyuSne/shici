import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'
import { openArticle } from '../fixtures/reading'

/**
 * 「稍后看」从词条页、阅读词条卡两处标记，首页单列显示并可移除；
 * 状态落在独立标记表里，所以切页、回词条都还在，取消后三处一起回到未标。
 */

const article = fixtureArticle({
  id: 'fixture-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Context keeps the skill alive.'],
    ['A steady habit keeps the reading going.']
  ]
})

const articleTitle = '2026年6月 · 第1套 · 仔细阅读 Passage One'
const laterEmptyText = '还没有稍后看的词。在词条页或阅读词条卡上标一下，会收到这里。'

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-later-corpus-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function seed(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
      { entry: article, paragraphIndex: 0, needle: 'Context', at: '2026-11-18T08:05:00.000Z' },
      { entry: article, paragraphIndex: 1, needle: 'habit', at: '2026-11-18T08:10:00.000Z' }
    ]
  })
}

async function nav(page: Page, label: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: label, exact: true })
    .click()
}

function entryRow(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.locator('.entries-row').filter({
    has: page.locator('.entries-row-name', { hasText: new RegExp(`^${escaped}$`) })
  })
}

test.describe('稍后看', () => {
  test('词条页标记后首页单列显示、能进正确词条，移除后给出「已移除」', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await nav(page, '词条')
    await entryRow(page, 'approach').click()

    const main = page.getByRole('region', { name: '词条内容' })
    const toggle = main.getByRole('button', { name: '稍后看', exact: true })
    await expect(toggle).toHaveAttribute('aria-pressed', 'false')
    await toggle.click()

    const marked = main.getByRole('button', { name: '取消稍后看', exact: true })
    await expect(marked).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.toast')).toHaveText('已把「approach」加入稍后看。')

    // 切到首页：单列显示，最近收集仍是原来的三个词条。
    await nav(page, '首页')
    const later = page.getByRole('region', { name: '稍后看' })
    await expect(later.locator('.home-later-row')).toHaveCount(1)
    await expect(later.locator('.home-later-form')).toHaveText(['approach'])
    await expect(page.locator('.home-entry')).toHaveCount(3)

    // 从首页打开的是这个词条，不是列表里的第一条。
    await later.locator('.home-later-open').click()
    await expect(
      page
        .getByRole('region', { name: '词条内容' })
        .getByRole('heading', { name: 'approach', level: 2 })
    ).toBeVisible()
    await expect(
      page.getByRole('region', { name: '词条内容' }).getByRole('button', {
        name: '取消稍后看',
        exact: true
      })
    ).toBeVisible()

    // 再回首页移除：行消失、明确空态、可见且可读的「已移除」。
    await nav(page, '首页')
    await expect(later.locator('.home-later-row')).toHaveCount(1)
    await later
      .getByRole('button', { name: '从稍后看移除 approach', exact: true })
      .click()
    await expect(later.locator('.home-later-row')).toHaveCount(0)
    await expect(later.getByText(laterEmptyText)).toBeVisible()
    const notice = later.locator('.home-later-notice')
    await expect(notice).toHaveText('已移除「approach」的稍后看标记。')
    await expect(notice).toHaveAttribute('role', 'status')
    await expect(page.locator('.home-entry')).toHaveCount(3)
  })

  test('阅读词条卡也能标记，取消后词条页一起回到「稍后看」', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    // 点正文里已收集的弱高亮，打开这张阅读词条卡。
    await page.locator('.reading-collected').first().click()
    const card = page.getByRole('complementary', { name: '词条' })
    await expect(card).toBeVisible()
    await card.getByRole('button', { name: '稍后看', exact: true }).click()

    await expect(
      card.getByRole('button', { name: '取消稍后看', exact: true })
    ).toHaveAttribute('aria-pressed', 'true')
    await expect(card.locator('.reading-panel-later-status')).toHaveText(
      '已把「approach」加入稍后看。'
    )

    // 退出阅读，回首页看到同一条标记。
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
    await nav(page, '首页')
    const later = page.getByRole('region', { name: '稍后看' })
    await expect(later.locator('.home-later-form')).toHaveText(['approach'])

    // 首页移除后，词条页也应回到未标状态。
    await page
      .getByRole('region', { name: '稍后看' })
      .getByRole('button', { name: '从稍后看移除 approach', exact: true })
      .click()
    await nav(page, '词条')
    await entryRow(page, 'approach').click()
    const main = page.getByRole('region', { name: '词条内容' })
    await expect(
      main.getByRole('button', { name: '稍后看', exact: true })
    ).toHaveAttribute('aria-pressed', 'false')
  })
})
