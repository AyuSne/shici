import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { clickAway, openArticle, selectText } from '../fixtures/reading'

/**
 * 收词反馈与撤销：正文落墨、顶部 5 秒撤销、Ctrl+Z，以及计数即时回退。
 * 只验收真实交互；落墨时长从 computed style 读，不从 CSS 文本反推。
 */

const articleTitle = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-collect-undo',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.'],
    ['Practice keeps the skill alive over time.']
  ]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-collect-undo-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test.describe('收词反馈与撤销', () => {
  test('新收下的词在正文落墨 260ms', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    await selectText(page, 0, 'approach')

    const inked = page.locator('.reading-selected[data-ink="true"]')
    await expect(inked).toHaveText(['approach'])
    const duration = await inked.evaluate(
      (element) => getComputedStyle(element).animationDuration
    )
    expect(duration).toBe('0.26s')
  })

  test('新收下的词给可撤销轻提示，撤销后高亮与导航计数一起回退', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    await selectText(page, 0, 'approach')
    const panel = page.getByRole('complementary', { name: '选词结果' })
    await expect(panel).toBeVisible()
    await clickAway(page)
    await expect(page.locator('.reading-collected')).toHaveText(['approach'])

    await expect(page.locator('.toast')).toContainText('已拾下「approach」')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await expect(page.locator('[data-nav-count="entries"]')).toHaveText('1')

    await page.locator('.toast').getByRole('button', { name: '撤销' }).click()

    await expect(page.locator('.toast')).toHaveCount(0)
    await expect(page.locator('[data-nav-count="entries"]')).toHaveText('0')

    // 正文里的高亮也回退了：重新打开这一篇，收词标记不再出现。
    await openArticle(page, articleTitle)
    await expect(page.locator('.reading-collected')).toHaveCount(0)

    // 撤销后可以照常重新收下，不是把词条封死。
    await selectText(page, 0, 'approach')
    await expect(page.getByRole('complementary', { name: '选词结果' })).toBeVisible()
  })

  test('Ctrl+Z 撤销最近一次收词，提示与正文一起收起', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    await selectText(page, 0, 'approach')
    await clickAway(page)
    await expect(page.locator('.toast')).toContainText('已拾下「approach」')

    await page.keyboard.press('Control+z')

    await expect(page.locator('.toast')).toHaveCount(0)
    await expect(page.locator('.reading-collected')).toHaveCount(0)

    await selectText(page, 0, 'approach')
    await expect(page.getByRole('complementary', { name: '选词结果' })).toBeVisible()
  })

  test('重复圈已收集的词不提供撤销，也不删掉已有的原句', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    await selectText(page, 0, 'approach')
    await clickAway(page)
    await selectText(page, 0, 'approach')

    const panel = page.getByRole('complementary', { name: '选词结果' })
    await expect(panel.getByText('这条原句已经收过')).toBeVisible()
    await expect(page.locator('.toast')).toContainText('这条原句已经收过')
    await expect(page.locator('.toast').getByRole('button', { name: '撤销' })).toHaveCount(0)

    await clickAway(page)
    await page.keyboard.press('Control+z')
    await expect(page.locator('.reading-collected')).toHaveText(['approach'])

    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await expect(page.locator('[data-nav-count="entries"]')).toHaveText('1')
  })
})
