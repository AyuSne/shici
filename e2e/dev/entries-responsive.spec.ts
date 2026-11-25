import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'

/**
 * 词条页的栏宽由真实可用容器宽度决定，不是窗口断点：
 * 全局栏 224、页面左右各 32 与栏间距都要算进去。1101–1280 的窗口里容器不够
 * 240 + 420 + 320 + 两处 24 的间距，右栏必须是覆盖抽屉；1440 的容器够了才内联。
 */
const article = fixtureArticle({
  id: 'fixture-responsive-2026-06-s1-a',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    [
      'Readers approach every responsive layout check with the same collected sentence.',
      'The middle column stays wide enough to read a whole line without vertical text.'
    ],
    [
      'A second paragraph keeps the approach entry populated with more than one sentence.',
      'Long enough wording makes a squeezed column obvious in a real window.'
    ],
    ['The approach rail decides between inline and overlay by the container width.', 'No fixed window breakpoint decides it alone.']
  ]
})

const picks: SeedPick[] = [
  {
    entry: article,
    paragraphIndex: 0,
    needle: 'Readers',
    at: new Date(Date.UTC(2026, 10, 18, 7, 50)).toISOString()
  },
  ...[0, 1, 2].map((paragraphIndex) => ({
    entry: article,
    paragraphIndex,
    needle: 'approach',
    at: new Date(Date.UTC(2026, 10, 18, 8, paragraphIndex * 5)).toISOString()
  }))
]

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-entries-responsive-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function resizeTo(
  page: Page,
  electronApp: ElectronApplication | null,
  width: number
): Promise<void> {
  if (electronApp !== null) {
    await electronApp.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (window === undefined) throw new Error('没有主窗口')
        window.setContentSize(size.width, size.height)
      },
      { width, height: 820 }
    )
  } else {
    await page.setViewportSize({ width, height: 820 })
  }
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 5_000 })
    .toBeLessThanOrEqual(width + 2)
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 5_000 })
    .toBeGreaterThanOrEqual(width - 1)
  // 等 ResizeObserver 按新容器宽度重排完再断言。
  await page.waitForTimeout(200)
}

async function openApproach(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' })
    .click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  const row = page.locator('.entries-row').filter({
    has: page.locator('.entries-row-name', { hasText: /^approach$/ })
  })
  await row.click()
  await expect(
    page.getByRole('region', { name: '词条内容' }).getByRole('heading', { name: 'approach', level: 2 })
  ).toBeVisible()
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => {
    const main = document.querySelector('main')
    return {
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
      inner: window.innerWidth,
      main: main === null ? 0 : main.scrollWidth,
      mainClient: main === null ? 0 : main.clientWidth
    }
  })
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(dimensions.inner + 1)
  expect(dimensions.body).toBeLessThanOrEqual(dimensions.inner + 1)
  expect(dimensions.main).toBeLessThanOrEqual(dimensions.mainClient + 1)
}

/** 中栏可读：够宽、标题一行不竖排、原句不是一字一行。 */
async function expectReadableMiddle(
  page: Page,
  label: string,
  headingName = 'approach'
): Promise<number> {
  const middle = page.getByRole('region', { name: '词条内容' })
  const box = await middle.boundingBox()
  expect(box, `${label}: 中栏没有渲染`).not.toBeNull()
  expect(box!.width, `${label}: 中栏宽 ${box!.width.toFixed(1)} 小于 420`).toBeGreaterThanOrEqual(419)

  const title = middle.getByRole('heading', { name: headingName, level: 2 })
  const titleBox = await title.boundingBox()
  expect(titleBox!.width, `${label}: 标题宽`).toBeGreaterThan(100)
  expect(titleBox!.height, `${label}: 标题折成多行/竖排`).toBeLessThanOrEqual(40)
  const writingMode = await title.evaluate((element) => getComputedStyle(element).writingMode)
  expect(writingMode, `${label}: 标题不应竖排`).toBe('horizontal-tb')

  const sentence = middle.locator('.entry-sentence-text').first()
  const sentenceBox = await sentence.boundingBox()
  expect(sentenceBox!.width, `${label}: 原句行宽`).toBeGreaterThan(280)
  expect(sentenceBox!.height, `${label}: 原句被压成逐词换行`).toBeLessThan(200)

  await expectNoHorizontalOverflow(page)
  return box!.width
}

async function containerState(
  page: Page
): Promise<{ width: number; layout: string | null; openTrackCount: number }> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.entries-page')
    if (root === null) throw new Error('没有词条页')
    return {
      width: root.clientWidth,
      layout: root.dataset.layout ?? null,
      openTrackCount: getComputedStyle(root).gridTemplateColumns.split(' ').filter(Boolean).length
    }
  })
}

async function openRail(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^词典与学习内容/ }).click()
  await expect(page.locator('.entries-rail-open')).toBeVisible()
}

for (const width of [1101, 1200, 1280]) {
  test(`${width}px 真实窗口：容器不够宽，右栏是覆盖抽屉，中栏保持可读`, async ({
    launch,
    userDataDirectory
  }) => {
    seedWordEntries(userDataDirectory, corpusDirectory, { picks })
    const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await resizeTo(page, electronApp, width)
    await openApproach(page)

    const closed = await containerState(page)
    expect(closed.layout, `${width}px 容器宽 ${closed.width} 不应内联`).toBe('drawer')
    expect(closed.width).toBeLessThan(1028)
    expect(closed.openTrackCount).toBe(2)
    const closedMiddle = await expectReadableMiddle(page, `${width}px 关闭右栏`)

    await openRail(page)
    const dialog = page.getByRole('dialog', { name: '词典与学习内容' })
    await expect(dialog).toBeVisible()

    // 覆盖层不挤压中栏：和收起时一样宽，且固定在窗口右侧之内。
    const openedMiddle = await expectReadableMiddle(page, `${width}px 打开右栏`)
    expect(openedMiddle).toBeGreaterThanOrEqual(Math.min(closedMiddle, 420) - 1)
    await expect(page.locator('.entries-rail-open')).toHaveCSS('position', 'fixed')
    const overlayBox = await page.locator('.entries-rail-open').boundingBox()
    expect(Math.round(overlayBox?.width ?? 0)).toBe(320)
    const viewportWidth = await page.evaluate(() => window.innerWidth)
    expect(Math.round((overlayBox?.x ?? 0) + (overlayBox?.width ?? 0))).toBeLessThanOrEqual(
      viewportWidth + 1
    )
    expect((await containerState(page)).openTrackCount).toBe(2)

    // 打开后焦点在明确标了名的关闭按钮上；Esc 能关，焦点回到打开它的按钮。
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''))
      .toBe('收起词典与学习内容')
    await page.keyboard.press('Escape')
    await expect(page.locator('.entries-rail-open')).toHaveCount(0)
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''))
      .toContain('词典与学习内容')
    await expectReadableMiddle(page, `${width}px Esc 关闭后`)

    // 再打开，用可见的关闭按钮收起。
    await openRail(page)
    const close = page.getByRole('button', { name: '收起词典与学习内容' })
    await expect(close).toBeVisible()
    await close.click()
    await expect(page.locator('.entries-rail-open')).toHaveCount(0)
    await expectReadableMiddle(page, `${width}px 按钮关闭后`)

    // 窄屏打开抽屉时如果地址切到另一个词条，抽屉顺手收起。
    await openRail(page)
    await page.evaluate(() => {
      const next = document.querySelectorAll<HTMLElement>('.entries-row')[1]
      const nextId = next?.dataset.entryRowId
      if (nextId) window.location.hash = `#/entries/${nextId}`
    })
    await expect(page.locator('.entries-rail-open')).toHaveCount(0)
  })
}

test('1440px 真实窗口：容器够宽才内联，切换词条保持展开且右栏不挤中栏', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await resizeTo(page, electronApp, 1101)
  await openApproach(page)
  await resizeTo(page, electronApp, 1440)

  const closed = await containerState(page)
  expect(closed.layout).toBe('inline')
  expect(closed.width).toBeGreaterThanOrEqual(1028)
  expect(closed.openTrackCount).toBe(2)
  await expectReadableMiddle(page, '1440px 关闭右栏')

  await openRail(page)
  const rail = page.locator('.entries-rail-open')
  await expect(rail).toHaveCSS('position', 'sticky')
  await expect(rail).toBeVisible()
  const railBox = await rail.boundingBox()
  expect(Math.round(railBox?.width ?? 0)).toBe(320)
  expect(await page.locator('.entries-rail-backdrop').count()).toBe(0)
  expect((await containerState(page)).openTrackCount).toBe(3)
  await expectReadableMiddle(page, '1440px 打开右栏')

  // 宽屏从 drawer 拉宽后用 ArrowDown 切换词条，右栏仍保持展开。
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('heading', { name: 'Readers', level: 2 })).toBeVisible()
  await expect(rail).toBeVisible()

  await expect(page.getByRole('button', { name: '收起词典与学习内容' })).toBeVisible()
  await page.getByRole('button', { name: '收起词典与学习内容' }).click()
  await expect(page.locator('.entries-rail-open')).toHaveCount(0)
  await expectReadableMiddle(page, '1440px 收起右栏', 'Readers')
})
