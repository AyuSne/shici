import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'
import { clickAway, openArticle, selectText } from '../fixtures/reading'

/**
 * #81 AC2/AC5/AC8：本篇曾收词计数随收词 / 撤销即时刷新，且口径是「曾收过且本篇出现」；
 * 轻遮重读独立于弱高亮开关：关掉弱高亮仍能遮罩、露首字母、悬停或轻点揭开。
 */

const TITLE_A = '2026年6月 · 第1套 · 仔细阅读 Passage One'
const TITLE_B = '2026年6月 · 第1套 · 仔细阅读 Passage Two'

const articleA = fixtureArticle({
  id: 'fixture-count-mask-a',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE_A,
  sentences: [
    ['Reading widely makes hiring easier.', 'A steady habit keeps the skill alive.'],
    ['Hard passages reward a slow reading.']
  ]
})

const articleB = fixtureArticle({
  id: 'fixture-count-mask-b',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE_B,
  sentences: [['Old reading notes still repay a visit.']]
})

const picksB: SeedPick[] = [
  { entry: articleB, paragraphIndex: 0, needle: 'reading', at: '2026-11-18T08:00:00.000Z' }
]

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-count-mask-'))
  writeCorpusDirectory(corpusDirectory, [articleA, articleB])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const meta = (page: Page) => page.locator('.reading-bar-meta')

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: '阅读设置' }).click()
  await expect(page.getByRole('region', { name: '阅读设置' })).toBeVisible()
}

test('收词与撤销后本篇曾收词数即时刷新，文案说明是「曾收」不是「本篇已拾」', async ({
  launch
}) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, TITLE_A)
  await expect(meta(page)).toHaveText('本篇含 0 个曾收词')

  await selectText(page, 0, 'hiring')
  await clickAway(page)
  await expect(meta(page)).toHaveText('本篇含 1 个曾收词')

  await page.locator('.toast-undo').click()
  await expect(meta(page)).toHaveText('本篇含 0 个曾收词')
  await expect(page.locator('.reading-collected')).toHaveCount(0)
})

test('只在别篇收过、本篇正文也出现的词，打开时就算进曾收词数', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks: picksB })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, TITLE_A)
  await expect(meta(page)).toHaveText('本篇含 1 个曾收词')
})

test('轻遮重读独立于弱高亮：两开关组合下遮罩、首字母、悬停 / 轻点揭开都在', async ({
  launch
}) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, TITLE_A)
  await selectText(page, 0, 'hiring')
  await clickAway(page)
  await expect(page.locator('.reading-collected')).toHaveCount(1)

  await openSettings(page)
  await page.getByRole('checkbox', { name: '已收集的词弱高亮' }).uncheck()
  await expect(page.locator('.reading-collected')).toHaveCount(0)
  await page.getByRole('checkbox', { name: '轻遮重读' }).check()
  await page.keyboard.press('Escape')

  // 关掉弱高亮后轻遮重读仍生效：带底线与首字母线索，其余字透明。
  const masked = page.locator('.reading-collected.reading-masked')
  await expect(masked).toHaveCount(1)
  await expect(masked.locator('.reading-mask-hint')).toHaveText('h')
  await expect(masked.locator('.reading-mask-rest')).toHaveText('iring')
  await expect
    .poll(() =>
      masked
        .locator('.reading-mask-rest')
        .evaluate((element) => getComputedStyle(element).color)
    )
    .toBe('rgba(0, 0, 0, 0)')

  // 悬停揭开：不打开卡片也能看见完整词形。
  await masked.hover()
  await expect
    .poll(() =>
      masked
        .locator('.reading-mask-rest')
        .evaluate((element) => getComputedStyle(element).color)
    )
    .not.toBe('rgba(0, 0, 0, 0)')

  // 轻点第一次只揭开，第二次才打开词条卡；不写任何统计。
  await masked.click()
  await expect(page.locator('.reading-masked[data-revealed="true"]')).toHaveCount(1)
  await expect(page.getByRole('complementary', { name: '词条' })).toHaveCount(0)
  await masked.click()
  await expect(page.getByRole('complementary', { name: '词条' })).toBeVisible()

  // 两个开关都关掉才回到素读：已收集标记不再渲染。
  await page.keyboard.press('Escape')
  await openSettings(page)
  await page.getByRole('checkbox', { name: '轻遮重读' }).uncheck()
  await page.keyboard.press('Escape')
  await expect(page.locator('.reading-collected')).toHaveCount(0)
})
