import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { writeDictionaryFixture } from '../../src/testing/dictionary-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'
import { openArticle } from '../fixtures/reading'

/**
 * 读后工作台「本篇选词」：首屏直接给每个词条的离线词典音标、首义与是否有学习内容；
 * 点单条原地展开完整词典、用一条起草学习内容并显式保存、就地切换稍后看。
 * 同一个词条在本篇多段出现时状态共用；保存一条不会丢掉别的未保存草稿，也不会跳走词条页。
 */

const TITLE = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-workbench',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE,
  sentences: [
    ['Employers approach hiring differently.'],
    ['Approaching a new desk takes patience.'],
    ['She approached the counter quietly.']
  ]
})

const dictionary = {
  entries: [
    {
      word: 'approach',
      phonetic: "ә'prәutʃ",
      translation:
        'n. 方法, 途径\\nvt. 接近, 着手处理\\nvi. 靠近\\na. 可接近的\\nadv. 接近地',
      exchange: 'p:approached/d:approached/i:approaching/3:approaches'
    },
    {
      word: 'hire',
      phonetic: "'haiә",
      translation: 'vt. 雇请, 出租\\nn. 租金',
      exchange: 'p:hired/d:hired/i:hiring/3:hires'
    },
    {
      word: 'counter',
      phonetic: "'kauntә",
      translation: 'n. 柜台\\nv. 反驳'
    }
  ],
  lemmas: [
    { form: 'approached', lemma: 'approach' },
    { form: 'approaching', lemma: 'approach' },
    { form: 'approaches', lemma: 'approach' },
    { form: 'hiring', lemma: 'hire' }
  ]
}

let corpusDirectory: string
let dictionaryDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-workbench-corpus-'))
  writeCorpusDirectory(corpusDirectory, [article])

  dictionaryDirectory = await mkdtemp(join(tmpdir(), 'english-learning-workbench-dictionary-'))
  writeDictionaryFixture(join(dictionaryDirectory, 'ecdict.db'), dictionary)
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  await rm(dictionaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function environment(): Record<string, string> {
  return {
    CORPUS_DIRECTORY: corpusDirectory,
    DICTIONARY_DIRECTORY: dictionaryDirectory
  }
}

function wordsHash(page: Page): Promise<string> {
  return page.evaluate(() => window.location.hash)
}

async function openWorkbench(page: Page): Promise<void> {
  await openArticle(page, TITLE)
  await page.getByRole('button', { name: '查看本篇已拾词' }).click()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
}

test('首屏给音标、首义与学习内容状态；点单条原地展开完整词典，不跳离列表', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach' },
      { entry: article, paragraphIndex: 0, needle: 'hiring' },
      { entry: article, paragraphIndex: 1, needle: 'Approaching' },
      { entry: article, paragraphIndex: 2, needle: 'counter' }
    ],
    notes: [{ entryMainForm: 'hiring', body: 'hire 是雇请；hiring 是招聘。' }]
  })
  const { page } = await launch({ env: environment() })
  await openWorkbench(page)
  const hash = await wordsHash(page)

  const cards = page.locator('.article-words-entry')
  await expect(cards).toHaveCount(4)
  const approachCards = cards.filter({
    has: page.locator('.article-words-entry-form', { hasText: 'approach' })
  })
  await expect(approachCards.locator('.article-words-entry-form')).toHaveText([
    'approach',
    'approach'
  ])
  await expect(approachCards.locator('.article-words-entry-phonetic')).toHaveText([
    '/əˈprəutʃ/',
    '/əˈprəutʃ/'
  ])
  await expect(approachCards.locator('.article-words-entry-sense')).toHaveText([
    'n. 方法, 途径',
    'n. 方法, 途径'
  ])
  await expect(approachCards.locator('.article-words-entry-status')).toHaveText([
    '没有学习内容',
    '没有学习内容'
  ])

  const hiringCard = cards.filter({
    has: page.locator('.article-words-entry-form', { hasText: 'hiring' })
  })
  await expect(hiringCard.locator('.article-words-entry-phonetic')).toHaveText('/ˈhaiə/')
  await expect(hiringCard.locator('.article-words-entry-sense')).toHaveText('vt. 雇请, 出租')
  await expect(hiringCard.locator('.article-words-entry-status')).toHaveText('有学习内容')

  const counterCard = cards.filter({
    has: page.locator('.article-words-entry-form', { hasText: 'counter' })
  })
  await expect(counterCard.locator('.article-words-entry-status')).toHaveText('没有学习内容')

  // 点单条：词典在原地展开；同一个词条的两处出现共用同一份展开状态。
  await approachCards.first().locator('.article-words-entry-link').click()
  await expect(page.locator('.article-words-entry .dictionary')).toHaveCount(2)
  await expect(approachCards.first().locator('.dictionary-sense')).toHaveCount(3)
  await approachCards.first().getByRole('button', { name: '展开其余 2 条' }).click()
  await expect(approachCards.first().locator('.dictionary-sense')).toHaveCount(5)
  await expect(approachCards.nth(1).locator('.dictionary-sense')).toHaveCount(3)
  expect(await wordsHash(page)).toBe(hash)

  // 只有显式「打开词条」才离开列表。
  await counterCard.getByRole('button', { name: '打开词条' }).click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'counter', level: 2 })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/entries\//)
})

test('用词典释义起草只填草稿，显式保存才写学习内容；重复词条与其它草稿都不丢', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach' },
      { entry: article, paragraphIndex: 1, needle: 'Approaching' },
      { entry: article, paragraphIndex: 2, needle: 'counter' }
    ]
  })
  const { page } = await launch({ env: environment() })
  await openWorkbench(page)
  const hash = await wordsHash(page)
  const cards = page.locator('.article-words-entry')
  const approachCards = cards.filter({
    has: page.locator('.article-words-entry-form', { hasText: 'approach' })
  })
  const counterCard = cards.filter({
    has: page.locator('.article-words-entry-form', { hasText: 'counter' })
  })

  // 展开 approach 并点第一条释义起草：只填编辑框，状态与库都不变。
  await approachCards.first().locator('.article-words-entry-link').click()
  await approachCards.first().getByRole('button', { name: '用这条起草' }).first().click()
  const approachDraft = approachCards.locator('.article-words-draft')
  await expect(approachDraft).toHaveCount(2)
  await expect(approachDraft.first()).toHaveValue(/^approach \/əˈprəutʃ\/\nn\. 方法, 途径/)
  await expect(approachCards.locator('.article-words-entry-status')).toHaveText([
    '没有学习内容',
    '没有学习内容'
  ])
  expect(await wordsHash(page)).toBe(hash)

  // counter 起草自己的内容；approach 的未保存草稿仍在。
  await counterCard.locator('.article-words-entry-link').click()
  await counterCard.getByRole('button', { name: '用这条起草' }).first().click()
  const counterDraft = counterCard.locator('.article-words-draft')
  await expect(counterDraft).toHaveValue(/^counter \/ˈkauntə\/\nn\. 柜台/)
  await expect(approachDraft.first()).toHaveValue(/^approach \/əˈprəutʃ\/\nn\. 方法, 途径/)
  expect(await wordsHash(page)).toBe(hash)

  // 先保存 counter：只有它变成有学习内容，approach 草稿不受影响，也没有跳走。
  await counterCard.getByRole('button', { name: '保存学习内容' }).click()
  await expect(page.getByRole('status')).toContainText('学习内容已保存')
  await expect(counterCard.locator('.article-words-entry-status')).toHaveText('有学习内容')
  await expect(approachCards.locator('.article-words-entry-status')).toHaveText([
    '没有学习内容',
    '没有学习内容'
  ])
  await expect(approachDraft.first()).toHaveValue(/^approach \/əˈprəutʃ\/\nn\. 方法, 途径/)
  expect(await wordsHash(page)).toBe(hash)

  // 再保存 approach：两处重复出现同时变成有学习内容。
  await approachCards.first().getByRole('button', { name: '保存学习内容' }).click()
  await expect(approachCards.locator('.article-words-entry-status')).toHaveText([
    '有学习内容',
    '有学习内容'
  ])
  await expect(counterCard.locator('.article-words-entry-status')).toHaveText('有学习内容')
  expect(await wordsHash(page)).toBe(hash)

  // 就地切换稍后看：同一词条的两处保持一致，刷新后仍在。
  await approachCards.first().getByRole('button', { name: '稍后看', exact: true }).click()
  await expect
    .poll(() =>
      approachCards.locator('.article-words-later').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('aria-pressed'))
      )
    )
    .toEqual(['true', 'true'])
  await expect(approachCards.locator('.article-words-later')).toHaveText([
    '取消稍后看',
    '取消稍后看'
  ])
  await counterCard.getByRole('button', { name: '稍后看', exact: true }).click()
  await expect(counterCard.locator('.article-words-later')).toHaveAttribute('aria-pressed', 'true')
  expect(await wordsHash(page)).toBe(hash)

  await page.reload()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  const reloaded = page.locator('.article-words-entry')
  const reloadedApproach = reloaded.filter({
    has: page.locator('.article-words-entry-form', { hasText: 'approach' })
  })
  await expect(reloadedApproach.locator('.article-words-entry-status')).toHaveText([
    '有学习内容',
    '有学习内容'
  ])
  await expect
    .poll(() =>
      reloadedApproach.locator('.article-words-later').evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('aria-pressed'))
      )
    )
    .toEqual(['true', 'true'])
})
