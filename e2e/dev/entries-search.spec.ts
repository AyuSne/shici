import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries, type SeedNote, type SeedPick } from '../fixtures/entries'

const article = fixtureArticle({
  id: 'fixture-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['She approached the approachable clerk.', 'Context keeps the skill alive.'],
    ['The counter stays open late.', 'Repeated words stick.']
  ]
})

/** approach 2 句，Context 与 approachable 各 1 句；最近收集顺序是 approachable、Context、approach。 */
const standardPicks: SeedPick[] = [
  { entry: article, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
  {
    entry: article,
    paragraphIndex: 0,
    needle: 'Approaching',
    at: '2026-11-18T08:05:00.000Z'
  },
  { entry: article, paragraphIndex: 1, needle: 'Context', at: '2026-11-18T08:10:00.000Z' },
  {
    entry: article,
    paragraphIndex: 1,
    needle: 'approachable',
    at: '2026-11-18T08:15:00.000Z'
  }
]

const notes: SeedNote[] = [
  { entryMainForm: 'approach', body: '记：approach 是「做法、途径」。' },
  { entryMainForm: 'approachable', body: 'approachable 是「平易近人的」。' }
]

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-entries-search-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function seed(
  userDataDirectory: string,
  options: { picks?: readonly SeedPick[]; notes?: readonly SeedNote[] } = {}
): void {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: options.picks ?? standardPicks,
    notes: options.notes ?? []
  })
}

async function openEntries(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' })
    .click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
}

function searchBox(page: Page) {
  return page.getByRole('searchbox', { name: '搜词条名、原句或学习内容' })
}

function entryRow(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.locator('.entries-row').filter({
    has: page.locator('.entries-row-name', { hasText: new RegExp(`^${escaped}$`) })
  })
}

test.describe('词条搜索', () => {
  test('搜主词形、原句与学习内容：每条显示命中类型、真实片段并高亮关键词', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntries(page)

    // 学习内容从真实编辑入口写进去，不走 fixture 桥接。
    await entryRow(page, 'approach').click()
    await page.getByRole('button', { name: /^词典与学习内容/ }).click()
    const rail = page.locator('.entries-rail-open')
    await rail.getByRole('textbox', { name: '写学习内容' }).fill('记：approach 是「做法、途径」。')
    await rail.getByRole('button', { name: '保存学习内容' }).click()
    await expect(rail.locator('.entry-note-body')).toHaveText(['记：approach 是「做法、途径」。'])
    await page.getByRole('button', { name: '收起词典与学习内容' }).click()

    // 主词形命中。
    await searchBox(page).fill('Context')
    await expect(page.locator('.entries-row')).toHaveCount(1)
    const contextRow = entryRow(page, 'Context')
    await expect(contextRow.locator('.entries-row-hit-kind')).toHaveText('主词形')
    await expect(contextRow.locator('.entries-row-hit-snippet mark')).toHaveText('Context')

    // 原句命中：片段来自那一句，命中的词单独高亮。
    await searchBox(page).fill('hiring')
    await expect(page.locator('.entries-row')).toHaveCount(1)
    const approachRow = entryRow(page, 'approach')
    await expect(approachRow.locator('.entries-row-hit-kind')).toHaveText('原句')
    await expect(approachRow.locator('.entries-row-hit-snippet')).toContainText(
      'Employers approach hiring differently.'
    )
    await expect(approachRow.locator('.entries-row-hit-snippet mark')).toHaveText('hiring')

    // 学习内容命中：类型标「学习内容」，片段里高亮命中词。
    await searchBox(page).fill('途径')
    await expect(page.locator('.entries-row')).toHaveCount(1)
    const noteRow = entryRow(page, 'approach')
    await expect(noteRow.locator('.entries-row-hit-kind')).toHaveText('学习内容')
    await expect(noteRow.locator('.entries-row-hit-snippet')).toContainText('是「做法、途径」')
    await expect(noteRow.locator('.entries-row-hit-snippet mark')).toHaveText('途径')
  })

  test('无结果给出明确空态，清空输入恢复原列表与原选中', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntries(page)

    await entryRow(page, 'approach').click()
    const main = page.getByRole('region', { name: '词条内容' })
    await expect(main.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
    await expect(entryRow(page, 'approach')).toHaveAttribute('aria-current', 'true')

    await searchBox(page).fill('zebra')
    await expect(page.locator('.entries-row')).toHaveCount(0)
    await expect(page.locator('.entries-empty')).toContainText('没有搜到「zebra」')
    // 搜索不改当前打开的词条。
    await expect(main.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()

    await page.getByRole('button', { name: '清空搜索' }).click()
    await expect(searchBox(page)).toHaveValue('')
    await expect(page.locator('.entries-row-name')).toHaveText([
      'approachable',
      'Context',
      'approach'
    ])
    await expect(entryRow(page, 'approach')).toHaveAttribute('aria-current', 'true')
    await expect(main.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  })

  test('搜索与排序、有无学习内容筛选组合时结果仍正确', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory, { notes })
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntries(page)

    // 默认按最近收集：approachable 在前。
    await searchBox(page).fill('approach')
    await expect(page.locator('.entries-row-name')).toHaveText(['approachable', 'approach'])
    await expect(entryRow(page, 'approach').locator('.entries-row-hit-kind')).toHaveText('主词形')

    // 切字母序：结果集合不变，只换顺序。
    await page.getByRole('button', { name: '字母', exact: true }).click()
    await expect(page.locator('.entries-row-name')).toHaveText(['approach', 'approachable'])

    // 两个词条都有学习内容，has-notes 保留；no-notes 清空并给明确空态。
    const filter = page.getByRole('combobox', { name: '按学习内容筛选' })
    await filter.selectOption('has-notes')
    await expect(page.locator('.entries-row-name')).toHaveText(['approach', 'approachable'])
    await filter.selectOption('no-notes')
    await expect(page.locator('.entries-row')).toHaveCount(0)
    await expect(page.locator('.entries-empty')).toContainText('没有搜到「approach」')

    // 原句命中同样受筛选约束：approach 有学习内容时只剩它，且类型是「原句」。
    await filter.selectOption('has-notes')
    await searchBox(page).fill('hiring')
    await expect(page.locator('.entries-row')).toHaveCount(1)
    await expect(entryRow(page, 'approach').locator('.entries-row-hit-kind')).toHaveText('原句')
    await filter.selectOption('no-notes')
    await expect(page.locator('.entries-row')).toHaveCount(0)
    await expect(page.locator('.entries-empty')).toContainText('没有搜到「hiring」')
  })
})
