import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'

const article = fixtureArticle({
  id: 'fixture-navigation-c1',
  sentences: [['Employers approach hiring differently.', 'Context keeps the skill alive.']]
})
const otherTitle = '2024年6月 · 第1套 · 仔细阅读 Passage Two'
const otherArticle = fixtureArticle({
  id: 'fixture-navigation-c2',
  label: otherTitle,
  sentences: [['Another article offers a different perspective.']]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-navigation-corpus-'))
  writeCorpusDirectory(corpusDirectory, [article, otherArticle])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('从文章库回词条时仍打开刚才的词条', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })

  await nav.getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  const entryHash = await page.evaluate(() => window.location.hash)
  expect(entryHash).toMatch(/^#\/entries\/.+/)

  await nav.getByRole('button', { name: '文章库' }).click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await nav.getByRole('button', { name: '词条' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(entryHash)
})

test('从首页回对话保留线程，重复点对话不重置', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await page.locator('.entries-main-actions').getByRole('button', { name: '问模型' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  const threadHash = await page.evaluate(() => window.location.hash)
  expect(threadHash).toMatch(/^#\/chat\/.+/)

  await nav.getByRole('button', { name: '首页' }).click()
  await nav.getByRole('button', { name: '对话' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(threadHash)

  const input = page.getByRole('textbox', { name: '输入问题' })
  await input.fill('尚未发送的问题')
  const historyLength = await page.evaluate(() => window.history.length)
  await nav.getByRole('button', { name: '对话' }).click()
  await expect(input).toHaveValue('尚未发送的问题')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(threadHash)
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength)
})

test('切页回来和刷新后，文章库仍选中刚才的文章', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '文章库' }).click()
  const second = page.locator('.library-row').nth(1)
  await second.click()
  const detail = page.getByRole('complementary', { name: '文章详情' })
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText(otherTitle)

  await nav.getByRole('button', { name: '词条' }).click()
  await nav.getByRole('button', { name: '文章库' }).click()
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText(otherTitle)
  await expect(page.locator('.library-row').nth(1)).toHaveAttribute('aria-current', 'true')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(
    `#/library/${otherArticle.id}`
  )

  await page.reload()
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText(otherTitle)
  await expect(page.locator('.library-row').nth(1)).toHaveAttribute('aria-current', 'true')
})

test('重新导入语料后，文章库地址仍指向选中的文章', async ({ launch }) => {
  const directory = await mkdtemp(join(tmpdir(), 'english-learning-navigation-reimport-'))
  try {
    const broken = fixtureArticle({
      id: 'fixture-broken',
      sentences: [['The original sentence.']]
    })
    const paragraphs = broken.json.paragraphs as { sentences: { text: string }[] }[]
    paragraphs[0]!.sentences[0]!.text = 'A sentence that no longer matches.'
    writeCorpusDirectory(directory, [article, otherArticle, broken])
    const { page } = await launch({ env: { CORPUS_DIRECTORY: directory } })
    await page.getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '文章库' }).click()
    await page.locator('.library-row').nth(1).click()
    await expect(page.getByRole('complementary', { name: '文章详情' })
      .getByRole('heading', { level: 2 })).toHaveText(otherTitle)
    await page.getByRole('button', { name: '重新导入' }).click()
    await expect(page.getByRole('status')).toContainText('重新导入完成')
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(
      `#/library/${otherArticle.id}`
    )
    await page.reload()
    await expect(page.getByRole('complementary', { name: '文章详情' })
      .getByRole('heading', { level: 2 })).toHaveText(otherTitle)
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('阅读导航在没有读过的文章时显示空态，有时续读最近一篇', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '阅读' }).click()
  await expect(page.getByRole('heading', { name: '先挑一篇' })).toBeVisible()
  await page.getByRole('button', { name: '从文章库挑一篇' }).click()

  await page.locator('.library-row').nth(1).click()
  await page.getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' }).click()
  await expect(page.getByRole('heading', { name: otherTitle, level: 1 })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await nav.getByRole('button', { name: '首页' }).click()
  await nav.getByRole('button', { name: '阅读' }).click()
  await expect(page.getByRole('heading', { name: otherTitle, level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(
    `#/reading/${otherArticle.id}?from=home`
  )
})

test('在词条地址刷新或重启，仍回到这个词条', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const environment = { CORPUS_DIRECTORY: corpusDirectory }
  const first = await launch({ env: environment })
  await first.page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' }).click()
  await first.page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await expect(first.page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  const entryHash = await first.page.evaluate(() => window.location.hash)
  await first.page.reload()
  await expect(first.page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  await expect.poll(() => first.page.evaluate(() => window.location.hash)).toBe(entryHash)
  await first.close()

  const second = await launch({ userDataDirectory, env: environment })
  await expect(second.page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  await expect.poll(() => second.page.evaluate(() => window.location.hash)).toBe(entryHash)
})

test('在其他页面刷新后，全局导航仍能回到最近的词条', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  const entryHash = await page.evaluate(() => window.location.hash)
  await nav.getByRole('button', { name: '首页' }).click()
  await page.reload()
  await nav.getByRole('button', { name: '词条' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(entryHash)
})

test('线程地址刷新和重启后仍打开原线程；主动新建后导航回空白线程', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const environment = { CORPUS_DIRECTORY: corpusDirectory }
  const first = await launch({ env: environment })
  await first.page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' }).click()
  await first.page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await first.page.locator('.entries-main-actions').getByRole('button', { name: '问模型' }).click()
  await expect(first.page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  const threadHash = await first.page.evaluate(() => window.location.hash)
  await first.page.reload()
  await expect(first.page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  await expect.poll(() => first.page.evaluate(() => window.location.hash)).toBe(threadHash)
  await first.close()

  const second = await launch({ userDataDirectory, env: environment })
  const page = second.page
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(threadHash)
  await page.getByRole('complementary', { name: '对话列表' })
    .getByRole('button', { name: '新的学习' }).click()
  await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '首页' }).click()
  await nav.getByRole('button', { name: '对话' }).click()
  await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/chat')
})

test('文章地址刷新和重启后仍显示原文', async ({ launch, userDataDirectory }) => {
  const environment = { CORPUS_DIRECTORY: corpusDirectory }
  const first = await launch({ env: environment })
  await first.page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' }).click()
  await first.page.locator('.library-row').nth(1).click()
  await first.page.getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' }).click()
  await expect(first.page.getByRole('heading', { name: otherTitle, level: 1 })).toBeVisible()
  const articleHash = await first.page.evaluate(() => window.location.hash)
  await first.page.reload()
  await expect(first.page.getByRole('heading', { name: otherTitle, level: 1 })).toBeVisible()
  await expect.poll(() => first.page.evaluate(() => window.location.hash)).toBe(articleHash)
  await first.close()

  const second = await launch({ userDataDirectory, env: environment })
  await expect(second.page.getByRole('heading', { name: otherTitle, level: 1 })).toBeVisible()
  await expect.poll(() => second.page.evaluate(() => window.location.hash)).toBe(articleHash)
})

test('没有当前词条和线程时，导航到对应的空态', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '词条' }).click()
  await expect(page.getByText('还没有词条', { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/entries')
  await nav.getByRole('button', { name: '对话' }).click()
  await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/chat')
})
