import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'

/**
 * #80 质感底座：统一 1.5px currentColor 线框图标、6px 暖色细滚动条
 * （词条页不再双滚动条并排）、主按钮悬停与按压反馈。
 */

const article = fixtureArticle({
  id: 'fixture-shell-craft-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Context keeps the skill alive.'],
    ['A second paragraph keeps the entry page populated.'],
    ['A third paragraph gives the page enough height.']
  ]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-shell-craft-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function nav(page: import('@playwright/test').Page) {
  return page.getByRole('navigation', { name: '全局导航' })
}

test('全局栏与阅读工具栏使用同一套 1.5px currentColor 线框图标', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })

  const navIcons = page.locator('.globals .icon')
  await expect(navIcons).toHaveCount(8)
  const navMetrics = await navIcons.evaluateAll((icons) =>
    icons.map((icon) => {
      const style = getComputedStyle(icon)
      return {
        strokeWidth: style.strokeWidth,
        stroke: style.stroke,
        color: style.color
      }
    })
  )
  for (const metric of navMetrics) {
    expect(metric.strokeWidth).toBe('1.5px')
    expect(metric.stroke).toBe(metric.color)
  }

  await nav(page).getByRole('button', { name: '文章库' }).click()
  await page.locator('.library-row').first().click()
  await page
    .getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' })
    .click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()

  const toolIcons = page.locator('.reading-bar-actions .icon')
  // 阅读顶栏：搜索 / 问模型 / 注释 / 阅读设置；「新开一条」已收归对话页内部。
  await expect(toolIcons).toHaveCount(4)
  const toolMetrics = await toolIcons.evaluateAll((icons) =>
    icons.map((icon) => getComputedStyle(icon).strokeWidth)
  )
  expect(toolMetrics).toEqual(['1.5px', '1.5px', '1.5px', '1.5px'])
})

test('全局滚动条是 6px 级别的暖色细条，词条页不再并排两条滚动条', async ({
  launch,
  userDataDirectory
}) => {
  const words = [
    'Employers',
    'approach',
    'hiring',
    'differently',
    'Context',
    'keeps',
    'skill',
    'alive',
    'second',
    'paragraph',
    'entry',
    'page',
    'populated',
    'third',
    'gives',
    'enough',
    'height'
  ]
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: words.map((needle, index) => ({
      entry: article,
      paragraphIndex: index < 8 ? 0 : index < 13 ? 1 : 2,
      needle
    }))
  })
  const handle = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const { page, electronApp } = handle
  if (electronApp === null) throw new Error('需要开发版 Electron 进程')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window === undefined) throw new Error('没有主窗口')
    window.setContentSize(1000, 640)
  })
  await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThanOrEqual(642)

  const scrollbar = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    return { width: style.scrollbarWidth, color: style.scrollbarColor }
  })
  expect(scrollbar.width).toBe('thin')
  expect(scrollbar.color).not.toBe('auto')

  await nav(page).getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'Employers' }).click()
  await expect(page.getByRole('heading', { name: 'Employers', level: 2 })).toBeVisible()

  const scrollbars = await page.evaluate(() => {
    const rows = document.querySelector<HTMLElement>('.entries-rows')
    const main = document.querySelector<HTMLElement>('main')
    if (rows === null || main === null) return null
    return {
      rowsVisible: getComputedStyle(rows).scrollbarWidth,
      rowsScrollable: rows.scrollHeight > rows.clientHeight + 1,
      mainVisible: getComputedStyle(main).scrollbarWidth,
      mainScrollable: main.scrollHeight > main.clientHeight + 1
    }
  })
  // 左栏仍可独立滚动（位置会被记住），但它的滚动条藏起来：
  // 页面上只看见 <main> 这一条细滚动条，不再两条并排。
  expect(scrollbars).not.toBeNull()
  expect(scrollbars!.rowsScrollable).toBe(true)
  expect(scrollbars!.rowsVisible).toBe('none')
  expect(scrollbars!.mainScrollable).toBe(true)
  expect(scrollbars!.mainVisible).toBe('thin')
})

test('主按钮悬停与按压都有清晰反馈，不缩放不弹跳', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const button = page.locator('.home-actions .button-primary').first()
  await expect(button).toBeVisible()

  const read = () =>
    button.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        background: style.backgroundColor,
        transform: style.transform
      }
    })

  const normal = await read()
  await button.hover()
  await expect.poll(async () => (await read()).background).not.toBe(normal.background)
  const hovered = await read()

  const box = await button.boundingBox()
  if (box === null) throw new Error('按钮没有尺寸')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect.poll(async () => (await read()).background).not.toBe(hovered.background)
  const pressed = await read()
  await page.mouse.up()

  expect(pressed.background).not.toBe(normal.background)
  // 按压只允许 1px 下沉，不做缩放。
  expect(pressed.transform === 'none' || /matrix\(1, 0, 0, 1, 0, 1\)/.test(pressed.transform)).toBe(
    true
  )
})
