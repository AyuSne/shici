import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { clickAway, openArticle, selectText } from '../fixtures/reading'

/**
 * 阅读全局偏好：静默圈词在任何一篇都生效，只影响收词反馈形态，
 * 不改变本篇的字号行距等旧设置。
 */

const articleTitle = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-global-reading',
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
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-global-reading-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function openReadingSettings(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '设置' })
    .click()
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
  await page
    .getByRole('complementary', { name: '设置分区' })
    .getByRole('button', { name: '阅读' })
    .click()
  await expect(page.getByRole('heading', { name: '阅读' })).toBeVisible()
}

test.describe('阅读全局偏好', () => {
  test('静默圈词：只落墨与撤销轻提示，不弹选词卡；关掉即恢复', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })

    await openReadingSettings(page)
    await page.getByRole('checkbox', { name: '静默圈词' }).check()
    await expect(page.getByRole('status')).toContainText('已保存为全局默认')

    await openArticle(page, articleTitle)
    await selectText(page, 0, 'approach')
    await expect(page.getByRole('complementary', { name: '选词结果' })).toHaveCount(0)
    await expect(page.locator('.reading-selected')).toHaveText(['approach'])
    await expect(page.locator('.toast')).toContainText('已拾下「approach」')
    await expect(page.locator('.toast').getByRole('button', { name: '撤销' })).toBeVisible()
    await clickAway(page)
    await expect(page.locator('.reading-collected')).toHaveText(['approach'])

    // 回到设置页，开关仍是开的：全局偏好存在本机库，不是这一篇的临时状态。
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await openReadingSettings(page)
    await expect(page.getByRole('checkbox', { name: '静默圈词' })).toBeChecked()
    await page.getByRole('checkbox', { name: '静默圈词' }).uncheck()

    await openArticle(page, articleTitle)
    await selectText(page, 1, 'Practice')
    await expect(page.getByRole('complementary', { name: '选词结果' })).toBeVisible()
  })

  test('阅读页面板里的全局开关与设置页共用，静默时重复收词也不给撤销', async ({
    launch
  }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    await page.getByRole('button', { name: '阅读设置' }).click()
    await page.getByRole('checkbox', { name: '静默圈词' }).check()
    await page.keyboard.press('Escape')

    await selectText(page, 0, 'approach')
    await expect(page.getByRole('complementary', { name: '选词结果' })).toHaveCount(0)
    await clickAway(page)
    await expect(page.locator('.reading-collected')).toHaveText(['approach'])

    await selectText(page, 0, 'approach')
    await expect(page.locator('.toast')).toContainText('这条原句已经收过')
    await expect(page.locator('.toast').getByRole('button', { name: '撤销' })).toHaveCount(0)
    await clickAway(page)
    await expect(page.locator('.reading-collected')).toHaveText(['approach'])

    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await openReadingSettings(page)
    await expect(page.getByRole('checkbox', { name: '静默圈词' })).toBeChecked()
  })
})
