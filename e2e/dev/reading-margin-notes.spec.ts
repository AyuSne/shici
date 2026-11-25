import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'
import { openArticle } from '../fixtures/reading'

/**
 * 宽屏页边眉批：原卷注释用普通细线，「我的拾词」的置顶学习内容用琥珀竖线；
 * 三态（全部 / 仅我的拾词 / 隐藏）只写 setting，窄窗口自动退回行内注释。
 */

const articleTitle = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-margin-notes',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    [
      'Readers approach a long passage with patience.',
      'Annotations sit beside the text in a quiet column.'
    ],
    ['A collected word shines amber on the page.']
  ],
  annotations: [
    { surface: 'patience', gloss: '耐心', paragraph: 0, sentence: 0 },
    { surface: 'column', gloss: '专栏', paragraph: 0, sentence: 1 }
  ]
})

const pinnedBody = 'approach 常考「着手处理」，不是单纯的「接近」。'

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-margin-notes-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function seed(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }],
    notes: [{ entryMainForm: 'approach', body: pinnedBody, pinned: true }]
  })
}

async function openSettingsPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: '阅读设置' }).click()
  await expect(page.getByRole('region', { name: '阅读设置' })).toBeVisible()
}

test.describe('宽屏页边眉批', () => {
  test('全部：原卷注释细线与本段已拾词的置顶内容琥珀竖线共存', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    const notes = page.locator('.reading-notes').first()
    await expect(notes).toBeVisible()
    await expect(notes.locator('.reading-note')).toHaveCount(3)
    const original = notes.locator('.reading-note').filter({ hasText: '耐心' })
    await expect(original).toHaveCSS('border-left-width', '0px')

    const pinned = notes.locator('.reading-note-pinned')
    await expect(pinned).toHaveCount(1)
    await expect(pinned).toContainText('approach')
    await expect(pinned).toContainText(pinnedBody)
    const border = await pinned.evaluate((element) => ({
      width: Number.parseFloat(getComputedStyle(element).borderLeftWidth),
      color: getComputedStyle(element).borderLeftColor
    }))
    // 设备像素比会把 3px 折成 2.4px 这类值；只断言它确实是一条可见的琥珀竖线。
    expect(border.width).toBeGreaterThan(2)
    expect(border.color).toBe('rgb(143, 90, 26)')

    // 正文列仍是 620，眉批只占页边。
    const paragraph = page.locator('.reading-paragraph').first()
    expect(Math.round((await paragraph.boundingBox())?.width ?? 0)).toBe(620)
  })

  test('仅我的拾词只留置顶眉批，隐藏后页边栏整条收起；选择重开仍在', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    await openSettingsPanel(page)
    const modeGroup = page.getByRole('group', { name: '页边眉批' })
    await modeGroup.getByRole('button', { name: '仅我的拾词' }).click()
    await page.keyboard.press('Escape')

    await expect(page.locator('.reading-note:not(.reading-note-pinned)')).toHaveCount(0)
    await expect(page.locator('.reading-note-pinned')).toHaveCount(1)

    // 离开再重开这一篇：全局偏好从本机库读回，不用再点一次。
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await openArticle(page, articleTitle)
    await expect(page.locator('.reading-note:not(.reading-note-pinned)')).toHaveCount(0)
    await expect(page.locator('.reading-note-pinned')).toHaveCount(1)

    await openSettingsPanel(page)
    await page.getByRole('group', { name: '页边眉批' }).getByRole('button', { name: '隐藏' }).click()
    await expect(
      page.getByRole('group', { name: '页边眉批' }).getByRole('button', { name: '隐藏' })
    ).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('Escape')

    await expect(page.locator('.reading-notes')).toHaveCount(0)
    await expect(page.locator('.reading')).toHaveAttribute('data-margin-notes', 'false')
    expect(
      Math.round((await page.locator('.reading-paragraph').first().boundingBox())?.width ?? 0)
    ).toBe(620)
  })

  test('窄窗口自动降级为行内注释，不挤占正文列', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    await page.setViewportSize({ width: 960, height: 800 })

    await expect(page.locator('.reading-notes').first()).toBeHidden()
    const gloss = await page
      .locator('.reading-annotated')
      .first()
      .evaluate((element) => getComputedStyle(element, '::after').content)
    expect(gloss).toContain('耐心')
    expect(
      Math.round((await page.locator('.reading-paragraph').first().boundingBox())?.width ?? 0)
    ).toBe(620)
  })

  test('宽屏浮卡不与眉批重叠；窗口不够宽时眉批降级而正文仍为 620', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    if (electronApp === null) throw new Error('需要开发版 Electron 进程')
    await openArticle(page, articleTitle)

    await page.locator('.reading-collected').filter({ hasText: 'approach' }).first().click()
    const card = page.getByRole('complementary', { name: '词条' })
    await expect(card).toBeVisible()

    const notesBox = await page.locator('.reading-notes').first().boundingBox()
    const cardBox = await card.boundingBox()
    expect((notesBox?.x ?? 0) + (notesBox?.width ?? 0)).toBeLessThanOrEqual((cardBox?.x ?? 0) + 1)

    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('没有主窗口')
      // 部分 DPI 下融合标题栏留 1px 非客户区；多要 1px 才是 1100 内容宽。
      window.setContentSize(1101, 820)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(1100)

    await expect(page.locator('.reading-notes')).toBeHidden()
    await expect(card).toBeVisible()
    expect(
      Math.round((await page.locator('.reading-paragraph').first().boundingBox())?.width ?? 0)
    ).toBe(620)
  })
})
