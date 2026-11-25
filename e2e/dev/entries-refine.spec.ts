import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'

/**
 * #83 词条页减负：单一磁吸拉手、右栏去重复词头、↑/↓ 翻阅、
 * 原句动作分层与拉帘、单条删除 5 秒撤销、右栏 ··· 维护菜单与可搜索目标选择器。
 */
const article = fixtureArticle({
  id: 'fixture-craft-83-entries',
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['She approached the counter quietly.', 'The approachable clerk smiled.'],
    ['Context keeps the skill alive.']
  ]
})

const solitaryArticle = fixtureArticle({
  id: 'fixture-craft-83-solitary',
  sentences: [['A solitary sentence stands alone.']]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-craft-83-entries-'))
  writeCorpusDirectory(corpusDirectory, [article, solitaryArticle])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function seed(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
      { entry: article, paragraphIndex: 1, needle: 'approached', at: '2026-11-18T08:05:00.000Z' },
      { entry: article, paragraphIndex: 2, needle: 'Context', at: '2026-11-18T08:10:00.000Z' },
      { entry: solitaryArticle, paragraphIndex: 0, needle: 'solitary', at: '2026-11-18T08:15:00.000Z' },
      { entry: article, paragraphIndex: 1, needle: 'approachable', at: '2026-11-18T08:20:00.000Z' }
    ],
    notes: [{ entryMainForm: 'approach', body: 'approach 在这里是「做法」。' }]
  })
}

async function openEntries(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' })
    .click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
}

async function openEntry(page: Page, name: string): Promise<void> {
  await page
    .locator('.entries-row')
    .filter({ has: page.locator('.entries-row-name', { hasText: new RegExp(`^${name}$`) }) })
    .click()
  await expect(
    page.getByRole('region', { name: '词条内容' }).getByRole('heading', { name, level: 2 })
  ).toBeVisible()
}

test('顶栏不再重复学习内容开关：只由右边缘拉手展开，有内容时带琥珀微点', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openEntries(page)
  await openEntry(page, 'approach')

  const main = page.getByRole('region', { name: '词条内容' })
  await expect(main.getByRole('button', { name: /^学习内容/ })).toHaveCount(0)
  await expect(
    main.locator('.entries-main-actions').getByRole('button', { name: '问模型', exact: true })
  ).toBeVisible()

  // 收起态拉手上的微点来自已有学习内容，不额外多一个顶栏按钮。
  const handle = page.getByRole('button', { name: '展开学习内容' })
  await expect(handle.locator('.entries-rail-dot')).toBeVisible()

  await handle.click()
  const rail = page.locator('.entries-rail-open')
  await expect(rail).toBeVisible()
  // 右栏不再抄写中栏的大标题与原句统计。
  await expect(rail.getByRole('heading', { name: 'approach', level: 2 })).toHaveCount(0)
  await expect(rail.getByText('已收集 2 条原句')).toHaveCount(0)
})

test('左栏 ↑/↓ 翻阅词条，输入框里的方向键不拦截', async ({ launch, userDataDirectory }) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openEntries(page)

  const heading = page
    .getByRole('region', { name: '词条内容' })
    .getByRole('heading', { level: 2 })
  await expect(page.getByText('在左边选一个词条。')).toBeVisible()

  await page.keyboard.press('ArrowDown')
  await expect(heading).toHaveText('approachable')
  await page.keyboard.press('ArrowDown')
  await expect(heading).toHaveText('solitary')
  await page.keyboard.press('ArrowUp')
  await expect(heading).toHaveText('approachable')

  // 搜索框里按方向键只移动光标/候选，不切词条。
  const search = page.getByRole('searchbox', { name: '搜词条名、原句或学习内容' })
  await search.focus()
  await search.fill('approach')
  await page.keyboard.press('ArrowDown')
  await expect(heading).toHaveText('approachable')
  await search.fill('')
  await page.locator('.entries-title').click()
  await page.keyboard.press('ArrowDown')
  await expect(heading).toHaveText('solitary')
})

test('原句行只露高频动作：无邻句不显示前后句，有邻句 200ms 拉帘，低频动作在 ··· 里', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openEntries(page)

  // 单句文章里的原句没有任何邻句：不出现灰置的「前后句」。
  await openEntry(page, 'solitary')
  const solitary = page.locator('.entry-sentence').first()
  await solitary.hover()
  await expect(solitary.getByRole('button', { name: '前后句' })).toHaveCount(0)
  await expect(solitary.getByRole('button', { name: '问模型' })).toBeVisible()
  await expect(solitary.getByRole('button', { name: '更多原句操作' })).toBeVisible()
  await expect(solitary.getByRole('button', { name: '重新圈定' })).toHaveCount(0)

  await openEntry(page, 'approach')
  const sentence = page.locator('.entry-sentence').first()
  await sentence.hover()
  const curtain = sentence.locator('.entry-neighbors-curtain')
  await expect(curtain).toHaveAttribute('data-open', 'false')
  await expect(sentence.getByRole('button', { name: '前后句' })).toBeVisible()
  expect(
    await curtain.evaluate((element) => getComputedStyle(element).transitionDuration)
  ).toBe('0.2s')
  await sentence.getByRole('button', { name: '前后句' }).click()
  await expect(curtain).toHaveAttribute('data-open', 'true')
  await expect(sentence.locator('.entry-neighbors')).toContainText('下一句')
  await sentence.getByRole('button', { name: '前后句' }).click()
  await expect(curtain).toHaveAttribute('data-open', 'false')

  // 低频动作只在 ··· 菜单里。
  await sentence.getByRole('button', { name: '更多原句操作' }).click()
  const menu = sentence.getByRole('menu', { name: '原句操作' })
  await expect(menu.getByRole('menuitem', { name: '重新圈定' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: '删除' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})

test('删除非最后一条原句给 5 秒撤销，撤销后原句、词形与位置原样回来', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openEntries(page)
  await openEntry(page, 'approach')

  const rows = page.locator('.entry-sentence')
  await expect(rows).toHaveCount(2)
  const target = rows.filter({ hasText: 'Employers approach hiring differently.' })
  await target.hover()
  await target.getByRole('button', { name: '更多原句操作' }).click()
  await target.getByRole('menuitem', { name: '删除' }).click()

  await expect(rows).toHaveCount(1)
  await expect(page.locator('.toast')).toContainText('原句已删除。')
  const undo = page.locator('.toast').getByRole('button', { name: '撤销' })
  await expect(undo).toBeVisible()
  await undo.click()

  await expect(rows).toHaveCount(2)
  const restored = rows.filter({ hasText: 'Employers approach hiring differently.' })
  await expect(restored).toHaveCount(1)
  await expect(restored.locator('.entry-surface')).toHaveText('approach')
})

test('删最后一条原句仍是显式危险确认，不提供撤销', async ({ launch, userDataDirectory }) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openEntries(page)
  await openEntry(page, 'solitary')

  const sentence = page.locator('.entry-sentence').first()
  await sentence.hover()
  await sentence.getByRole('button', { name: '更多原句操作' }).click()
  await sentence.getByRole('menuitem', { name: '删除' }).click()

  const dialog = page.getByRole('alertdialog', { name: '删除最后一条原句' })
  await expect(dialog).toContainText('这是最后一条原句。')
  await dialog.getByRole('button', { name: '删除词条与原句' }).click()
  await expect(page.locator('.toast')).toContainText('原句与「solitary」已删除。')
  await expect(page.locator('.toast').getByRole('button', { name: '撤销' })).toHaveCount(0)
})

test('撤销在用户已切到别的词条后完成，也不把当前页拉回原词条', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openEntries(page)
  await openEntry(page, 'approach')

  const target = page
    .locator('.entry-sentence')
    .filter({ hasText: 'Employers approach hiring differently.' })
  await target.hover()
  await target.getByRole('button', { name: '更多原句操作' }).click()
  await target.getByRole('menuitem', { name: '删除' }).click()
  await expect(page.locator('.toast').getByRole('button', { name: '撤销' })).toBeVisible()

  // 撤销还没点就切到另一个词条：恢复结果只刷新列表，不改地址与当前选择。
  await openEntry(page, 'Context')
  await page.locator('.toast').getByRole('button', { name: '撤销' }).click()
  await expect(page.locator('.toast')).toHaveCount(0)
  const heading = page
    .getByRole('region', { name: '词条内容' })
    .getByRole('heading', { level: 2 })
  await expect(heading).toHaveText('Context')
  expect(await page.evaluate(() => window.location.hash)).toContain('entries')

  await openEntry(page, 'approach')
  await expect(page.locator('.entry-sentence')).toHaveCount(2)
})

test('右栏四项维护动作收进顶部 ···，选后原地展开表单；目标选择器可即时过滤并用 Enter 选中', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openEntries(page)
  await openEntry(page, 'approach')
  await page.getByRole('button', { name: '展开学习内容' }).click()
  const rail = page.locator('.entries-rail-open')
  const more = rail.getByRole('button', { name: '词条维护' })

  await more.click()
  const menu = rail.getByRole('menu', { name: '词条维护' })
  await expect(menu.getByRole('menuitem')).toHaveText([
    '合并词条…',
    '拆分原句…',
    '换主词形…',
    '移动学习内容…'
  ])

  // 拆分与移动学习内容里的目标选择器都已升级为可搜索组件。
  await menu.getByRole('menuitem', { name: '拆分原句…' }).click()
  await expect(rail.getByRole('combobox', { name: '拆到哪个词条' })).toBeVisible()
  await rail.getByRole('button', { name: '取消' }).click()
  await more.click()
  await rail.getByRole('menuitem', { name: '移动学习内容…' }).click()
  await expect(rail.getByRole('combobox', { name: '移动到词条' })).toBeVisible()
  await rail.getByRole('button', { name: '取消' }).click()

  // 合并：输入关键词即时过滤，Enter 选中，表单保持展开。
  await more.click()
  await rail.getByRole('menuitem', { name: '合并词条…' }).click()
  const picker = rail.getByRole('combobox', { name: '要并进来的词条' })
  await picker.fill('con')
  const options = rail.getByRole('listbox', { name: '要并进来的词条候选' })
  await expect(options.getByRole('option')).toHaveCount(1)
  await expect(options.getByRole('option')).toContainText('Context')
  await picker.press('Enter')
  await expect(rail.locator('.target-picker-current')).toContainText('Context')
  await rail.getByRole('button', { name: '合并', exact: true }).click()
  await expect(page.locator('.toast')).toContainText('已把「Context」并进来')
  await expect(
    page.locator('.entries-row-name').filter({ hasText: /^Context$/ })
  ).toHaveCount(0)
})
