import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'

const article = fixtureArticle({
  id: 'fixture-view-state',
  sentences: [['Employers approach hiring differently.', 'Context keeps the skill alive.']]
})
const words = [
  'anchor', 'bridge', 'canvas', 'dawn', 'engine', 'forest', 'garden', 'harbor',
  'island', 'journey', 'kernel', 'lantern', 'meadow', 'notion', 'orchard', 'planet',
  'quiet', 'river', 'silver', 'temple', 'urban', 'valley', 'window', 'yellow',
  'zephyr', 'bottle', 'candle', 'dragon', 'eagle', 'feather'
]
const longArticle = fixtureArticle({
  id: 'fixture-view-state-long',
  sentences: words.map((word) => [`Vocabulary includes ${word} in context.`])
})
const libraryArticles = Array.from({ length: 25 }, (_, index) => fixtureArticle({
  id: `fixture-view-state-library-${index}`,
  label: `2024年6月 · 第1套 · 仔细阅读 ${index + 1}`,
  sentences: [['A small article for browsing.']]
}))

let corpusDirectory: string
const stubs: SseStub[] = []

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-view-state-'))
  writeCorpusDirectory(corpusDirectory, [article, longArticle, ...libraryArticles])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

test('切页后线程和未发送的草稿还在；刷新只恢复地址中的线程', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await page.getByRole('button', { name: '开始对话' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  const threadHash = await page.evaluate(() => window.location.hash)
  await page.getByRole('textbox', { name: '输入问题' }).fill('尚未发送的问题')

  await nav.getByRole('button', { name: '词条' }).click()
  await nav.getByRole('button', { name: '对话' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '输入问题' })).toHaveValue('尚未发送的问题')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(threadHash)

  await page.reload()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '输入问题' })).toHaveValue('')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(threadHash)
})

test('不同线程各自保留未发送的草稿', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach' },
      { entry: article, paragraphIndex: 0, needle: 'Context' }
    ]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await page.getByRole('button', { name: '开始对话' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  await page.getByRole('textbox', { name: '输入问题' }).fill('第一个问题')

  await nav.getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'Context' }).click()
  await page.getByRole('button', { name: '开始对话' }).click()
  await expect(page.getByRole('heading', { name: 'Context', level: 1 })).toBeVisible()
  const input = page.getByRole('textbox', { name: '输入问题' })
  await expect(input).toHaveValue('')
  await input.fill('第二个问题')

  const threads = page.getByRole('complementary', { name: '对话列表' })
  await threads.locator('.thread-row').filter({ hasText: 'approach' }).click()
  await expect(input).toHaveValue('第一个问题')
  await threads.locator('.thread-row').filter({ hasText: 'Context' }).click()
  await expect(input).toHaveValue('第二个问题')
})

test('词条搜索、排序、筛选和两处滚动在切页后保持', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: words.flatMap((word, paragraphIndex) => [
      { entry: longArticle, paragraphIndex, needle: word },
      { entry: longArticle, paragraphIndex, needle: 'context' }
    ])
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '词条' }).click()
  await page.getByRole('searchbox', { name: '搜词条名、原句或学习内容' }).fill('Vocabulary')
  await page.getByRole('button', { name: '字母' }).click()
  await page.getByLabel('按学习内容筛选').selectOption('no-notes')
  await expect(page.locator('.entries-row')).toHaveCount(31)
  await page
    .locator('.entries-row')
    .filter({ has: page.locator('.entries-row-name', { hasText: /^context$/ }) })
    .click()
  await expect(page.locator('.entry-sentence')).toHaveCount(30)

  const list = page.locator('.entries-rows')
  const main = page.locator('main')
  await list.evaluate((node) => { node.scrollTop = 250 })
  await main.evaluate((node) => { node.scrollTop = 350 })
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(200)
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBeGreaterThan(300)
  const listTop = await list.evaluate((node) => node.scrollTop)
  const mainTop = await main.evaluate((node) => node.scrollTop)

  await nav.getByRole('button', { name: '设置' }).click()
  await nav.getByRole('button', { name: '词条' }).click()
  await expect(page.getByRole('searchbox', { name: '搜词条名、原句或学习内容' })).toHaveValue('Vocabulary')
  await expect(page.getByRole('button', { name: '字母' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByLabel('按学习内容筛选')).toHaveValue('no-notes')
  await expect(page.getByRole('heading', { name: 'context', level: 2 })).toBeVisible()
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBe(listTop)
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(mainTop)
})

test('不同词条分别记住正文滚动位置', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: words.flatMap((_, paragraphIndex) => [
      { entry: longArticle, paragraphIndex, needle: 'Vocabulary' },
      { entry: longArticle, paragraphIndex, needle: 'context' }
    ])
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' }).click()
  const main = page.locator('main')
  const vocabulary = page.locator('.entries-row').filter({ hasText: 'Vocabulary' })
  const context = page.locator('.entries-row').filter({ hasText: 'context' })

  await vocabulary.click()
  await expect(page.locator('.entry-sentence')).toHaveCount(30)
  await main.evaluate((node) => { node.scrollTop = 350 })
  await expect.poll(() => main.evaluate((node) => Math.round(node.scrollTop))).toBe(350)
  const vocabularyTop = await main.evaluate((node) => node.scrollTop)

  await context.click()
  await expect(page.getByRole('heading', { name: 'context', level: 2 })).toBeVisible()
  await expect(page.locator('.entry-sentence')).toHaveCount(30)
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(0)
  await main.evaluate((node) => { node.scrollTop = 700 })
  await expect.poll(() => main.evaluate((node) => Math.round(node.scrollTop))).toBe(700)
  const contextTop = await main.evaluate((node) => node.scrollTop)
  expect(contextTop).toBeGreaterThan(vocabularyTop + 300)

  await vocabulary.click()
  await expect(page.getByRole('heading', { name: 'Vocabulary', level: 2 })).toBeVisible()
  await expect.poll(async () => Math.abs(await main.evaluate((node) => node.scrollTop) - vocabularyTop))
    .toBeLessThanOrEqual(1)
  await context.click()
  await expect(page.getByRole('heading', { name: 'context', level: 2 })).toBeVisible()
  await expect.poll(async () => Math.abs(await main.evaluate((node) => node.scrollTop) - contextTop))
    .toBeLessThanOrEqual(1)
})

test('从原句线程返回词条时，指定的原句优先于上次滚动位置', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: words.map((_, paragraphIndex) => ({
      entry: longArticle, paragraphIndex, needle: 'context'
    }))
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'context' }).click()
  const sentence = page.locator('.entry-sentence').filter({ hasText: 'Vocabulary includes feather' })
  await sentence.hover()
  await sentence.getByRole('button', { name: '用这句提问' }).click()
  await expect(page.locator('.chat-subtitle button')).toBeVisible()

  await nav.getByRole('button', { name: '词条' }).click()
  await expect(page.locator('.entry-sentence')).toHaveCount(30)
  const main = page.locator('main')
  await main.evaluate((node) => { node.scrollTop = 0 })
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(0)
  await nav.getByRole('button', { name: '对话' }).click()
  await page.locator('.chat-subtitle button').click()
  await expect(sentence).toHaveAttribute('data-focused', 'true')
  await expect(sentence).toBeInViewport()
})

test('文章库切页后保留所选文章与滚动位置', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '文章库' }).click()
  const rows = page.locator('.library-row')
  await expect(rows).toHaveCount(27)
  await rows.nth(20).click()
  await expect(rows.nth(20)).toHaveAttribute('aria-current', 'true')
  const hash = await page.evaluate(() => window.location.hash)
  const selected = [article, longArticle, ...libraryArticles].find((item) => hash.endsWith(item.id))
  expect(selected).toBeDefined()
  const selectedTitle = selected?.json.label as string
  await expect(page.getByRole('complementary', { name: '文章详情' })
    .getByRole('heading', { level: 2 })).toHaveText(selectedTitle)
  const main = page.locator('main')
  await main.evaluate((node) => { node.scrollTop = 500 })
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBeGreaterThan(450)
  const scrollTop = await main.evaluate((node) => node.scrollTop)

  await nav.getByRole('button', { name: '词条' }).click()
  await nav.getByRole('button', { name: '文章库' }).click()
  await expect(rows.nth(20)).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('complementary', { name: '文章详情' })
    .getByRole('heading', { level: 2 })).toHaveText(selectedTitle)
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(scrollTop)
})

test('文章库搜索结果中的选中项和位置在切页后保持', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '文章库' }).click()
  const search = page.getByRole('searchbox', { name: '搜篇名或正文' })
  await search.fill('small article')
  const rows = page.locator('.library-row')
  await expect(rows).toHaveCount(25)
  await rows.nth(18).click()
  await expect(rows.nth(18)).toHaveAttribute('aria-current', 'true')
  const selectedHash = await page.evaluate(() => window.location.hash)
  const main = page.locator('main')
  await main.evaluate((node) => { node.scrollTop = 400 })
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(400)

  await nav.getByRole('button', { name: '首页' }).click()
  await nav.getByRole('button', { name: '文章库' }).click()
  await expect(search).toHaveValue('small article')
  await expect(rows).toHaveCount(25)
  await expect(rows.nth(18)).toHaveAttribute('aria-current', 'true')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(selectedHash)
  await expect.poll(() => main.evaluate((node) => node.scrollTop)).toBe(400)
})

test('设置页切走再回来仍停在外观分区', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '设置' }).click()
  await page.getByRole('complementary', { name: '设置分区' })
    .getByRole('button', { name: '外观' }).click()
  await expect(page.getByRole('heading', { name: '外观' })).toBeVisible()
  await nav.getByRole('button', { name: '首页' }).click()
  await nav.getByRole('button', { name: '设置' }).click()
  await expect(page.getByRole('heading', { name: '外观' })).toBeVisible()
  await expect(page.getByRole('complementary', { name: '设置分区' })
    .getByRole('button', { name: '外观' })).toHaveAttribute('aria-current', 'location')
})

test('不同线程各自保留对话滚动位置与思维链展开状态', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach' },
      { entry: article, paragraphIndex: 0, needle: 'Context' }
    ]
  })
  const stub = await startSseStub({
    kind: 'stream',
    thinking: ['先检查语境。'],
    text: [Array.from({ length: 90 }, (_, index) => `回答第 ${index + 1} 行。`).join('\n')]
  })
  stubs.push(stub)
  const { page } = await launch({ env: {
    CORPUS_DIRECTORY: corpusDirectory,
    DEEPSEEK_BASE_URL: stub.baseUrl,
    DEEPSEEK_API_KEY: 'e2e-test-key',
    DEEPSEEK_MODEL: 'deepseek-flash'
  } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  const input = page.getByRole('textbox', { name: '输入问题' })
  const scroll = page.locator('.chat-scroll')
  await nav.getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await page.getByRole('button', { name: '开始对话' }).click()
  await input.fill('第一个问题')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
  await page.locator('.thinking-toggle').click()
  await expect(page.getByTestId('thinking-body')).toBeVisible()
  await scroll.evaluate((node) => { node.scrollTop = 500 })
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(500)

  await nav.getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'Context' }).click()
  await page.getByRole('button', { name: '开始对话' }).click()
  await input.fill('第二个问题')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
  await expect(page.locator('.thinking-toggle')).toHaveAttribute('aria-expanded', 'false')
  await scroll.evaluate((node) => { node.scrollTop = 800 })
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(800)

  const threads = page.getByRole('complementary', { name: '对话列表' })
  await threads.locator('.thread-row').filter({ hasText: 'approach' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  await expect(page.locator('.thinking-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(500)
  await nav.getByRole('button', { name: '设置' }).click()
  await nav.getByRole('button', { name: '对话' }).click()
  await expect(page.locator('.thinking-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(500)
  await threads.locator('.thread-row').filter({ hasText: 'Context' }).click()
  await expect(page.getByRole('heading', { name: 'Context', level: 1 })).toBeVisible()
  await expect(page.locator('.thinking-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(800)
  await nav.getByRole('button', { name: '首页' }).click()
  await nav.getByRole('button', { name: '对话' }).click()
  await expect(page.locator('.thinking-toggle')).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(800)
  const nearBottom = await scroll.evaluate((node) => {
    node.scrollTop = node.scrollHeight - node.clientHeight - 40
    return node.scrollTop
  })
  await nav.getByRole('button', { name: '首页' }).click()
  await nav.getByRole('button', { name: '对话' }).click()
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(nearBottom)
})

test('空白学习发出第一问后，切页仍保留新线程的浏览状态', async ({ launch }) => {
  const stub = await startSseStub({
    kind: 'stream',
    thinking: ['先看语境。'],
    text: [Array.from({ length: 80 }, (_, index) => `回答第 ${index + 1} 行。`).join('\n')]
  })
  stubs.push(stub)
  const { page } = await launch({ env: {
    CORPUS_DIRECTORY: corpusDirectory,
    DEEPSEEK_BASE_URL: stub.baseUrl,
    DEEPSEEK_API_KEY: 'e2e-test-key',
    DEEPSEEK_MODEL: 'deepseek-flash'
  } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '对话' }).click()
  const input = page.getByRole('textbox', { name: '输入问题' })
  await input.fill('第一问')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
  const threadHash = await page.evaluate(() => window.location.hash)
  expect(threadHash).toMatch(/^#\/chat\/.+/)
  await page.locator('.thinking-toggle').click()
  await input.fill('尚未发送的第二问')
  const scroll = page.locator('.chat-scroll')
  await scroll.evaluate((node) => { node.scrollTop = 400 })
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(400)

  await nav.getByRole('button', { name: '词条' }).click()
  await nav.getByRole('button', { name: '对话' }).click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(threadHash)
  await expect(input).toHaveValue('尚未发送的第二问')
  await expect(page.locator('.thinking-toggle')).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => scroll.evaluate((node) => node.scrollTop)).toBe(400)
})
