import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/database'
import { migrate } from '../../src/main/db/migrations'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { selectAnswerText } from '../fixtures/answer-selection'
import {
  expectReadableText,
  hexContrast,
  type ContrastSample
} from '../fixtures/contrast'
import { databasePath } from '../fixtures/database'
import { seedWordEntries } from '../fixtures/entries'
import { clickAway, selectText } from '../fixtures/reading'

/**
 * 深色验收：关键文字与状态不是靠肉眼说「能看见」，而是从真实渲染的
 * computed style 取色、逐层合成底色、按 WCAG 公式算比值，逐项断言 ≥4.5:1。
 */

const ANSWER = '第一段：approach 指接近。\n\n第二段：也可以指处理问题的方法。'

/** 加长到能滚动，首页「继续阅读」才有上次停下的句子。 */
function paragraph(lead: string): string {
  return `${lead} The passage keeps going so that the reading column really scrolls instead of sitting still on the first screen.`
}

const article = fixtureArticle({
  id: 'fixture-contrast-2026-06-s1-b',
  year: 2026,
  month: 6,
  set: 1,
  kind: 'long_match',
  sentences: [
    [paragraph('Readers approach a long passage with patience.'), paragraph('Patience and attention are what the reading habit is made of.')],
    [paragraph('Annotations sit beside the text in a quiet column.'), paragraph('A collected word shines amber on the page.')],
    [paragraph('The third paragraph keeps the page tall enough to scroll.'), paragraph('It also gives the reading position somewhere to go.')],
    [paragraph('A fourth paragraph follows without changing the layout.'), paragraph('The column stays six hundred and twenty pixels wide.')],
    [paragraph('The fifth paragraph is here for the same practical reason.'), paragraph('Reading position needs a few screens of text.')],
    [paragraph('The sixth paragraph adds more sentences to the page.'), paragraph('Nothing about the typography changes from one to the next.')],
    [paragraph('The seventh paragraph is nearly the last one.'), paragraph('The reading footer reports the position written back.')],
    [paragraph('The eighth paragraph closes the fixture article.'), paragraph('Every page keeps the same contrast rules.')]
  ],
  annotations: [{ surface: 'patience', gloss: '耐心', paragraph: 0, sentence: 0 }]
})

const articleTitle = '2026年6月 · 第1套 · 长篇匹配'

let corpusDirectory: string
const stubs: SseStub[] = []

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-contrast-corpus-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(text: readonly string[], thinking: readonly string[] = []): Promise<SseStub> {
  const stub = await startSseStub({ kind: 'stream', text, thinking })
  stubs.push(stub)
  return stub
}

/** 在启动前把主题写成深色，并从 fixture 语料建一本有词条的小库。 */
function seedDarkLibrary(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }],
    notes: [{ entryMainForm: 'approach', body: '先记下这个词的常见搭配。' }]
  })
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    migrate(database)
    database
      .prepare(
        `INSERT INTO setting (key, value) VALUES ('theme', 'dark')
         ON CONFLICT (key) DO UPDATE SET value = 'dark'`
      )
      .run()
  } finally {
    database.close()
  }
}

function environment(baseUrl: string): Record<string, string> {
  return {
    CORPUS_DIRECTORY: corpusDirectory,
    DEEPSEEK_BASE_URL: baseUrl,
    DEEPSEEK_API_KEY: 'e2e-contrast-key',
    DEEPSEEK_MODEL: 'deepseek-flash'
  }
}

async function nav(page: Page, label: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: label, exact: true })
    .click()
}

async function openArticle(page: Page): Promise<void> {
  await nav(page, '文章库')
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await page.locator('.library-row').first().click()
  await page
    .getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' })
    .click()
  await expect(page.getByRole('heading', { name: articleTitle, level: 1 })).toBeVisible()
}

const HOME_SAMPLES: ContrastSample[] = [
  { label: '首页大标题', selector: '.home-title' },
  { label: '首页说明', selector: '.home-lede' },
  { label: '区块小标签', selector: '.section-label' },
  { label: '空态小字', selector: '.empty-line' },
  { label: '文章库入口', selector: '.home-library' },
  { label: '主按钮', selector: '.button-primary' },
  { label: '当前导航项', selector: '.nav-item[aria-current="page"]' },
  { label: '普通导航项', selector: '.nav-item:not([aria-current])' },
  { label: '全局栏脚注', selector: '.nav-foot' }
]

const LIBRARY_SAMPLES: ContrastSample[] = [
  { label: '文章库计数', selector: '.library-count' },
  { label: '文章行篇名', selector: '.library-row-name' },
  { label: '文章行元信息', selector: '.library-row-meta' },
  { label: '文章行进度', selector: '.library-row-progress' },
  { label: '文章详情篇名', selector: '.library-detail-title' },
  { label: '详情字段名', selector: '.library-meta dt' },
  { label: '详情字段值', selector: '.library-meta dd' }
]

test.describe('收官验收 · 深色对比度', () => {
  test('首页、文章库、阅读、词条与设置的关键文字达到 4.5:1', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub(['答'])
    seedDarkLibrary(userDataDirectory)
    const { page } = await launch({ env: environment(stub.baseUrl) })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await expectReadableText(page, HOME_SAMPLES)

    await nav(page, '文章库')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await expect(page.locator('.library-detail-title')).toBeVisible()
    await expect(page.locator('.library-meta dt').first()).toBeVisible()
    await expect(page.locator('.library-meta dd').first()).toBeVisible()
    await expectReadableText(page, LIBRARY_SAMPLES)

    // 搜索结果里的命中高亮也是文字状态。
    await page.getByRole('searchbox', { name: '搜篇名或正文' }).fill('approach')
    await expect(page.locator('.library-snippet mark').first()).toBeVisible()
    await expectReadableText(page, [
      { label: '搜索命中行元信息', selector: '.library-row-search .library-row-meta' },
      { label: '搜索命中片段', selector: '.library-snippet' },
      { label: '搜索命中高亮', selector: '.library-snippet mark' }
    ])
    await page.getByRole('searchbox', { name: '搜篇名或正文' }).fill('')

    // 全局搜索结果的分组计数、命中类型与片段都是承载信息的文字，不能落到 --ink-3。
    await page.getByRole('button', { name: '全局搜索' }).click()
    const searchDialog = page.getByRole('dialog', { name: '全局搜索' })
    await expect(searchDialog).toBeVisible()
    await page.getByRole('searchbox', { name: '搜索词条与文章' }).fill('approach')
    await expect(page.locator('.global-search-group-count').first()).toBeVisible()
    await expectReadableText(page, [
      { label: '搜索分组计数', selector: '.global-search-group-count' },
      { label: '搜索命中类型', selector: '.global-search-hit-kind' },
      { label: '搜索片段', selector: '.global-search-snippet' },
      { label: '搜索命中高亮', selector: '.global-search-snippet mark' }
    ])
    await page.keyboard.press('Escape')
    await expect(searchDialog).toHaveCount(0)

    await openArticle(page)
    await expectReadableText(page, [
      { label: '阅读正文', selector: '.reading-paragraph' },
      { label: '段落字母', selector: '.reading-letter' },
      { label: '页边注', selector: '.reading-note' },
      { label: '页边注词形', selector: '.reading-note-word' },
      { label: '阅读顶栏篇名', selector: '.reading-bar-title' },
      { label: '阅读工具栏按钮', selector: '.reading-tool' }
    ])

    // 本次选中（麦底）与已收集（琥珀 + 下划线）两种词状态。
    await selectText(page, 0, 'approach')
    await expectReadableText(page, [{ label: '本次选中的词', selector: '.reading-selected' }])

    // 刚收下时的划词卡带只读词典，先等词典结果到齐再取样。
    const collectedPanel = page.getByRole('complementary', { name: '选词结果' })
    await expect(collectedPanel).toBeVisible()
    await expect(collectedPanel.locator('.dictionary-word')).toBeVisible()
    await expectReadableText(page, [
      { label: '选词卡词形', selector: '.reading-panel-word' },
      { label: '选词卡计数', selector: '.reading-panel-meta' },
      { label: '选词卡原句', selector: '.reading-panel-sentence' },
      { label: '词典词头', selector: '.dictionary-word' },
      { label: '词典音标', selector: '.dictionary-phonetic' },
      { label: '词典释义', selector: '.dictionary-sense-text' }
    ])

    await clickAway(page)
    await expectReadableText(page, [{ label: '已收集的词', selector: '.reading-collected' }])

    // 点已收集的词打开词条卡。
    await page.locator('.reading-collected').first().click()
    const panel = page.getByRole('complementary', { name: '词条' })
    await expect(panel).toBeVisible()
    await expectReadableText(page, [
      { label: '词条卡词形', selector: '.reading-panel-word' },
      { label: '词条卡计数', selector: '.reading-panel-meta' },
      { label: '词条卡原句', selector: '.reading-panel-sentence' },
      { label: '词条卡出处', selector: '.reading-panel-source' }
    ])
    await panel.getByRole('button', { name: '关闭' }).click()

    // 首页继续阅读：回到文章库再回首页，读到哪一句也要看得清。
    await page.locator('.reading-scroll').evaluate((element) => {
      element.scrollTop = 600
    })
    await page.waitForTimeout(900)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await nav(page, '首页')
    await expect(page.locator('.home-continue')).toBeVisible()
    await expectReadableText(page, [
      { label: '继续阅读标题', selector: '.home-continue .home-title' },
      { label: '继续阅读元信息', selector: '.home-meta' },
      { label: '上次停下的位置', selector: '.home-position' },
      { label: '上次停下的原句', selector: '.home-sentence' }
    ])

    // 词条页：原句与学习内容。
    await nav(page, '词条')
    await page.locator('.entries-row').first().click()
    await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
    await expectReadableText(page, [
      { label: '词条名', selector: '.entries-title' },
      { label: '词条计数', selector: '.entries-meta' },
      { label: '原句文字', selector: '.entry-sentence-text' },
      { label: '原句里的词形', selector: '.entry-surface' },
      { label: '原句出处', selector: '.entry-sentence-source' },
      { label: '文章分组名', selector: '.entry-group-head' }
    ])
    await page.getByRole('button', { name: /^学习内容/ }).click()
    await expect(page.locator('.entry-note-body')).toBeVisible()
    await expectReadableText(page, [
      { label: '学习内容正文', selector: '.entry-note-body' },
      { label: '右栏计数', selector: '.entries-rail-meta' },
      { label: '右栏说明', selector: '.entries-rail-title' }
    ])

    // 设置页：导航、说明、提示与空态。
    await nav(page, '设置')
    await expect(page.getByText('还没有模型提供商')).toBeVisible()
    await expectReadableText(page, [
      { label: '设置当前分区', selector: '.settings-nav-item[aria-current="location"]' },
      { label: '设置说明', selector: '.settings-desc' },
      { label: '空态说明', selector: '.settings-empty' }
    ])
    await page
      .getByRole('complementary', { name: '设置分区' })
      .getByRole('button', { name: '数据' })
      .click()
    await expect(page.getByRole('heading', { name: '数据' })).toBeVisible()
    await expectReadableText(page, [
      { label: '设置提示', selector: '.settings-hint' },
      { label: '数据行', selector: '.data-line' },
      { label: '数据卡片标题', selector: '.data-card-title' },
      { label: '数据路径', selector: '.data-path' }
    ])
  })

  test('对话、错误、钉住、来源回跳与设置报错的状态可辨', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub([ANSWER], ['先看语境。'])
    seedDarkLibrary(userDataDirectory)
    const { page } = await launch({ env: environment(stub.baseUrl) })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await nav(page, '对话')
    await expect(page.getByRole('heading', { name: '新的学习' })).toBeVisible()
    await page.getByRole('textbox', { name: '输入问题' }).fill('approach 怎么用？')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.locator('.assistant-text')).toContainText('approach 指接近')

    await expectReadableText(page, [
      { label: '线程标题', selector: '.chat-title' },
      { label: '线程副标题', selector: '.chat-subtitle' },
      { label: '用户提问', selector: '.chat-message-user' },
      { label: '助手标签', selector: '.assistant-label' },
      { label: '回答正文', selector: '.assistant-text' },
      { label: '思维链折叠行', selector: '.thinking-toggle' },
      { label: '输入框', selector: '.composer-input' },
      { label: '输入提示', selector: '.composer-hint' }
    ])

    // 展开的思维链正文也是灰字。
    await page.locator('.thinking-toggle').click()
    await expectReadableText(page, [{ label: '思维链正文', selector: '.thinking-body' }])

    // 钉住一段到词条：角标、钉板卡片两种状态。
    await selectAnswerText(page, 'approach 指接近')
    await page
      .locator('.pin-selection-card')
      .getByRole('button', { name: '钉住', exact: true })
      .click()
    const pinDialog = page.getByRole('dialog', { name: '钉到哪儿' })
    await pinDialog.getByRole('button', { name: '词条 · approach' }).click()
    await pinDialog.getByRole('button', { name: '钉住', exact: true }).click()
    await expect(page.locator('.pin-badge')).toContainText('已钉 · approach')
    await expectReadableText(page, [
      { label: '钉住角标', selector: '.pin-badge' },
      { label: '被钉段落底色上的正文', selector: '.assistant-text p.is-pinned' }
    ])

    await page.getByRole('button', { name: /^钉板 / }).click()
    await expect(page.locator('.pin-card')).toBeVisible()
    await expectReadableText(page, [
      { label: '钉板卡片摘录', selector: '.pin-card-excerpt' },
      { label: '钉板卡片出处', selector: '.pin-card-provenance' },
      { label: '钉板落点标签', selector: '.pin-card-target' },
      { label: '钉板卡片动作', selector: '.pin-card-action' },
      { label: '钉板页脚', selector: '.pin-board-foot-text' }
    ])
    await page.getByRole('button', { name: '关闭钉板' }).click()

    // 错误块：401 的标题、说明与下一步。
    stub.setScript({ kind: 'status', status: 401 })
    await page.getByRole('textbox', { name: '输入问题' }).fill('再问一次')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.locator('.message-error-title')).toContainText('密钥无效')
    await expectReadableText(page, [
      { label: '错误标题', selector: '.message-error-title' },
      { label: '错误说明', selector: '.message-error-detail' },
      { label: '错误下一步', selector: '.message-error-action' }
    ])

    // 来源回跳：学习内容来源行、对话顶部横条与被高亮段落。
    await nav(page, '词条')
    await page.locator('.entries-row').first().click()
    await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
    await page.getByRole('button', { name: /^学习内容/ }).click()
    await expect(
      page.locator('.entry-note-body').filter({ hasText: 'approach 指接近' })
    ).toBeVisible()
    await expectReadableText(page, [
      { label: '学习内容正文', selector: '.entry-note-body' },
      { label: '学习内容出处', selector: '.entry-note-source' },
      { label: '看原对话链接', selector: '.entry-source-link' }
    ])
    await page.getByRole('button', { name: '看原对话' }).click()
    await expect(page.locator('.pin-source-banner')).toBeVisible()
    await expectReadableText(page, [
      { label: '来源横条', selector: '.pin-source-banner' },
      { label: '来源提示', selector: '.pin-source-hint' },
      {
        label: '被回跳高亮段落里的正文',
        selector: '.assistant-text p.is-source-hit'
      }
    ])
  })

  test('深色 token 数值与两两对比度对照 token 表', async ({ launch }) => {
    const stub = await createStub(['答'])
    const { page } = await launch({ env: environment(stub.baseUrl) })

    // 先用 token 表里的既定数值做独立基准，不从 CSS 反推。
    const darkTokens = await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark'
      const style = getComputedStyle(document.documentElement)
      const names = [
        '--paper',
        '--panel',
        '--sunken',
        '--ink',
        '--ink-2',
        '--amber',
        '--amber-underline',
        '--blue',
        '--bed-select',
        '--bed-pin',
        '--danger',
        '--danger-bed'
      ]
      return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name).trim()]))
    })

    expect(darkTokens).toMatchObject({
      '--paper': '#1a1a1e',
      '--panel': '#22221f',
      '--sunken': '#141416',
      '--ink': '#e8e4da',
      '--ink-2': '#a8a29a',
      '--amber': '#d9a441',
      '--amber-underline': '#c9a15a',
      '--blue': '#7fa7e8',
      '--bed-select': '#4a3b1e',
      '--bed-pin': '#332a15',
      '--danger': '#e08a72',
      '--danger-bed': '#2e1f1a'
    })

    const pairs: Array<[string, string, string]> = [
      ['正文', '--ink', '--paper'],
      ['正文在卡片上', '--ink', '--panel'],
      ['正文在侧栏上', '--ink', '--sunken'],
      ['次级文字', '--ink-2', '--paper'],
      ['次级文字在卡片上', '--ink-2', '--panel'],
      ['次级文字在侧栏上', '--ink-2', '--sunken'],
      ['已收集的琥珀字', '--amber', '--paper'],
      ['已收集的琥珀字在卡片上', '--amber', '--panel'],
      ['钉住标签的琥珀字', '--amber', '--bed-pin'],
      ['已收集的虚线下划线', '--amber-underline', '--paper'],
      ['稍后看的蓝字', '--blue', '--paper'],
      ['稍后看的蓝字在卡片上', '--blue', '--panel'],
      ['危险标题', '--danger', '--paper'],
      ['危险标题在错误底色上', '--danger', '--danger-bed'],
      ['本次选中的正文', '--ink', '--bed-select'],
      ['钉住摘要的正文', '--ink', '--bed-pin']
    ]

    for (const [label, foreground, background] of pairs) {
      const ratio = hexContrast(darkTokens[foreground]!, darkTokens[background]!)
      expect(ratio, `${label}：${foreground} 在 ${background} 上只有 ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
    }

    // 不是纯黑，层次靠 --panel 提亮而不是把暗色一压到底。
    expect(darkTokens['--paper']).not.toBe('#000000')
    expect(hexContrast(darkTokens['--ink']!, darkTokens['--paper']!)).toBeGreaterThan(10)
  })
})
