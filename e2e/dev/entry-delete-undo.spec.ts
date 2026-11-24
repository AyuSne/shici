import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { clickAway, openArticle, selectText } from '../fixtures/reading'

/**
 * #83 AC4 / #79：阅读词条卡里删除非最后一条原句，先收进次级菜单，
 * 删除后顶部 5 秒撤销按原句锚点、原词形与原收集时间恢复；最后一条仍是危险确认。
 */

const articleTitle = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-entry-delete-undo',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    [
      'Employers approach hiring differently.',
      'Approaching a new desk takes patience and a little nerve.'
    ],
    ['She approached the counter quietly.', 'Practice keeps the skill alive over time.']
  ]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-entry-delete-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function collectTwo(page: Page): Promise<void> {
  await selectText(page, 0, 'approach')
  await clickAway(page)
  await selectText(page, 0, 'Approaching')
  await clickAway(page)
}

async function openCard(page: Page) {
  await page.locator('.reading-collected').first().click()
  const card = page.getByRole('complementary', { name: '词条' })
  await expect(card).toBeVisible()
  return card
}

async function deleteFromMenu(card: ReturnType<Page['locator']>): Promise<void> {
  await card.getByRole('button', { name: '原句操作' }).first().click()
  await card.getByRole('menuitem', { name: '删除这条原句' }).click()
}

async function sentenceCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke(channel: string, payload: unknown): Promise<unknown> }
    }).api
    const listing = (await api.invoke('entries:list', {})) as {
      entries: { id: string; mainForm: string; sentenceCount: number }[]
    }
    return listing.entries[0]?.sentenceCount ?? 0
  })
}

test('非最后一条从次级菜单删除：顶部撤销恢复原句、卡片与正文，数据库计数一致', async ({
  launch
}) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, articleTitle)
  await collectTwo(page)
  const card = await openCard(page)
  await expect(card.getByText('已收集 2 条原句 · 来自 1 篇文章')).toBeVisible()

  // 删除不再常驻在行内：只有打开 `···` 才看见，避免误碰。
  await expect(card.getByRole('button', { name: '删除这条原句' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: '原句操作' })).toHaveCount(2)

  // 菜单要有点击区、层级与 Esc 层级：Esc 先收菜单，不收起整张词条卡。
  const moreButton = card.getByRole('button', { name: '原句操作' }).first()
  await moreButton.click()
  const menu = card.getByRole('menu', { name: '原句操作' })
  await expect(menu).toBeVisible()
  const moreBox = await moreButton.boundingBox()
  if (moreBox === null) throw new Error('没有量到原句操作按钮')
  expect(moreBox.width).toBeGreaterThanOrEqual(24)
  expect(moreBox.height).toBeGreaterThanOrEqual(24)
  const menuStyle = await menu.evaluate((element) => {
    const style = getComputedStyle(element)
    return { radius: style.borderRadius, zIndex: style.zIndex }
  })
  expect(menuStyle.radius).toBe('10px')
  expect(Number(menuStyle.zIndex)).toBeGreaterThan(1)
  expect(
    await moreButton.evaluate((element) => getComputedStyle(element).borderRadius)
  ).toBe('8px')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(card).toBeVisible()

  await deleteFromMenu(card)
  await expect(card.getByText('已收集 1 条原句 · 来自 1 篇文章')).toBeVisible()
  await expect(page.locator('.reading-collected')).toHaveCount(1)
  await expect(page.locator('.toast')).toContainText('原句已删除。')
  expect(await sentenceCount(page)).toBe(1)

  await page.locator('.toast-undo').click()
  await expect(card.getByText('已收集 2 条原句 · 来自 1 篇文章')).toBeVisible()
  await expect(page.locator('.reading-collected')).toHaveCount(2)
  expect(await sentenceCount(page)).toBe(2)

  // 非最后一条的删除/撤销都不增删词条，计数保持 1。
  const counts = await page.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke(channel: string, payload?: unknown): Promise<unknown> }
    }).api
    return (await api.invoke('counts:summary')) as { entries: number }
  })
  expect(counts.entries).toBe(1)
})

test('最后一条仍走危险确认；确认后词条与正文一起消失、导航计数回退', async ({
  launch
}) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, articleTitle)
  await collectTwo(page)
  const card = await openCard(page)

  await deleteFromMenu(card)
  await expect(page.getByText('原句已删除。')).toBeVisible()

  // 还剩一条：删除前先确认，取消不动。
  await deleteFromMenu(card)
  await expect(card.getByText('这是最后一条原句')).toBeVisible()
  await card.getByRole('button', { name: '取消' }).click()
  await expect(card.getByText('已收集 1 条原句 · 来自 1 篇文章')).toBeVisible()

  await deleteFromMenu(card)
  await card.getByRole('button', { name: '删除词条与原句' }).click()
  await expect(page.getByRole('complementary', { name: '词条' })).toHaveCount(0)
  await expect(page.locator('.reading-collected')).toHaveCount(0)
  await expect(page.getByText('原句与这个词条已删除。')).toBeVisible()

  // 阅读页隐藏全局栏；退出阅读后看真实的左栏计数。
  await page.locator('.reading-back').click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await expect(page.locator('[data-nav-count="entries"]')).toHaveText('0')
})

test('离开阅读页后撤销仍落库，但不把界面拉回旧文章', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, articleTitle)
  await collectTwo(page)
  const card = await openCard(page)
  await deleteFromMenu(card)
  await expect(page.getByText('原句已删除。')).toBeVisible()

  // 退出阅读页回到文章库；顶部撤销仍可点。
  await page.locator('.reading-back').click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await page.locator('.toast-undo').click()
  await page.waitForTimeout(200)

  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await expect(page.locator('[data-reading-page="true"]')).toHaveCount(0)
  expect(await sentenceCount(page)).toBe(2)
})
