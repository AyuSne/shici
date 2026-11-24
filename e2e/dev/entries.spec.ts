import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'
import { selectText } from '../fixtures/reading'

const firstArticle = fixtureArticle({
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

const secondArticle = fixtureArticle({
  id: 'fixture-2026-06-s2-c2',
  year: 2026,
  month: 6,
  set: 2,
  label: '2026年6月 · 第2套 · 仔细阅读 Passage Two',
  sentences: [['Another passage approaches the same idea.', 'It reaches a different conclusion.']]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-entries-corpus-'))
  writeCorpusDirectory(corpusDirectory, [firstArticle, secondArticle])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

/** approach 收集 3 句（跨两篇），Context 与 approachable 各 1 句。 */
const standardPicks: SeedPick[] = [
  { entry: firstArticle, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
  {
    entry: firstArticle,
    paragraphIndex: 0,
    needle: 'Approaching',
    at: '2026-11-18T08:05:00.000Z'
  },
  {
    entry: secondArticle,
    paragraphIndex: 0,
    needle: 'approaches',
    at: '2026-11-18T08:10:00.000Z'
  },
  {
    entry: firstArticle,
    paragraphIndex: 1,
    needle: 'Context',
    at: '2026-11-18T08:15:00.000Z'
  },
  {
    entry: firstArticle,
    paragraphIndex: 1,
    needle: 'approachable',
    at: '2026-11-18T08:20:00.000Z'
  }
]

function seed(userDataDirectory: string, picks: SeedPick[], notes: { entryMainForm: string; body: string }[] = []): void {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks, notes })
}

async function openEntries(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' })
    .click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
}

function entryRow(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.locator('.entries-row').filter({
    has: page.locator('.entries-row-name', { hasText: new RegExp(`^${escaped}$`) })
  })
}

test.describe('词条页', () => {
  test('窄窗口仍能看清词条标题并使用两种对话入口', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory, [{ entry: firstArticle, paragraphIndex: 0, needle: 'approach' }])
    const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    if (electronApp === null) throw new Error('需要开发版 Electron 进程')
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('没有主窗口')
      window.setContentSize(900, 820)
    })
    await openEntries(page)
    await entryRow(page, 'approach').click()
    const main = page.getByRole('region', { name: '词条内容' })
    const title = main.getByRole('heading', { name: 'approach', level: 2 })
    await expect(title).toBeVisible()
    expect((await title.boundingBox())?.width ?? 0).toBeGreaterThan(64)
    await expect(main.getByRole('button', { name: '开始对话' })).toBeVisible()
    await expect(main.getByRole('button', { name: '新开一条' })).toBeVisible()
    const dimensions = await main.evaluate((element) => ({
      scroll: element.scrollWidth,
      client: element.clientWidth
    }))
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1)
  })

  test('三栏打开词条：原句按文章分组、组内按句序，动作悬停与键盘聚焦都出现', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory, standardPicks)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntries(page)

    // 左栏按最近收集排；还没选词条时中栏先让人去左边挑。
    await expect(page.locator('.entries-row-name')).toHaveText([
      'approachable',
      'Context',
      'approach'
    ])
    await expect(page.getByText('在左边选一个词条。')).toBeVisible()

    await entryRow(page, 'approach').click()
    await expect(page.getByRole('button', { name: '展开学习内容' })).toBeVisible()
    await expect(page.locator('.entries-rail-open')).toHaveCount(0)

    const main = page.getByRole('region', { name: '词条内容' })
    await expect(main.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
    await expect(main.getByText('已收集 3 条原句 · 来自 2 篇', { exact: false })).toBeVisible()

    // 组间最近收集在前；组内按段序、句序。
    const groups = main.locator('.entry-group')
    await expect(groups).toHaveCount(2)
    await expect(groups.first().locator('.entry-group-head')).toContainText(
      '2026年6月 · 第2套 · 仔细阅读 Passage Two'
    )
    await expect(groups.first().locator('.entry-group-head')).toContainText('1 句')
    await expect(groups.nth(1).locator('.entry-group-head')).toContainText(
      '2026年6月 · 第1套 · 仔细阅读 Passage One'
    )
    await expect(groups.nth(1).locator('.entry-group-head')).toContainText('2 句')
    await expect(groups.nth(1).locator('.entry-sentence-text')).toHaveText([
      'Employers approach hiring differently.',
      'Approaching a new desk takes patience.'
    ])
    await expect(groups.nth(1).locator('.entry-surface')).toHaveText(['approach', 'Approaching'])

    // 动作默认收起，悬停与键盘聚焦都要能拿到。
    const sentence = groups.nth(1).locator('.entry-sentence').first()
    const actions = sentence.locator('.entry-sentence-actions')
    await expect(actions).toHaveCSS('opacity', '0')
    await sentence.hover()
    await expect(actions).toHaveCSS('opacity', '1')
    await page.mouse.move(0, 0)
    await expect(actions).toHaveCSS('opacity', '0')
    const back = actions.getByRole('button', { name: '回到原文' })
    await back.focus()
    await expect(actions).toHaveCSS('opacity', '1')

    // 同篇前后句能就地展开。
    await sentence.hover()
    await sentence.getByRole('button', { name: '前后句' }).click()
    await expect(sentence.locator('.entry-neighbors')).toContainText(
      'Approaching a new desk takes patience.'
    )
  })

  test('学习内容可写、改、置顶、删，也能移到别的词条', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory, standardPicks)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntries(page)
    await entryRow(page, 'approach').click()
    await page.getByRole('button', { name: '展开学习内容' }).click()

    const rail = page.locator('.entries-rail-open')
    await expect(rail.getByText('可以手写，也可以从对话里钉一段进来')).toBeVisible()

    // 写一条。
    await rail.getByRole('textbox', { name: '写学习内容' }).fill('记：approach 是「做法、途径」。')
    await rail.getByRole('button', { name: '保存学习内容' }).click()
    await expect(rail.locator('.entry-note-body')).toHaveText(['记：approach 是「做法、途径」。'])
    await expect(page.locator('.toast')).toHaveText('学习内容已保存。')

    // 就地改，旧稿不保留。
    await rail.locator('.entry-note').first().getByRole('button', { name: '编辑' }).click()
    await rail.getByRole('textbox', { name: '编辑学习内容' }).fill('记：approach 在原文是「做法」。')
    await rail.getByRole('button', { name: '保存修改' }).click()
    await expect(rail.locator('.entry-note-body')).toHaveText(['记：approach 在原文是「做法」。'])

    // 再写一条，置顶另一条，置顶的排最前。
    await rail.getByRole('textbox', { name: '写学习内容' }).fill('第二条：approach to training')
    await rail.getByRole('button', { name: '保存学习内容' }).click()
    await expect(rail.locator('.entry-note-body')).toHaveText([
      '第二条：approach to training',
      '记：approach 在原文是「做法」。'
    ])
    const first = rail.locator('.entry-note').filter({ hasText: '做法' })
    await first.getByRole('button', { name: '置顶' }).click()
    await expect(first.locator('.entry-note-pin')).toHaveText('已置顶')
    await expect(rail.locator('.entry-note-body').first()).toHaveText(
      '记：approach 在原文是「做法」。'
    )

    // 取消置顶。
    await first.getByRole('button', { name: '取消置顶' }).click()
    await expect(first.locator('.entry-note-pin')).toHaveCount(0)

    // 从「更多」里移到另一个词条。
    await rail.getByRole('button', { name: '移动学习内容…' }).click()
    await rail
      .getByRole('combobox', { name: '要移动的学习内容' })
      .selectOption({ label: '第二条：approach to training' })
    await rail.getByRole('combobox', { name: '移动到词条' }).selectOption({ label: 'Context' })
    await rail.getByRole('button', { name: '移过去' }).click()
    await expect(rail.locator('.entry-note-body')).toHaveText([
      '记：approach 在原文是「做法」。'
    ])

    // 覆盖抽屉挡住后面的列表，先收起再换词条。
    await page.getByRole('button', { name: '收起学习内容' }).click()
    await entryRow(page, 'Context').click()
    await page.getByRole('button', { name: '展开学习内容' }).click()
    const contextRail = page.locator('.entries-rail-open')
    await expect(contextRail.locator('.entry-note-body')).toHaveText([
      '第二条：approach to training'
    ])

    // 删掉它。
    await contextRail.locator('.entry-note').first().getByRole('button', { name: '删除' }).click()
    await expect(contextRail.getByText('可以手写，也可以从对话里钉一段进来')).toBeVisible()
  })

  test('换主词形与合并词条后计数和归属都对', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory, standardPicks)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntries(page)
    await entryRow(page, 'approach').click()
    await page.getByRole('button', { name: '展开学习内容' }).click()

    const rail = page.locator('.entries-rail-open')
    await rail.getByRole('button', { name: '换主词形…' }).click()
    await rail.getByRole('combobox', { name: '新的主词形' }).selectOption({ label: 'Approaching' })
    await rail.getByRole('button', { name: '换主词形', exact: true }).click()
    await expect(page.getByRole('region', { name: '词条内容' }).getByRole('heading', { level: 2 })).toHaveText(
      'Approaching'
    )
    await expect(rail.locator('.entry-form-current')).toHaveText('Approaching')
    await expect(rail.locator('.entry-form').filter({ hasText: /^approach$/ })).toBeVisible()
    await expect(entryRow(page, 'Approaching')).toHaveCount(1)

    // 把 Context 并进来：4 条原句、2 篇，Context 从列表消失。
    await rail.getByRole('button', { name: '合并词条…' }).click()
    await rail.getByRole('combobox', { name: '要并进来的词条' }).selectOption({ label: 'Context（1 句）' })
    await expect(rail.getByText('合并后的主词形')).toBeVisible()
    await rail.getByRole('button', { name: '合并', exact: true }).click()
    await expect(
      page.getByRole('region', { name: '词条内容' }).getByText('已收集 4 条原句 · 来自 2 篇', { exact: false })
    ).toBeVisible()
    await expect(entryRow(page, 'Context')).toHaveCount(0)
    await expect(page.locator('.entries-row-name')).toHaveText(['approachable', 'Approaching'])
  })

  test('拆原句到另一个词条后两边计数都对，源词条的最后一条拆走就一起删掉', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory, standardPicks)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntries(page)
    await entryRow(page, 'Context').click()
    await page.getByRole('button', { name: '展开学习内容' }).click()

    const rail = page.locator('.entries-rail-open')
    await rail.getByRole('button', { name: '拆分原句…' }).click()
    await rail.getByRole('combobox', { name: '拆到哪个词条' }).selectOption({ label: 'approach' })
    await expect(rail.getByText('这是最后一条原句')).toBeVisible()
    await rail.getByRole('button', { name: '拆走并删除词条' }).click()

    await expect(page.getByText('原句已拆到「approach」。')).toBeVisible()
    await expect(entryRow(page, 'Context')).toHaveCount(0)
    await expect(page.locator('.entries-row-name')).toHaveText(['approachable', 'approach'])

    await entryRow(page, 'approach').click()
    await expect(
      page.getByRole('region', { name: '词条内容' }).getByText('已收集 4 条原句 · 来自 2 篇', {
        exact: false
      })
    ).toBeVisible()
  })

  test('回到原文定位并高亮该句，能回词条，点别处撤掉底色', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory, standardPicks)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntries(page)
    await entryRow(page, 'approach').click()

    const sentence = page
      .getByRole('region', { name: '词条内容' })
      .locator('.entry-sentence')
      .filter({ hasText: 'Employers approach hiring differently.' })
    await sentence.hover()
    await sentence.getByRole('button', { name: '回到原文' }).click()

    await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
    const context = page.locator('.reading-context')
    await expect(context).toContainText('来自词条 approach')
    const focused = page.locator('.reading-sentence-focused')
    await expect(focused).toHaveText('Employers approach hiring differently.')
    await expect(focused).toBeInViewport()

    // 点正文别处，底色撤掉；退回词条页再走一次「回词条」。
    await page.locator('.reading-bar-title').click()
    await expect(page.locator('.reading-sentence-focused')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()

    await entryRow(page, 'approach').click()
    await sentence.hover()
    await sentence.getByRole('button', { name: '回到原文' }).click()
    await page.getByRole('button', { name: '回词条', exact: true }).click()
    await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
    await expect(
      page.getByRole('region', { name: '词条内容' }).getByRole('heading', { name: 'approach', level: 2 })
    ).toBeVisible()
  })

  test('重新圈定只在原句那一句里换范围，换完词形与标记都跟着改', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory, [
      {
        entry: firstArticle,
        paragraphIndex: 0,
        needle: 'approach hiring',
        at: '2026-11-18T08:00:00.000Z'
      }
    ])
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntries(page)
    await entryRow(page, 'approach hiring').click()

    const sentence = page
      .getByRole('region', { name: '词条内容' })
      .locator('.entry-sentence')
      .first()
    await sentence.hover()
    await sentence.getByRole('button', { name: '重新圈定' }).click()

    await expect(page.locator('.reading-context-text')).toContainText(
      '重新圈定「approach hiring」· 在这一句里圈出正确范围'
    )

    // 换到别的句子不算，给出提示。
    await selectText(page, 1, 'Context')
    await expect(page.getByText('重新圈定只在原句所在的这一句里换范围。')).toBeVisible()
    await page.getByRole('button', { name: '回词条', exact: true }).click()

    await entryRow(page, 'approach hiring').click()
    await sentence.hover()
    await sentence.getByRole('button', { name: '重新圈定' }).click()
    await selectText(page, 0, 'approach')

    await expect(page.getByText('已重新圈定为「approach」。')).toBeVisible()
    await expect(page.locator('.reading-context-text')).toContainText('来自词条 approach')
    await page.getByRole('button', { name: '回词条', exact: true }).click()

    // 主词形跟着修正后的单词走，列表里也不再是那句短语。
    await entryRow(page, 'approach').click()
    await expect(
      page.getByRole('region', { name: '词条内容' }).locator('.entry-surface')
    ).toHaveText('approach')
  })

  test('删最后一条原句且没有学习内容时，提示不提「0 条学习内容」', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory, [{ entry: firstArticle, paragraphIndex: 0, needle: 'approach' }])
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntries(page)
    await entryRow(page, 'approach').click()

    const sentence = page.getByRole('region', { name: '词条内容' }).locator('.entry-sentence').first()
    await sentence.hover()
    await sentence.getByRole('button', { name: '删除' }).click()

    const dialog = page.getByRole('alertdialog', { name: '删除最后一条原句' })
    await expect(dialog).toContainText('这是最后一条原句。')
    await expect(dialog).toContainText('「approach」词条也会一起删除')
    await expect(dialog).not.toContainText('学习内容')
    await expect(dialog).not.toContainText('0 条')
  })

  test('删最后一条原句的慢回复：用户切到首页后不被拉回词条页', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory, [{ entry: firstArticle, paragraphIndex: 0, needle: 'approach' }])
    const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    if (electronApp === null) throw new Error('需要开发版 Electron 进程')
    await openEntries(page)
    await entryRow(page, 'approach').click()

    await electronApp.evaluate(({ ipcMain }, result) => {
      const flags = globalThis as { __deleteDone?: boolean; __deleteCalls?: number }
      flags.__deleteDone = false
      flags.__deleteCalls = 0
      ipcMain.removeHandler('entries:delete-sentence')
      ipcMain.handle('entries:delete-sentence', async () => {
        flags.__deleteCalls = (flags.__deleteCalls ?? 0) + 1
        await new Promise((resolve) => setTimeout(resolve, 700))
        flags.__deleteDone = true
        return result
      })
    }, {
      status: 'deleted',
      entryDeleted: true,
      entry: null,
      articleId: firstArticle.id,
      marks: []
    })

    const main = page.getByRole('region', { name: '词条内容' })
    const sentence = main.locator('.entry-sentence').first()
    await sentence.hover()
    await sentence.getByRole('button', { name: '删除' }).click()
    await page
      .getByRole('alertdialog', { name: '删除最后一条原句' })
      .getByRole('button', { name: '删除词条与原句' })
      .click()

    // 删除还没回来就切走：迟到的回复不能把用户从首页拉回词条页。
    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '首页' })
      .click()
    await expect(page.getByRole('heading', { name: '先读一篇' })).toBeVisible()
    await expect.poll(() =>
      electronApp.evaluate(() => Boolean((globalThis as { __deleteDone?: boolean }).__deleteDone))
    ).toBe(true)
    await page.waitForTimeout(200)
    await expect(page.getByRole('heading', { name: '先读一篇' })).toBeVisible()
    expect(await page.evaluate(() => window.location.hash)).not.toContain('#/entries')
    expect(
      await electronApp.evaluate(() => (globalThis as { __deleteCalls?: number }).__deleteCalls)
    ).toBe(1)
  })

  test('删最后一条原句的慢回复：用户切到另一词条后仍停在那一词条', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory, [
      { entry: firstArticle, paragraphIndex: 0, needle: 'approach' },
      { entry: firstArticle, paragraphIndex: 1, needle: 'Context' }
    ])
    const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    if (electronApp === null) throw new Error('需要开发版 Electron 进程')
    await openEntries(page)
    await entryRow(page, 'approach').click()

    await electronApp.evaluate(({ ipcMain }, result) => {
      const flags = globalThis as { __deleteDone?: boolean }
      flags.__deleteDone = false
      ipcMain.removeHandler('entries:delete-sentence')
      ipcMain.handle('entries:delete-sentence', async () => {
        await new Promise((resolve) => setTimeout(resolve, 700))
        flags.__deleteDone = true
        return result
      })
    }, {
      status: 'deleted',
      entryDeleted: true,
      entry: null,
      articleId: firstArticle.id,
      marks: []
    })

    const sentence = page.getByRole('region', { name: '词条内容' }).locator('.entry-sentence').first()
    await sentence.hover()
    await sentence.getByRole('button', { name: '删除' }).click()
    await page
      .getByRole('alertdialog', { name: '删除最后一条原句' })
      .getByRole('button', { name: '删除词条与原句' })
      .click()

    // 删除还没回来就切到另一词条：迟到的回复不能清空当前选择或拉回空页。
    await entryRow(page, 'Context').click()
    const heading = page
      .getByRole('region', { name: '词条内容' })
      .getByRole('heading', { level: 2 })
    await expect(heading).toHaveText('Context')
    await expect.poll(() =>
      electronApp.evaluate(() => Boolean((globalThis as { __deleteDone?: boolean }).__deleteDone))
    ).toBe(true)
    await page.waitForTimeout(200)
    await expect(heading).toHaveText('Context')
    await expect(page.getByText('在左边选一个词条。')).toHaveCount(0)
  })

  test('删最后一条原句先确认，删完词条与学习内容一起消失', async ({ launch, userDataDirectory }) => {
    seed(
      userDataDirectory,
      standardPicks,
      [{ entryMainForm: 'Context', body: '跟着词条一起删' }]
    )
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntries(page)
    await entryRow(page, 'Context').click()
    await page.getByRole('button', { name: '展开学习内容' }).click()
    await expect(page.locator('.entry-note-body')).toHaveText(['跟着词条一起删'])

    // 覆盖抽屉挡住原句列；先收起再删原句。
    await page.getByRole('button', { name: '收起学习内容' }).click()

    const main = page.getByRole('region', { name: '词条内容' })
    const sentence = main.locator('.entry-sentence').first()
    await sentence.hover()
    await sentence.getByRole('button', { name: '删除' }).click()

    const dialog = page.getByRole('alertdialog', { name: '删除最后一条原句' })
    await expect(dialog).toContainText('1 条学习内容也会一起删除')
    await dialog.getByRole('button', { name: '取消' }).click()
    await expect(main.locator('.entry-sentence')).toHaveCount(1)

    await sentence.hover()
    await sentence.getByRole('button', { name: '删除' }).click()
    await page.getByRole('alertdialog').getByRole('button', { name: '删除词条与原句' }).click()

    await expect(page.getByText('原句与「Context」已删除。')).toBeVisible()
    await expect(entryRow(page, 'Context')).toHaveCount(0)
    await expect(page.getByText('在左边选一个词条。')).toBeVisible()
  })
})
