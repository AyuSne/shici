import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test, type AppHandle } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'

/**
 * 收官验收：1100 / 1000 / 900 三个断点。
 * 用真实窗口的内容宽度（不是模拟 viewport）逐个宽度走一遍六个页面：
 * 页面不能横向溢出，断点该折的栏要折、该出现的入口要出现，正文列宽仍是 620。
 */

const article = fixtureArticle({
  id: 'fixture-layout-2026-06-s1-b',
  year: 2026,
  month: 6,
  set: 1,
  kind: 'long_match',
  sentences: [
    [
      'Readers approach the layout checks at every breakpoint width.',
      'The reading column stays six hundred and twenty pixels wide.'
    ],
    [
      'A second paragraph keeps the entry page populated with sentences.',
      'The narrow window still shows the actions as a compact icon row.'
    ],
    [
      'A third paragraph gives the reading page enough content to scroll.',
      'Every breakpoint keeps the same contrast and spacing rules.'
    ]
  ],
  annotations: [{ surface: 'breakpoint', gloss: '断点', paragraph: 0, sentence: 0 }]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-layout-corpus-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function environment(): Record<string, string> {
  return {
    CORPUS_DIRECTORY: corpusDirectory,
    DEEPSEEK_API_KEY: ''
  }
}

/** 用真实 BrowserWindow 的内容宽度：minWidth 若挡住 900，这里会先失败。 */
async function resizeTo(
  page: Page,
  electronApp: ElectronApplication | null,
  width: number
): Promise<number> {
  if (electronApp !== null) {
    const minimum = await electronApp.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (window === undefined) throw new Error('没有主窗口')
        const minimum = window.getMinimumSize()
        // 融合标题栏在部分 DPI 下仍留 1px 非客户区：多要 1px，量到的内容宽才是目标断点。
        window.setContentSize(size.width + 1, size.height)
        return minimum
      },
      { width, height: 820 }
    )
    // 融合标题栏后窗口没有系统边框：884 内容宽 ≈ 旧版 900 外框的可用正文宽。
    expect(minimum[0]).toBe(884)
  } else {
    await page.setViewportSize({ width, height: 820 })
  }
  // Windows 在 125% 等 DPI 缩放下会把内容宽度舍入 1–2px；先等真实窗口缩到目标附近。
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 5_000 })
    .toBeLessThanOrEqual(width + 2)
  // 让媒体查询与 React 布局按新宽度重排完再断言。
  await page.waitForTimeout(150)
  // innerWidth 是整数，DPI 缩放下媒体查询实际比较的视口宽度可能带小数。
  const actual = await page.evaluate(() => window.visualViewport?.width ?? window.innerWidth)
  expect(actual).toBeGreaterThanOrEqual(width - 1)
  expect(actual).toBeLessThanOrEqual(width + 2)
  return actual
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('.main, .reading')
    return {
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      main: main === null ? 0 : main.scrollWidth,
      mainClient: main === null ? 0 : main.clientWidth,
      inner: window.innerWidth
    }
  })
  expect(overflow.document, `页面横向溢出：${JSON.stringify(overflow)}`).toBeLessThanOrEqual(
    overflow.inner + 1
  )
  expect(overflow.body).toBeLessThanOrEqual(overflow.inner + 1)
  if (overflow.mainClient > 0) {
    expect(overflow.main).toBeLessThanOrEqual(overflow.mainClient + 1)
  }
}

async function gridTracks(page: Page, selector: string): Promise<string[]> {
  return page
    .locator(selector)
    .evaluate((element) =>
      getComputedStyle(element)
        .gridTemplateColumns.split(' ')
        .filter((track) => track !== '')
    )
}

async function nav(page: Page, label: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: label, exact: true })
    .click()
}

async function expectInsideViewport(page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox()
  const inner = await page.evaluate(() => window.innerWidth)
  expect(box, `${selector} 没有渲染`).not.toBeNull()
  expect(box!.x, `${selector} 左边超出窗口`).toBeGreaterThanOrEqual(-1)
  expect(box!.x + box!.width, `${selector} 右边超出窗口`).toBeLessThanOrEqual(inner + 1)
}

async function walkPages(handle: AppHandle, breakpoint: number): Promise<void> {
  const { page, electronApp } = handle
  // 阅读注释使用 max-width:999px；1000 处多预留 1px，避免小数宽度卡在线外。
  const actualWidth = await resizeTo(page, electronApp, breakpoint - (breakpoint === 1000 ? 3 : 2))
  expect(actualWidth).toBeGreaterThanOrEqual(breakpoint - 4)
  expect(actualWidth).toBeLessThanOrEqual(breakpoint)
  expect(await page.evaluate((width) => window.matchMedia(`(max-width: ${width}px)`).matches, breakpoint))
    .toBe(true)
  if (breakpoint === 1000) {
    expect(actualWidth).toBeLessThanOrEqual(999)
    expect(await page.evaluate(() => window.matchMedia('(max-width: 999px)').matches)).toBe(true)
  }

  // 首页。
  await expect(page.getByRole('heading', { name: '先读一篇' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  const globalBar = await page.locator('.globals').boundingBox()
  expect(Math.round(globalBar?.width ?? 0)).toBe(224)
  await expectInsideViewport(page, '.home-actions .button-primary')

  // 文章库：管理页在 1100 以下收成两栏（详情落到列表下面），不横向溢出。
  await nav(page, '文章库')
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await expect(page.locator('.library-detail')).toBeVisible()
  expect(await gridTracks(page, '.library-columns')).toHaveLength(1)
  await expectInsideViewport(page, '.library-row')

  // 阅读：620 列在任何断点都放得下；≤999 页边注改行内。
  await page.locator('.library-row').first().click()
  await page
    .getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' })
    .click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expectNoHorizontalOverflow(page)
  const paragraph = page.locator('.reading-paragraph').first()
  const paragraphBox = await paragraph.boundingBox()
  expect(Math.round(paragraphBox?.width ?? 0)).toBe(620)
  await expectInsideViewport(page, '.reading-bar-title')
  if (actualWidth <= 999) {
    await expect(page.locator('.reading-notes').first()).toBeHidden()
    const inlineGloss = await page
      .locator('.reading-annotated')
      .first()
      .evaluate((element) => getComputedStyle(element, '::after').content)
    expect(inlineGloss).toContain('断点')
  } else {
    await expect(page.locator('.reading-notes').first()).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()

  // 词条：收起时两栏，1100 以下点开右栏变抽屉；900 动作常驻、文字换成图标。
  await nav(page, '词条')
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await page.locator('.entries-row').first().click()
  await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await expect(page.locator('.entries-rail-closed')).toHaveCount(0)
  expect(await gridTracks(page, '.entries-page')).toHaveLength(2)
  await expectInsideViewport(page, '.entries-main-head .entries-main-actions')

  await page.getByRole('button', { name: /^词典与学习内容/ }).click()
  await expect(page.locator('.entries-rail-open')).toBeVisible()
  expect(
    await page.locator('.entries-rail-open').evaluate((element) => getComputedStyle(element).position)
  ).toBe('fixed')
  const rail = await page.locator('.entries-rail-open').boundingBox()
  expect(Math.round(rail?.width ?? 0)).toBe(320)
  const inner = await page.evaluate(() => window.innerWidth)
  expect(Math.round((rail?.x ?? 0) + (rail?.width ?? 0))).toBeLessThanOrEqual(inner + 1)
  await page.getByRole('button', { name: '收起词典与学习内容' }).click()

  if (actualWidth <= 900) {
    const opacity = await page
      .locator('.entry-sentence-actions')
      .first()
      .evaluate((element) => getComputedStyle(element).opacity)
    expect(Number(opacity)).toBe(1)
    await expect(page.locator('.entry-action-label').first()).toBeHidden()
  } else {
    await page.locator('.entry-sentence').first().hover()
    await expect(page.locator('.entry-action-label').first()).toBeVisible()
  }

  // 对话：900 以下线程栏改抽屉；宽屏也能一键折叠左栏给正文腾空间。
  await nav(page, '对话')
  await expect(page.getByRole('heading', { name: '新的学习' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  const toggle = page.getByRole('button', { name: '对话列表' })
  await expect(toggle).toBeVisible()
  if (actualWidth <= 900) {
    await expect(page.locator('.chat-rail')).toBeHidden()
    await toggle.click()
    await expect(page.locator('.chat-rail')).toBeVisible()
    const railBox = await page.locator('.chat-rail').boundingBox()
    expect(Math.round(railBox?.width ?? 0)).toBe(236)
    // 抽屉盖在全局栏上；测完收起来，后面的页面才点得到。
    await toggle.click()
    await expect(page.locator('.chat-rail')).toBeHidden()
  } else {
    await expect(page.locator('.chat-rail')).toBeVisible()
    const firstTrack = (await gridTracks(page, '.chat-page'))[0]
    expect(Math.round(Number.parseFloat(firstTrack ?? '0'))).toBe(236)
    await toggle.click()
    await expect(page.locator('.chat-page')).toHaveAttribute('data-rail-collapsed', 'true')
    await expect(page.locator('.chat-rail')).toBeHidden()
    await toggle.click()
    await expect(page.locator('.chat-rail')).toBeVisible()
  }
  await expectInsideViewport(page, '.composer-box')

  // 钉板抽屉在三个宽度都放得下，打开时不把正文挤出窗口。
  await page.getByRole('button', { name: /^钉板 / }).click()
  const board = page.locator('.pin-board-open')
  await expect(board).toBeVisible()
  const boardBox = await board.boundingBox()
  expect(Math.round(boardBox?.width ?? 0)).toBe(336)
  const viewport = await page.evaluate(() => window.innerWidth)
  expect(Math.round((boardBox?.x ?? 0) + (boardBox?.width ?? 0))).toBeLessThanOrEqual(
    viewport + 1
  )
  await page.getByRole('button', { name: '关闭钉板' }).click()
  await expect(page.locator('.pin-board-open')).toHaveCount(0)

  // 设置：1000 以下导航收窄到 168；900 以下改为顶部横排。
  await nav(page, '设置')
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  const tracks = await gridTracks(page, '.settings')
  if (actualWidth <= 900) {
    expect(tracks).toHaveLength(1)
    const direction = await page
      .locator('.settings-nav')
      .evaluate((element) => getComputedStyle(element).flexDirection)
    expect(direction).toBe('row')
  } else {
    expect(tracks).toHaveLength(2)
    expect(Math.round(Number.parseFloat(tracks[0] ?? '0'))).toBe(
      actualWidth <= 1000 ? 168 : 216
    )
  }
  await expectInsideViewport(page, '.settings-head')
}

test.describe('收官验收 · 断点', () => {
  for (const width of [1100, 1000, 900]) {
    test(`${width}px 断点上或紧邻下方的窗口六个页面不破版`, async ({ launch, userDataDirectory }) => {
      seedWordEntries(userDataDirectory, corpusDirectory, {
        picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
      })
      const handle = await launch({ env: environment() })
      await walkPages(handle, width)
    })
  }

  test('1101px 是断点上沿：文章库两栏、词条右栏按容器宽度改覆盖抽屉、对话线程栏常驻', async ({
    launch,
    userDataDirectory
  }) => {
    seedWordEntries(userDataDirectory, corpusDirectory, {
      picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
    })
    const handle = await launch({ env: environment() })
    const { page, electronApp } = handle
    const actualWidth = await resizeTo(page, electronApp, 1101)
    expect(actualWidth).toBeGreaterThan(1100)
    expect(await page.evaluate(() => window.matchMedia('(max-width: 1100px)').matches)).toBe(false)

    await nav(page, '文章库')
    await expect(page.locator('.library-detail')).toBeVisible()
    expect(await gridTracks(page, '.library-columns')).toHaveLength(2)
    await expectNoHorizontalOverflow(page)

    await nav(page, '词条')
    await page.locator('.entries-row').first().click()
    // 1101 的容器只有约 799：三栏预算不够，收起时两栏，打开是覆盖抽屉。
    expect(await gridTracks(page, '.entries-page')).toHaveLength(2)
    await expect(page.locator('.entries-page')).toHaveAttribute('data-layout', 'drawer')
    await page.getByRole('button', { name: /^词典与学习内容/ }).click()
    const rail = await page.locator('.entries-rail-open').boundingBox()
    expect(Math.round(rail?.width ?? 0)).toBe(320)
    expect(
      await page.locator('.entries-rail-open').evaluate((element) => getComputedStyle(element).position)
    ).toBe('fixed')
    const middle = await page.getByRole('region', { name: '词条内容' }).boundingBox()
    expect(middle?.width ?? 0).toBeGreaterThanOrEqual(419)
    await page.getByRole('button', { name: '收起词典与学习内容' }).click()
    await expectNoHorizontalOverflow(page)

    await nav(page, '对话')
    await expect(page.locator('.chat-rail')).toBeVisible()
    await expect(page.getByRole('button', { name: '对话列表' })).toBeVisible()
    expect(Math.round(Number.parseFloat((await gridTracks(page, '.chat-page'))[0] ?? '0'))).toBe(
      236
    )
    await page.getByRole('button', { name: '对话列表' }).click()
    await expect(page.locator('.chat-rail')).toBeHidden()
    await page.getByRole('button', { name: '对话列表' }).click()
    await expect(page.locator('.chat-rail')).toBeVisible()
    await expectNoHorizontalOverflow(page)

    await nav(page, '设置')
    const tracks = await gridTracks(page, '.settings')
    expect(tracks).toHaveLength(2)
    expect(Math.round(Number.parseFloat(tracks[0] ?? '0'))).toBe(216)
    await expectNoHorizontalOverflow(page)
  })
})
