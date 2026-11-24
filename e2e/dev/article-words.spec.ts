import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'
import { openArticle } from '../fixtures/reading'

const TITLE = '2026年6月 · 第1套 · 仔细阅读 Passage One'

function readingFontSize(page: import('@playwright/test').Page): Promise<string> {
  return page
    .locator('.reading')
    .evaluate((element) => getComputedStyle(element).getPropertyValue('--reading-font-size').trim())
}

const article = fixtureArticle({
  id: 'fixture-article-words',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE,
  sentences: [
    ['Employers approach hiring differently.', 'Practice keeps the skill alive.'],
    ['Approaching a new desk takes patience.'],
    ['She approached the counter quietly.']
  ]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-article-words-e2e-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('从阅读顶栏查看本篇已拾词，按段落列出词条与原句，点词条选中对应词条', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
      { entry: article, paragraphIndex: 0, needle: 'Practice', at: '2026-11-18T08:05:00.000Z' },
      { entry: article, paragraphIndex: 2, needle: 'approached', at: '2026-11-18T08:10:00.000Z' }
    ]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, TITLE)

  await page.getByRole('button', { name: '查看本篇已拾词' }).click()

  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible()
  await expect(page.locator('.article-words-summary')).toHaveText('2 个词条 · 3 条原句')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(
    `#/reading/${article.id}/words?from=library&wordsFrom=reader`
  )

  // 没有收词的段落不出现，段落仍按文章顺序。
  const paragraphs = page.locator('.article-words-paragraph')
  await expect(paragraphs).toHaveCount(2)
  await expect(page.locator('.article-words-paragraph-head').nth(0)).toContainText('第 1 段')
  await expect(page.locator('.article-words-paragraph-head').nth(1)).toContainText('第 3 段')

  // 第 1 段两个词条；approach 在第 3 段再出现一次，但整篇只算两个不同词条。
  const entries = page.locator('.article-words-entry')
  await expect(entries).toHaveCount(3)
  await expect(entries.nth(0).locator('.article-words-entry-link')).toContainText('approach')
  await expect(entries.nth(1).locator('.article-words-entry-link')).toContainText('Practice')
  await expect(entries.nth(2).locator('.article-words-entry-link')).toContainText('approach')
  await expect(entries.nth(1).locator('.article-words-sentence')).toHaveText(
    'Practice keeps the skill alive.'
  )
  await expect(entries.nth(1).locator('.article-words-surface')).toHaveText('Practice')

  // 点词条本身是原地展开词典；去词条页要显式点「打开词条」。
  await entries.nth(1).locator('.article-words-entry-link').click()
  await expect(entries.nth(1).locator('.article-words-dictionary')).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('/words')
  await entries.nth(1).getByRole('button', { name: '打开词条' }).click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Practice', level: 2 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/entries\//)
})

test('底部读完进入本篇选词后，左上返回指向阅读页而不是文章库', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, TITLE)

  await page.getByRole('button', { name: '读完并整理本篇选词' }).click()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()

  // 页脚是直接上游：说「返回阅读」，回阅读页，且阅读页自己的「返回文章库」没被改写。
  const back = page.getByRole('button', { name: '返回阅读' })
  await expect(back).toContainText('阅读')
  await back.click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible()
  const readingBack = page.getByRole('button', { name: '返回文章库' })
  await expect(readingBack).toBeVisible()
  await readingBack.click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
})

test('阅读页原本来自词条或首页时，经本篇选词回来仍回到原处', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })

  // 首页 → 继续阅读 → 本篇选词 → 返回阅读 → 返回首页。顶栏查看不写完成时间，
  // 首页的「继续阅读」仍在。
  await openArticle(page, TITLE)
  await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '首页' }).click()
  await page.getByRole('button', { name: '继续阅读' }).click()
  await expect(page.getByRole('button', { name: '返回首页' })).toBeVisible()
  await page.getByRole('button', { name: '查看本篇已拾词' }).click()
  await expect(page.getByRole('button', { name: '返回阅读' })).toBeVisible()
  await page.getByRole('button', { name: '返回阅读' }).click()
  await expect(page.getByRole('button', { name: '返回首页' })).toBeVisible()
  await page.getByRole('button', { name: '返回首页' }).click()
  // 顶栏查看不写完成时间：首页仍有「继续阅读」，不是「都读完了」的空态。
  await expect(page.getByRole('region', { name: '继续阅读' })).toBeVisible()

  // 词条 → 原文 → 本篇选词 → 返回阅读 → 返回词条。
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await page.getByRole('button', { name: '回到原文' }).first().click()
  await expect(page.getByRole('button', { name: '返回词条' })).toBeVisible()
  await page.getByRole('button', { name: '查看本篇已拾词' }).click()
  await expect(page.getByRole('button', { name: '返回阅读' })).toBeVisible()
  await page.getByRole('button', { name: '返回阅读' }).click()
  await expect(page.getByRole('button', { name: '返回词条' })).toBeVisible()
  await page.getByRole('button', { name: '返回词条' }).click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
})

test('文章库详情显示收词条数，并能从「本篇收过」打开本篇选词', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach' },
      { entry: article, paragraphIndex: 0, needle: 'Practice' },
      { entry: article, paragraphIndex: 2, needle: 'approached' }
    ]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' }).click()
  await page.locator('.library-row').first().click()

  const collected = page.getByRole('region', { name: '本篇收过' })
  await expect(collected).toBeVisible()
  await expect(collected).toContainText('2 个词条 · 3 条原句')

  await collected.getByRole('button', { name: '打开本篇选词' }).click()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  await expect(page.locator('.article-words-summary')).toHaveText('2 个词条 · 3 条原句')

  // 文章库详情是直接上游：返回目标就是文章库，并且仍选中这一篇。
  await page.getByRole('button', { name: '返回文章库' }).click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await expect(
    page.getByRole('complementary', { name: '文章详情' }).locator('.library-detail-title')
  ).toHaveText(TITLE)
})

test('本篇还没收词时有空态，并给出回到阅读的入口', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' }).click()
  await page.locator('.library-row').first().click()
  const collected = page.getByRole('region', { name: '本篇收过' })
  await expect(collected).toContainText('还没收过词')
  await collected.getByRole('button', { name: '打开本篇选词' }).click()

  const empty = page.locator('.article-words-empty')
  await expect(empty).toBeVisible()
  await expect(empty).toContainText('本篇还没收词')
  await expect(empty).toContainText('圈一个词')
  await empty.getByRole('button', { name: '回到阅读' }).click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible()
})

test('进入、退出与刷新本篇选词都不改阅读位置与本篇阅读设置', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach' },
      { entry: article, paragraphIndex: 0, needle: 'Practice' }
    ]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, TITLE)

  // 本篇阅读设置：字号调到 22。
  await page.getByRole('button', { name: '阅读设置' }).click()
  await page
    .getByRole('group', { name: '字号' })
    .getByRole('button', { name: '22', exact: true })
    .click()
  expect(await readingFontSize(page)).toBe('22px')
  await page.getByRole('button', { name: '阅读设置' }).click()
  // 等这一笔设置写进本机库，再验证进入子视图不会把它改回旧值。
  await page.waitForTimeout(300)

  // 读到末段，等节流写库落地，记下页脚显示的位置。
  await page.locator('.reading-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await page.waitForTimeout(800)
  const footer = (await page.locator('.reading-foot span').first().textContent()) ?? ''
  expect(footer).toMatch(/读到 第 \d+ 段 · 第 \d+ 句/)

  await page.getByRole('button', { name: '查看本篇已拾词' }).click()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  await page.getByRole('button', { name: '回到阅读' }).click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.locator('.reading-foot span').first()).toHaveText(footer)
  expect(await readingFontSize(page)).toBe('22px')

  // 刷新停留在本篇选词的地址：仍是本篇选词；回阅读后仍是同一条位置、同一份设置。
  await page.getByRole('button', { name: '查看本篇已拾词' }).click()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  const wordsHash = await page.evaluate(() => window.location.hash)
  await page.reload()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  await expect(page.locator('.article-words-summary')).toHaveText('2 个词条 · 2 条原句')
  expect(await page.evaluate(() => window.location.hash)).toBe(wordsHash)

  await page.getByRole('button', { name: '回到阅读' }).click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.locator('.reading-foot span').first()).toHaveText(footer)
  expect(await readingFontSize(page)).toBe('22px')
})

test('直接打开本篇选词地址也能读，且不把阅读设置带跑', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.evaluate((id) => {
    window.location.hash = `#/reading/${id}/words`
  }, article.id)

  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible()
  await expect(page.locator('.article-words-empty')).toBeVisible()
  // 直接打开地址没有上游信息：左上固定说「返回阅读」，点下去也确定回阅读页。
  await page.getByRole('button', { name: '返回阅读' }).click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toBeVisible()
})
