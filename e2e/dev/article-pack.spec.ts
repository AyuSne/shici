import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'

/**
 * 工作台顶部的「把本篇未整理的词打包问模型」：
 * 只选本文里还没整理学习内容的词，按首次出现的段落 / 句序 / 字区间排序，超过 20 个时
 * 明确提示没带上的数量；上下文只带这些词在本文对应的原句（别篇更晚收的句子不混入）。
 * 全部整理好时不创建空对话，只给一句温和提示。
 */

const TITLE = '2026年6月 · 第1套 · 仔细阅读 Passage One'
const TITLE_B = '2026年6月 · 第1套 · 仔细阅读 Passage Two'

const article = fixtureArticle({
  id: 'fixture-pack-e2e',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE,
  sentences: [
    ['Employers approach hiring differently.', 'Practice keeps the skill alive.'],
    ['Approaching a new desk takes patience.']
  ]
})

const otherArticle = fixtureArticle({
  id: 'fixture-pack-e2e-b',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE_B,
  sentences: [['Approaching a cliff demands care.']]
})

const words = [
  'ability',
  'absorb',
  'academic',
  'access',
  'account',
  'accurate',
  'achieve',
  'acknowledge',
  'acquire',
  'adapt',
  'adequate',
  'adjust',
  'admire',
  'adopt',
  'advance',
  'advocate',
  'affect',
  'afford',
  'agency',
  'agenda',
  'aggressive',
  'agriculture',
  'allocate'
] as const

const manyArticle = fixtureArticle({
  id: 'fixture-pack-e2e-many',
  year: 2026,
  month: 6,
  set: 1,
  label: '2026年6月 · 第1套 · 长篇匹配',
  kind: 'long_match',
  sentences: words.map((word) => [`Studies of ${word} continue today.`])
})

let corpusDirectory: string
let stub: SseStub | null = null

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-pack-e2e-'))
  writeCorpusDirectory(corpusDirectory, [article, otherArticle, manyArticle])
})

test.afterEach(async () => {
  await stub?.close()
  stub = null
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function environment(): Record<string, string> {
  return {
    CORPUS_DIRECTORY: corpusDirectory,
    DEEPSEEK_BASE_URL: stub?.baseUrl ?? '',
    DEEPSEEK_API_KEY: 'e2e-test-key',
    DEEPSEEK_MODEL: 'deepseek-flash'
  }
}

async function openWorkbench(page: Page, title: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' })
    .click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await page.locator('.library-row').filter({ hasText: title.split(' · ').at(-1) }).click()
  await page
    .getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' })
    .click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible()
  await page.getByRole('button', { name: '查看本篇已拾词' }).click()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
}

async function ask(page: Page): Promise<void> {
  await page.getByRole('textbox', { name: '输入问题' }).fill('用这些词和原句出几个例句')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('好的。')).toBeVisible()
}

function systemPrompt(stubValue: SseStub): string {
  const messages = (stubValue.requests[0]?.body.messages ?? []) as {
    role: string
    content: string
  }[]
  return messages[0]?.content ?? ''
}

test('一键把本篇未整理词连同本文原句打包问模型：prompt 只带本文原句', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach' },
      { entry: article, paragraphIndex: 0, needle: 'hiring' },
      { entry: article, paragraphIndex: 0, needle: 'Practice' },
      // 同一个词条在别篇更晚收集：打包本篇时不能把这一句带进 prompt。
      { entry: otherArticle, paragraphIndex: 0, needle: 'Approaching' }
    ],
    notes: [{ entryMainForm: 'hiring', body: 'hire 是雇请；hiring 是招聘。' }]
  })
  stub = await startSseStub({ kind: 'stream', text: ['好的。'] })
  const { page } = await launch({ env: environment() })
  await openWorkbench(page, TITLE)

  // hiring 已有学习内容，不在打包范围；approach 与 Practice 两个词待整理。
  await expect(page.locator('.article-words-pack-hint')).toHaveText('还有 2 个词没有学习内容。')
  await page.getByRole('button', { name: '把本篇未整理的词打包问模型' }).click()

  await expect(page.getByRole('heading', { name: 'approach 等 2 个词', level: 1 })).toBeVisible()
  await expect(page.getByTestId('context-summary')).toContainText('2 个词')
  await expect(page.getByTestId('context-summary')).toContainText('2 条原句')
  await expect(page.getByRole('status')).toContainText('已带上 2 个词')

  await ask(page)
  const prompt = systemPrompt(stub)
  expect(prompt).toContain('[词] approach')
  expect(prompt).toContain('[词] Practice')
  expect(prompt).not.toContain('[词] hiring')
  expect(prompt).toContain('[原句] Employers approach hiring differently.')
  expect(prompt).toContain('[原句] Practice keeps the skill alive.')
  expect(prompt).not.toContain('Approaching a cliff demands care.')

  const threads = (await page.evaluate(async () => {
    const api = (
      window as unknown as {
        api: { invoke(channel: string, payload?: unknown): Promise<unknown> }
      }
    ).api
    return api.invoke('chat:list')
  })) as { threads: unknown[] }
  expect(threads.threads).toHaveLength(1)
})

test('超过 20 个未整理词时按段落与句序取前 20 个，明确提示没带上的数量', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: words.map((word, index) => ({
      entry: manyArticle,
      paragraphIndex: index,
      needle: word
    })),
    notes: [{ entryMainForm: 'absorb', body: 'absorb 的学习内容' }]
  })
  stub = await startSseStub({ kind: 'stream', text: ['好的。'] })
  const { page } = await launch({ env: environment() })
  await openWorkbench(page, '2026年6月 · 第1套 · 长篇匹配')

  await expect(page.locator('.article-words-pack-hint')).toHaveText('还有 22 个词没有学习内容。')
  await page.getByRole('button', { name: '把本篇未整理的词打包问模型' }).click()

  await expect(page.getByRole('heading', { name: 'ability 等 20 个词', level: 1 })).toBeVisible()
  await expect(page.getByRole('status')).toContainText('已带上前 20 个词')
  await expect(page.getByRole('status')).toContainText('还有 2 个没带上')
  await expect(page.getByTestId('context-summary')).toContainText('20 个词')
  await expect(page.getByTestId('context-summary')).toContainText('20 条原句')

  await ask(page)
  const prompt = systemPrompt(stub)
  expect(prompt).toContain('[原句] Studies of ability continue today.')
  expect(prompt).toContain('[原句] Studies of aggressive continue today.')
  expect(prompt).not.toContain('Studies of absorb continue today.')
  expect(prompt).not.toContain('Studies of agriculture continue today.')
  expect(prompt).not.toContain('Studies of allocate continue today.')
})

test('所有已拾词都整理过学习内容时给温和提示，不创建空对话也不导航', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach' },
      { entry: article, paragraphIndex: 0, needle: 'Practice' }
    ],
    notes: [
      { entryMainForm: 'approach', body: 'approach 的学习内容' },
      { entryMainForm: 'Practice', body: 'Practice 的学习内容', pinned: true }
    ]
  })
  stub = await startSseStub({ kind: 'stream', text: ['不应该用到。'] })
  const { page } = await launch({ env: environment() })
  await openWorkbench(page, TITLE)
  const hash = await page.evaluate(() => window.location.hash)

  await expect(page.locator('.article-words-pack-hint')).toHaveText('本篇的拾词都已整理好学习内容。')
  await page.getByRole('button', { name: '把本篇未整理的词打包问模型' }).click()

  await expect(page.getByRole('status')).toContainText('都已整理好学习内容')
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  expect(await page.evaluate(() => window.location.hash)).toBe(hash)
  expect(stub.requests).toHaveLength(0)

  // 没有新建对话：对话页仍是「还没有对话」的空态。
  await page.evaluate(() => {
    window.location.hash = '#/chat'
  })
  await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
  await expect(page.locator('.chat-rail-empty')).toHaveText('还没有对话')
})
