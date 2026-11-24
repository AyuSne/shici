import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { writeDictionaryFixture } from '../../src/testing/dictionary-fixture'
import { expect, test } from '../fixtures/app'
import { expectReadableText } from '../fixtures/contrast'
import { databasePath, writeSetting } from '../fixtures/database'
import { seedWordEntries } from '../fixtures/entries'
import { openArticle } from '../fixtures/reading'

/**
 * #82 验收宽度：900 / 1100 / 1280 × 浅色 / 深色，在真实 Electron 窗口里改内容尺寸后，
 * 打开轻问抽屉与读后工作台逐项采样：
 * - 抽屉不盖住融合标题栏与阅读顶栏；≥1050 时正文列不被压窄也不与抽屉相交；
 *   1100 收起页边眉批、1280 让眉批与正文都留在抽屉左侧；900 走覆盖层但有明确关闭按钮。
 * - 工作台卡片、打包条与展开后的词典/草稿没有横向溢出。
 * - 新 UI 的字（标题、提示、音标、首义、状态、按钮）实测对比度 ≥4.5:1。
 * - prefers-reduced-motion: reduce 下抽屉不播放入场动画。
 */

const WIDTHS = [900, 1100, 1280] as const
const TITLE = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-drawer-craft',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE,
  sentences: [
    ['Employers approach hiring differently.', 'Practice keeps the skill alive.'],
    ['Approaching a new desk takes patience.']
  ]
})

const dictionary = {
  entries: [
    {
      word: 'approach',
      phonetic: "ә'prәutʃ",
      translation: 'n. 方法, 途径\\nvt. 接近, 着手处理\\nvi. 靠近',
      exchange: 'p:approached/d:approached/i:approaching/3:approaches'
    },
    {
      word: 'hire',
      phonetic: "'haiә",
      translation: 'vt. 雇请, 出租\\nn. 租金',
      exchange: 'p:hired/d:hired/i:hiring/3:hires'
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
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-drawer-craft-corpus-'))
  writeCorpusDirectory(corpusDirectory, [article])
  dictionaryDirectory = await mkdtemp(join(tmpdir(), 'english-learning-drawer-craft-dict-'))
  writeDictionaryFixture(join(dictionaryDirectory, 'ecdict.db'), dictionary)
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  await rm(dictionaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function resizeWidth(
  app: ElectronApplication,
  page: Page,
  width: number
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, targetWidth) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window === undefined) throw new Error('主窗口不存在')
    // 融合标题栏在部分 DPI 下留 1px 非客户区：多要 1px 才是目标内容宽。
    window.setContentSize(targetWidth + 1, 900)
  }, width)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(width)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width + 2)
}

type Metrics = {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
  display: string
}

async function geometry(page: Page): Promise<{
  viewport: { width: number; height: number }
  drawer: Metrics
  bar: Metrics
  body: Metrics
  notes: Metrics | null
  scrollPaddingRight: string
  drawerWidth: string
}> {
  return page.evaluate(() => {
    const measure = (selector: string): Metrics | null => {
      const element = document.querySelector<HTMLElement>(selector)
      if (element === null) return null
      const box = element.getBoundingClientRect()
      return {
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        display: getComputedStyle(element).display
      }
    }
    const drawer = measure('.reading-drawer')
    if (drawer === null) throw new Error('抽屉不存在')
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      drawer,
      bar: measure('.reading-bar')!,
      body: measure('.reading-body')!,
      notes: measure('.reading-notes'),
      scrollPaddingRight: getComputedStyle(
        document.querySelector<HTMLElement>('.reading-scroll')!
      ).paddingRight,
      drawerWidth: getComputedStyle(document.querySelector<HTMLElement>('.reading-drawer')!)
        .width
    }
  })
}

async function expectNoHorizontalOverflow(page: Page, selectors: readonly string[]): Promise<void> {
  const viewport = await page.evaluate(() => window.innerWidth)
  for (const selector of selectors) {
    for (const element of await page.locator(selector).all()) {
      const metrics = await element.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return {
          left: box.left,
          right: box.right,
          client: node.clientWidth,
          scroll: node.scrollWidth,
          width: box.width
        }
      })
      expect(metrics.width, `${selector} 没有宽度`).toBeGreaterThan(0)
      expect(metrics.left, `${selector} 左边超出`).toBeGreaterThanOrEqual(-1)
      expect(metrics.right, `${selector} 右边超出`).toBeLessThanOrEqual(viewport + 1)
      expect(metrics.scroll, `${selector} 横向滚动`).toBeLessThanOrEqual(metrics.client + 1)
    }
  }
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(documentWidth).toBeLessThanOrEqual(viewport + 1)
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme === 'light' ? '浅色' : '深色'}下 900 / 1100 / 1280 三档：轻问抽屉与工作台无遮挡、文字 ≥4.5:1、减少动态时不动`, async ({
    launch,
    userDataDirectory
  }) => {
    test.setTimeout(240_000)
    seedWordEntries(userDataDirectory, corpusDirectory, {
      picks: [
        { entry: article, paragraphIndex: 0, needle: 'approach' },
        { entry: article, paragraphIndex: 0, needle: 'hiring' },
        { entry: article, paragraphIndex: 1, needle: 'Approaching' }
      ],
      notes: [{ entryMainForm: 'approach', body: 'approach 在这里是「接近」的意思。', pinned: true }]
    })
    writeSetting(databasePath(userDataDirectory), 'theme', theme)
    const handle = await launch({
      env: {
        CORPUS_DIRECTORY: corpusDirectory,
        DICTIONARY_DIRECTORY: dictionaryDirectory
      }
    })
    const { page, electronApp } = handle
    if (electronApp === null) throw new Error('验收宽度需要真实开发态窗口')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await openArticle(page, TITLE)

    for (const width of WIDTHS) {
      await resizeWidth(electronApp, page, width)

      // 减少动态：抽屉不得播放位移/淡入动画（#80 全局规则 + 本条 UI 自检）。
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.getByRole('button', { name: '问模型' }).click()
      await expect(page.locator('[data-question-drawer="true"]')).toBeVisible()
      const motion = await page.locator('.reading-drawer').evaluate((element) => {
        const style = getComputedStyle(element)
        return { name: style.animationName, duration: style.animationDuration }
      })
      expect(motion).toEqual({ name: 'none', duration: '0s' })
      await page.emulateMedia({ reducedMotion: 'no-preference' })

      const layout = await geometry(page)
      expect(layout.drawer.top, '抽屉盖住标题栏或阅读顶栏').toBeGreaterThanOrEqual(
        layout.bar.bottom - 1
      )
      expect(layout.drawer.left).toBeGreaterThanOrEqual(-1)
      expect(layout.drawer.right).toBeLessThanOrEqual(layout.viewport.width + 1)
      expect(layout.drawer.bottom).toBeLessThanOrEqual(layout.viewport.height + 1)
      await expect(page.locator('.reading-drawer').getByRole('button', { name: '收回轻问' })).toBeVisible()

      if (width >= 1050) {
        expect(layout.scrollPaddingRight).toBe('352px')
        expect(layout.body.right, `正文与抽屉相交（${width}）`).toBeLessThanOrEqual(
          layout.drawer.left + 1
        )
        expect(layout.body.width).toBeGreaterThanOrEqual(width === 1280 ? 820 : 620)
        if (width === 1280) {
          expect(layout.notes).not.toBeNull()
          expect(layout.notes?.display).not.toBe('none')
          expect(layout.notes?.right ?? 0).toBeLessThanOrEqual(layout.drawer.left + 1)
        } else {
          // 1100：抽屉优先；页边眉批临时收起，正文列仍是 620。
          expect(layout.notes?.display).toBe('none')
        }
      } else {
        // 900：覆盖层降级，但有明确关闭按钮，且不盖住顶栏与原生窗口控制区。
        expect(layout.scrollPaddingRight).toBe('0px')
        expect(Number.parseFloat(layout.drawerWidth)).toBeLessThanOrEqual(360)
        expect(layout.drawer.top).toBeGreaterThanOrEqual(34)
      }

      await expectReadableText(page, [
        { label: '轻问标题', selector: '.reading-drawer-title' },
        { label: '轻问上下文摘要', selector: '.reading-drawer-subtitle' },
        { label: '轻问输入', selector: '.reading-drawer-input' },
        { label: '轻问提示', selector: '.reading-drawer-hint' },
        { label: '在对话页展开', selector: '.reading-drawer-expand' }
      ])

      // 右侧同一时间只留一块：开词条卡会收回抽屉，不出现两层浮层叠在一起。
      await page.locator('.reading-collected').filter({ hasText: 'approach' }).first().click()
      await expect(page.getByRole('complementary', { name: '词条' })).toBeVisible()
      await expect(page.locator('[data-question-drawer="true"]')).toHaveCount(0)
      await page.getByRole('complementary', { name: '词条' }).getByRole('button', { name: '关闭' }).click()

      // 工作台：打包条、卡片与展开后的词典/草稿都留在视口内，按钮可点。
      await page.getByRole('button', { name: '查看本篇已拾词' }).click()
      await expect(page.locator('[data-article-words="true"]')).toBeVisible()
      await expectNoHorizontalOverflow(page, [
        '.article-words-sheet',
        '.article-words-pack',
        '.article-words-pack-hint',
        '.article-words-pack-button',
        '.article-words-entry',
        '.article-words-entry-link',
        '.article-words-entry-actions'
      ])
      await expect(page.getByRole('button', { name: '把本篇未整理的词打包问模型' })).toBeVisible()

      const firstCard = page.locator('.article-words-entry').first()
      await firstCard.locator('.article-words-entry-link').click()
      const draftButton = firstCard.getByRole('button', { name: '用这条起草' }).first()
      if (await draftButton.count()) {
        await draftButton.click()
        await expectNoHorizontalOverflow(page, [
          '.article-words-dictionary',
          '.article-words-draft',
          '.article-words-draft-actions'
        ])
      }
      await expectReadableText(page, [
        { label: '打包提示', selector: '.article-words-pack-hint' },
        { label: '词条音标', selector: '.article-words-entry-phonetic' },
        { label: '词条首义', selector: '.article-words-entry-sense' },
        { label: '学习内容状态', selector: '.article-words-entry-status' },
        { label: '词条卡按钮', selector: '.article-words-open-entry' },
        { label: '草稿提示', selector: '.article-words-draft-hint' }
      ])

      await page.getByRole('button', { name: '回到阅读' }).click()
      await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
    }
  })
}
