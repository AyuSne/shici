import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { readBootstrap } from '../fixtures/bridge'

async function openLibrary(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' })
    .click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
}

async function search(page: Page, query: string): Promise<void> {
  await page.getByRole('searchbox', { name: '搜篇名或正文' }).fill(query)
}

test.describe('语料导入与文章库', () => {
  test('首次启动导入 63 篇，按 7 个场次分组', async ({ launch }) => {
    const { page } = await launch()
    await openLibrary(page)

    await expect(page.getByText('63 篇 · 7 个场次')).toBeVisible()
    const sessions = page.locator('.library-session')
    await expect(sessions).toHaveCount(7)

    const newest = sessions.first()
    await expect(newest).toContainText('2026年6月')
    await expect(newest.locator('.library-session-head')).toContainText('9 篇')
    await expect(newest.getByRole('button', { name: /2026年6月/ })).toHaveAttribute('aria-expanded', 'true')
    await expect(newest.locator('.library-row')).toHaveCount(3)
    await expect(newest.locator('.library-row').first()).toContainText('长篇匹配')
    await newest.getByRole('button', { name: /第2套/ }).click()
    await expect(newest.locator('.library-row')).toHaveCount(6)
    await newest.getByRole('button', { name: /第1套/ }).click()
    await expect(newest.locator('.library-row')).toHaveCount(3)
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '首页' }).click()
    await openLibrary(page)
    await expect(page.locator('.library-session').first().locator('.library-row')).toHaveCount(3)
    await expect(page.locator('.library-session').first().getByRole('button', { name: /第2套/ })).toHaveAttribute('aria-expanded', 'true')
    const ai = page.getByRole('region', { name: 'AI 生成' })
    const aiToggle = ai.getByRole('button', { name: /AI 生成/ })
    await expect(aiToggle).toHaveAttribute('aria-expanded', 'false')
    await aiToggle.click()
    await expect(ai).toContainText('用一组词生成第一篇')
    await aiToggle.click()
    await expect(aiToggle).toHaveAttribute('aria-expanded', 'false')
  })

  test('搜索命中篇名与正文', async ({ launch }) => {
    const { page } = await launch()
    await openLibrary(page)

    await search(page, '长篇匹配')
    await expect(page.getByText('「长篇匹配」的结果')).toBeVisible()
    await expect(page.locator('.library-row-search')).toHaveCount(21)
    await expect(page.locator('.library-row-search').first()).toContainText('篇名命中')

    await search(page, 'algorithmic')
    const bodyHits = page.locator('.library-row-search')
    await expect(bodyHits.first()).toBeVisible()
    await expect(bodyHits.first()).toContainText('正文命中')
    await expect(bodyHits.first().locator('mark')).toContainText('algorithmic')

    await search(page, 'zebra crossing')
    await expect(page.getByText('没有找到。换个词试试，篇名和正文都会搜。')).toBeVisible()

    await page.getByRole('searchbox', { name: '搜篇名或正文' }).fill('')
    await expect(page.locator('.library-session')).toHaveCount(7)
  })

  test('详情显示篇幅与进度，继续阅读打开正文并退回', async ({ launch }) => {
    const { page } = await launch()
    await openLibrary(page)

    const firstRow = page.locator('.library-row').first()
    await firstRow.click()
    const detail = page.getByRole('complementary', { name: '文章详情' })
    await expect(detail).toContainText('2026年6月')
    await expect(detail).toContainText('未读')
    await expect(detail).toContainText('词')
    const title = (await detail.getByRole('heading', { level: 2 }).textContent())?.trim()
    expect(title).toBeTruthy()

    await detail.getByRole('button', { name: '继续阅读' }).click()
    await expect(page.getByRole('heading', { name: title ?? '', level: 1 })).toBeVisible()
    await expect(page.getByRole('navigation', { name: '全局导航' })).toHaveCount(0)

    // 阅读页收起全局栏，Esc 退回文章库。
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()

    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '首页' })
      .click()
    await expect(page.getByRole('heading', { name: title ?? '' })).toHaveCount(0)
    const homeTitle = title?.split(' · ').at(-1) ?? ''
    await expect(page.getByRole('heading', { name: homeTitle })).toBeVisible()
    await expect(page.getByText('上次停在 第 1 段 · 第 1 句')).toBeVisible()
    await expect(page.getByText(/读到 \d+%/)).toBeVisible()
  })

  test('二次启动不重复导入，继续阅读仍在', async ({ launch, userDataDirectory }) => {
    const first = await launch()
    await openLibrary(first.page)
    const detailTitle = first.page.locator('.library-detail-title')
    await expect(detailTitle).toBeVisible()
    const previousTitle = await detailTitle.innerText()
    await first.page.locator('.library-row').nth(2).click()
    await expect(detailTitle).not.toHaveText(previousTitle)
    const selectedTitle = await detailTitle.innerText()
    const selectedHash = await first.page.evaluate(() => window.location.hash)
    await first.page
      .getByRole('complementary', { name: '文章详情' })
      .getByRole('button', { name: '继续阅读' })
      .click()
    await expect(first.page.locator('[data-reading-page="true"]')).toBeVisible()
    await first.close()

    const second = await launch({ userDataDirectory })
    await expect(second.page.locator('[data-reading-page="true"]')).toBeVisible()
    await second.page.keyboard.press('Escape')
    await expect(second.page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await expect(second.page.getByText('63 篇 · 7 个场次')).toBeVisible()
    await expect(second.page.locator('.library-row')).toHaveCount(3)
    await expect(second.page.locator('.library-detail-title')).toHaveText(selectedTitle)
    await expect(second.page.locator('.library-row[aria-current="true"]')).toHaveCount(1)
    await expect.poll(() => second.page.evaluate(() => window.location.hash)).toBe(selectedHash)

    await second.page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '首页' })
      .click()
    await expect(second.page.getByText('上次停在 第 1 段 · 第 1 句')).toBeVisible()
    const bootstrap = await readBootstrap(second.page)
    expect(bootstrap.corpusImport).toMatchObject({ imported: 0, updated: 0, skipped: 63 })
  })

  test('导入有坏篇时其余篇照常入库并在文章库提示', async ({ launch }) => {
    const corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-e2e-corpus-'))
    try {
      const good = fixtureArticle({
        id: 'fixture-2024-06-s1-c1',
        sentences: [['A short passage still counts.', 'It lands in the library.']]
      })
      const broken = fixtureArticle({
        id: 'fixture-2024-06-s1-c2',
        sentences: [['This one is about to break.', 'It will not survive validation.']]
      })
      const paragraphs = broken.json.paragraphs as { sentences: { text: string }[] }[]
      const firstSentence = paragraphs[0]?.sentences[0]
      if (!firstSentence) {
        throw new Error('fixture 没有句子')
      }
      firstSentence.text = 'This sentence no longer matches the stored range.'
      writeCorpusDirectory(corpusDirectory, [good, broken])

      const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
      await openLibrary(page)

      const warning = page.getByRole('alert')
      await expect(warning).toContainText('有 1 篇没导进来，其余 1 篇已在库里。')
      await expect(warning).toContainText('fixture-2024-06-s1-c2')
      await expect(warning).toContainText('与正文对不上')
      await expect(page.getByText('1 篇 · 1 个场次')).toBeVisible()
      await expect(page.locator('.library-row')).toHaveCount(1)
      await expect(page.locator('.library-session-head')).toContainText('2024年6月')
    } finally {
      await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    }
  })
})
