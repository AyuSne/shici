import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'
import { openArticle } from '../fixtures/reading'

/**
 * 轻遮重读：已收集词只露首字母与底线，悬停或轻点才浮现词形。
 * 纯手动、无计分；关掉立刻回到素读。
 */

const articleTitle = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-light-mask',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.'],
    ['Practice keeps the skill alive over time.']
  ]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-light-mask-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function seed(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
}

async function openSettingsPanel(page: Page): Promise<void> {
  await page.getByRole('button', { name: '阅读设置' }).click()
  await expect(page.getByRole('region', { name: '阅读设置' })).toBeVisible()
}

test.describe('轻遮重读', () => {
  test('开启后只露首字母，悬停或轻点浮现词形；关掉恢复素读且不记任何成绩', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    const word = page.locator('.reading-collected').filter({ hasText: 'approach' })
    await expect(word).toHaveCount(1)
    await expect(word).not.toHaveClass(/reading-masked/)

    await openSettingsPanel(page)
    await page.getByRole('checkbox', { name: '轻遮重读' }).check()
    await page.keyboard.press('Escape')

    await expect(word).toHaveClass(/reading-masked/)
    await expect(word.locator('.reading-mask-hint')).toHaveText('a')
    await expect(word.locator('.reading-mask-rest')).toHaveText('pproach')
    const hiddenColor = await word
      .locator('.reading-mask-rest')
      .evaluate((element) => getComputedStyle(element).color)
    expect(hiddenColor).toBe('rgba(0, 0, 0, 0)')

    await word.hover()
    await expect
      .poll(() =>
        word.locator('.reading-mask-rest').evaluate((element) => getComputedStyle(element).color)
      )
      .toBe('rgb(143, 90, 26)')

    await page.mouse.move(2, 2)
    await expect
      .poll(() =>
        word.locator('.reading-mask-rest').evaluate((element) => getComputedStyle(element).color)
      )
      .toBe('rgba(0, 0, 0, 0)')

    // 轻点先揭开词形，不直接开卡；再点才打开词条卡。
    await word.click()
    await expect(word).toHaveAttribute('data-revealed', 'true')
    await expect(page.getByRole('complementary', { name: '词条' })).toHaveCount(0)
    await word.click()
    await expect(page.getByRole('complementary', { name: '词条' })).toBeVisible()
    await page.getByRole('complementary', { name: '词条' }).getByRole('button', { name: '关闭' }).click()

    // 设置页里读回同一个开关；关掉后立刻回到素读。
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '设置' })
      .click()
    await page
      .getByRole('complementary', { name: '设置分区' })
      .getByRole('button', { name: '阅读' })
      .click()
    await expect(page.getByRole('checkbox', { name: '轻遮重读' })).toBeChecked()
    await page.getByRole('checkbox', { name: '轻遮重读' }).uncheck()

    await openArticle(page, articleTitle)
    await expect(page.locator('.reading-masked')).toHaveCount(0)
    await expect(page.locator('.reading-collected')).toHaveText(['approach'])
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    // 揭开词形不会额外收词、建统计或排程：导航计数仍是原来那一个词条。
    await expect(page.locator('[data-nav-count="entries"]')).toHaveText('1')
  })
})
