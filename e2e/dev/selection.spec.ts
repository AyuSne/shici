import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { startSseStub } from '../../src/testing/sse-stub'
import { clickAway, openArticle, selectText } from '../fixtures/reading'

const articleTitle = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-2026-06-s1-c1',
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
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-selection-corpus-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function openTestArticle(page: Page): Promise<void> {
  await openArticle(page, articleTitle)
}

test.describe('选词与原句', () => {
  test('跨句摘录带进文章对话，发送给模型且不收词', async ({ launch }) => {
    const stub = await startSseStub({ kind: 'stream', text: ['收到'] })
    try {
      const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory, DEEPSEEK_BASE_URL: stub.baseUrl, DEEPSEEK_API_KEY: 'test', DEEPSEEK_MODEL: 'deepseek-flash' } })
      await openTestArticle(page)
      const excerpt = 'hiring differently. Approaching a new desk'
      await selectText(page, 0, excerpt)
      await expect(page.getByRole('button', { name: '带这段去对话' })).toBeVisible()
      await expect(page.locator('.reading-selected')).toHaveCount(0)
      await page.getByRole('button', { name: '带这段去对话' }).click()
      await expect(page.getByTestId('context-summary')).toContainText('1 条摘录')
      const chip = page.locator('.context-chip').filter({ hasText: '摘录' })
      await expect(chip).toContainText('摘录')
      await page.getByRole('textbox', { name: '输入问题' }).fill('解释这段')
      await page.getByRole('button', { name: '发送' }).click()
      await expect.poll(() => stub.requests.length).toBe(1)
      expect(JSON.stringify(stub.requests[0]?.body.messages)).toContain(excerpt)
      await chip.getByRole('button', { name: /移除上下文/ }).click()
      await expect(page.getByTestId('context-summary')).not.toContainText('摘录')
      await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '词条' }).click()
      await expect(page.getByText('还没有词条', { exact: true })).toBeVisible()
    } finally { await stub.close() }
  })

  test('跨段摘录复用文章对话并保留两段正文与出处', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openTestArticle(page)
    await page.getByRole('button', { name: '与这篇文章对话' }).click()
    await expect(page.getByTestId('context-summary')).toBeVisible()
    const threadHash = await page.evaluate(() => window.location.hash)
    await openTestArticle(page)
    await page.evaluate(() => {
      const paragraphs = document.querySelectorAll('.reading-paragraph')
      const first = paragraphs[0]?.lastChild
      const second = paragraphs[1]?.firstChild
      if (!first || !second) throw new Error('没有正文段落')
      const range = document.createRange()
      range.setStartBefore(first)
      range.setEndAfter(second)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.querySelector('.reading-body')?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    })
    await page.getByRole('button', { name: '带这段去对话' }).click()
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(threadHash)
    const chip = page.locator('.context-chip').filter({ hasText: '摘录' })
    await expect(chip.locator('.context-chip-label')).toHaveAttribute('title', /段 1、段 2/)
    await expect(page.getByTestId('context-summary')).toContainText('1 条摘录')
  })

  test('圈一个词当场高亮，收成原句与词条，重读时弱高亮', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openTestArticle(page)

    await selectText(page, 0, 'hiring')

    await expect(page.locator('.reading-selected')).toHaveText(['hiring'])
    const panel = page.getByRole('complementary', { name: '选词结果' })
    await expect(panel).toBeVisible()
    await expect(panel.getByText('已收下')).toBeVisible()
    await expect(panel.locator('.reading-panel-word')).toHaveText('hiring')
    await expect(panel.getByText('词条 hiring')).toBeVisible()
    await expect(panel.locator('.reading-panel-sentence')).toHaveText(
      'Employers approach hiring differently.'
    )
    await expect(panel.getByText('已有 1 条原句 · 来自 1 篇文章')).toBeVisible()

    await clickAway(page)
    await expect(page.locator('.reading-collected')).toHaveText(['hiring'])

    // 退回文章库再打开，弱高亮还在，说明原句与归属都落了库。
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await page.locator('.library-row').first().click()
    await page
      .getByRole('complementary', { name: '文章详情' })
      .getByRole('button', { name: '继续阅读' })
      .click()
    await expect(page.locator('.reading-collected')).toHaveText(['hiring'])
  })

  test('同篇同句重复圈只留一条关联', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openTestArticle(page)

    await selectText(page, 0, 'hiring')
    await expect(page.getByRole('complementary', { name: '选词结果' })).toBeVisible()
    await clickAway(page)

    await selectText(page, 0, 'hiring')

    const panel = page.getByRole('complementary', { name: '选词结果' })
    await expect(panel.getByText('这条原句已经收过')).toBeVisible()
    await expect(panel.getByText('已有 1 条原句 · 来自 1 篇文章')).toBeVisible()
    await clickAway(page)
    await expect(page.locator('.reading-collected')).toHaveCount(1)
  })

  test('常见词形变化归入同一词条，点弱高亮能看词条卡', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openTestArticle(page)

    await selectText(page, 0, 'approach')
    await clickAway(page)
    await selectText(page, 0, 'Approaching')
    await clickAway(page)

    await expect(page.locator('.reading-collected')).toHaveCount(2)
    await page.locator('.reading-collected').first().click()

    const card = page.getByRole('complementary', { name: '词条' })
    await expect(card).toBeVisible()
    await expect(card.locator('.reading-panel-word')).toHaveText('approach')
    await expect(card.getByText('已收集 2 条原句 · 来自 1 篇文章')).toBeVisible()
    await expect(card.locator('.reading-panel-variants')).toContainText('Approaching')
    await expect(card.locator('.reading-panel-sentence')).toHaveCount(2)
  })

  test('已收集的词弱高亮可以关掉，再打开', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openTestArticle(page)

    await selectText(page, 0, 'hiring')
    await clickAway(page)
    await expect(page.locator('.reading-collected')).toHaveCount(1)

    await page.getByRole('button', { name: '阅读设置' }).click()
    await page.getByRole('checkbox', { name: '已收集的词弱高亮' }).uncheck()
    await expect(page.locator('.reading-collected')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: '阅读设置' }).click()
    await page.getByRole('checkbox', { name: '已收集的词弱高亮' }).check()
    await page.keyboard.press('Escape')
    await expect(page.locator('.reading-collected')).toHaveCount(1)
  })

  test('删原句后计数正确，删最后一条先提示再连词条一起删', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openTestArticle(page)

    await selectText(page, 0, 'approach')
    await clickAway(page)
    await selectText(page, 0, 'Approaching')
    await clickAway(page)

    await page.locator('.reading-collected').first().click()
    const card = page.getByRole('complementary', { name: '词条' })
    await expect(card.getByText('已收集 2 条原句 · 来自 1 篇文章')).toBeVisible()

    // 还剩一条时直接删，不弹确认。
    await card.getByRole('button', { name: '删除这条原句' }).first().click()
    await expect(card.getByText('已收集 1 条原句 · 来自 1 篇文章')).toBeVisible()

    // 最后一条先给提示，取消后不动。
    await card.getByRole('button', { name: '删除这条原句' }).click()
    await expect(card.getByText('这是最后一条原句')).toBeVisible()
    await card.getByRole('button', { name: '取消' }).click()
    await expect(card.getByText('已收集 1 条原句 · 来自 1 篇文章')).toBeVisible()

    await card.getByRole('button', { name: '删除这条原句' }).click()
    await card.getByRole('button', { name: '删除词条与原句' }).click()

    await expect(page.getByRole('complementary', { name: '词条' })).toHaveCount(0)
    await expect(page.locator('.reading-collected')).toHaveCount(0)
    await expect(page.getByText('原句与这个词条已删除。')).toBeVisible()
  })
})
