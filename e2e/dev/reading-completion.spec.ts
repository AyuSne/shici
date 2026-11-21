import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'

/**
 * 已读完的三种进入路径：阅读页页脚、文章库详情、直接打开本篇选词地址。
 * 三条路都由主进程的 `reading:words` 写完成时间，界面只按返回的文章信息渲染；
 * 读完不撤销重读，也不把已读完的篇目继续端成「继续阅读」。
 */

const TITLE_ONE = '2026年6月 · 第1套 · 仔细阅读 Passage One'
const TITLE_TWO = '2026年6月 · 第1套 · 仔细阅读 Passage Two'
const TITLE_THREE = '2026年6月 · 第2套 · 长篇匹配'

const articleOne = fixtureArticle({
  id: 'fixture-completion-one',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE_ONE,
  sentences: [
    ['Employers approach hiring differently.', 'Context keeps the skill alive.'],
    ['A steady habit keeps the reading going.']
  ]
})

const articleTwo = fixtureArticle({
  id: 'fixture-completion-two',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE_TWO,
  sentences: [['Practice interviews keep nerves steady.'], ['Review begins with the sentence.']]
})

const articleThree = fixtureArticle({
  id: 'fixture-completion-three',
  year: 2026,
  month: 6,
  set: 2,
  kind: 'long_match',
  label: TITLE_THREE,
  sentences: [['Patience pays off in the long run.'], ['Reading widely repays the effort.']]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-completion-e2e-'))
  writeCorpusDirectory(corpusDirectory, [articleOne, articleTwo, articleThree])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

async function nav(page: Page, label: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: label, exact: true })
    .click()
}

async function selectArticle(page: Page, title: string): Promise<ReturnType<Page['locator']>> {
  if (title === TITLE_THREE) {
    const toggle = page.getByRole('button', { name: /第2套/ })
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
  }
  const row = page.locator('.library-row').filter({ hasText: title.split(' · ').at(-1) })
  await row.click()
  const detail = page.getByRole('complementary', { name: '文章详情' })
  await expect(detail.getByRole('heading', { name: title, level: 2 })).toBeVisible()
  return detail
}

async function openArticle(page: Page, title: string): Promise<void> {
  await nav(page, '文章库')
  const detail = await selectArticle(page, title)
  await detail.getByRole('button', { name: /继续阅读|重读/ }).click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible()
}

async function openWordsFromLibrary(page: Page, title: string): Promise<void> {
  await nav(page, '文章库')
  const detail = await selectArticle(page, title)
  await detail.getByRole('button', { name: '打开本篇选词' }).click()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
}

/** 本篇选词收起全局栏；从地址直接回文章库，验证的是完成状态而不是 #42 的返回栈。 */
async function toLibrary(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/library'
  })
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
}

async function readingFontSize(page: Page): Promise<string> {
  return page
    .locator('.reading')
    .evaluate((element) => getComputedStyle(element).getPropertyValue('--reading-font-size').trim())
}

test('从阅读页页脚进入本篇选词即已读完：文章库与首页一致，重读与刷新都不撤销', async ({
  launch
}) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, TITLE_ONE)

  // 本篇设置调到 22，读到末尾，记下页脚位置；这两项在读完与重读后都不该被改。
  await page.getByRole('button', { name: '阅读设置' }).click()
  await page
    .getByRole('group', { name: '字号' })
    .getByRole('button', { name: '22', exact: true })
    .click()
  await page.getByRole('button', { name: '阅读设置' }).click()
  await page.waitForTimeout(300)
  await page.locator('.reading-scroll').evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await page.waitForTimeout(800)
  const footer = (await page.locator('.reading-foot span').first().textContent()) ?? ''
  expect(footer).toMatch(/读到 第 \d+ 段 · 第 \d+ 句/)

  await page.getByRole('button', { name: '进入本篇选词' }).click()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  await expect(page.locator('.article-words-empty')).toBeVisible()

  // 回到文章库：列表与详情用同一句「已读完 · 100%」。
  await toLibrary(page)
  const row = page.locator('.library-row').filter({ hasText: TITLE_ONE.split(' · ').at(-1) })
  await expect(row.locator('.library-row-progress')).toHaveText('已读完 · 100%')
  const detail = page.getByRole('complementary', { name: '文章详情' })
  await expect(detail).toContainText('已读完 · 100%')
  await expect(detail.getByRole('button', { name: '重读' })).toBeVisible()

  // 首页不再把已读完的这篇当作「继续阅读」，只诚实说明读完了几篇。
  await nav(page, '首页')
  const finished = page.getByRole('region', { name: '已读完' })
  await expect(finished).toBeVisible()
  await expect(finished.locator('.eyebrow')).toHaveText('已读完 1 篇')
  await expect(finished.getByRole('heading', { name: '没有读到一半的文章了' })).toBeVisible()
  await expect(page.getByRole('region', { name: '继续阅读' })).toHaveCount(0)

  // 重读：从文章库「重读」回到原位置，字号仍是本篇的 22。
  await nav(page, '文章库')
  await selectArticle(page, TITLE_ONE)
  await detail.getByRole('button', { name: '重读' }).click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.locator('.reading-foot span').first()).toHaveText(footer)
  expect(await readingFontSize(page)).toBe('22px')

  // 刷新后位置与设置仍恢复，已读完没被重读与滚动撤销。
  await page.reload()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.locator('.reading-foot span').first()).toHaveText(footer)
  expect(await readingFontSize(page)).toBe('22px')
  await toLibrary(page)
  await expect(
    page.locator('.library-row').filter({ hasText: TITLE_ONE.split(' · ').at(-1) }).locator('.library-row-progress')
  ).toHaveText('已读完 · 100%')
})

test('从文章库「打开本篇选词」也标记已读完，没打开过的篇目仍是未读', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openWordsFromLibrary(page, TITLE_TWO)
  await expect(page.locator('.article-words-empty')).toBeVisible()
  await toLibrary(page)

  await expect(
    page.locator('.library-row').filter({ hasText: TITLE_TWO.split(' · ').at(-1) }).locator('.library-row-progress')
  ).toHaveText('已读完 · 100%')
  // 没打开过的别篇：没有完成，也不冒充已读完。
  await expect(
    page.locator('.library-row').filter({ hasText: TITLE_ONE.split(' · ').at(-1) }).locator('.library-row-progress')
  ).toHaveText('未读')

  await nav(page, '首页')
  const finished = page.getByRole('region', { name: '已读完' })
  await expect(finished.locator('.eyebrow')).toHaveText('已读完 1 篇')
  await expect(page.getByRole('region', { name: '继续阅读' })).toHaveCount(0)
})

test('直接打开本篇选词地址也标记已读完，并沿用 #41 的存在性检查', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.evaluate((id) => {
    window.location.hash = `#/reading/${id}/words`
  }, articleThree.id)

  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  await expect(page.locator('.article-words-empty')).toBeVisible()

  await toLibrary(page)
  const setTwo = page.getByRole('button', { name: /第2套/ })
  if (await setTwo.getAttribute('aria-expanded') === 'false') await setTwo.click()
  await expect(
    page.locator('.library-row').filter({ hasText: TITLE_THREE.split(' · ').at(-1) }).locator('.library-row-progress')
  ).toHaveText('已读完 · 100%')
})

test('本篇选词地址指向已不存在的文章时沿用 #41 的退路回到文章库', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.evaluate(() => {
    window.location.hash = '#/reading/no-such-article/words'
  })

  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await expect(page.getByText('这篇文章已经不在库里了。')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toMatch(/^#\/library\/.+$/)
})

test('继续阅读按最近未读完回退，阅读 tab 与首页用同一份选择，全部读完才给空态', async ({
  launch
}) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  // 依次打开三篇：最近打开的最后一篇是 TITLE_THREE，其次 TWO，最早 ONE。
  await openArticle(page, TITLE_ONE)
  await page.keyboard.press('Escape')
  await openArticle(page, TITLE_TWO)
  await page.keyboard.press('Escape')
  await openArticle(page, TITLE_THREE)
  await page.keyboard.press('Escape')

  // 读完最近打开的第三篇：继续阅读退回第二篇。
  await openWordsFromLibrary(page, TITLE_THREE)
  await toLibrary(page)
  await nav(page, '首页')
  const continueBlock = page.getByRole('region', { name: '继续阅读' })
  await expect(continueBlock.getByRole('heading', { level: 1 })).toHaveText(
    '仔细阅读 Passage Two'
  )

  // 全局「阅读」tab 走同一个 loadHomeSummary 的继续阅读，不另查一套。
  await nav(page, '阅读')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(
    `#/reading/${articleTwo.id}?from=home`
  )
  await expect(page.getByRole('heading', { name: TITLE_TWO, level: 1 })).toBeVisible()
  await page.keyboard.press('Escape')

  // 读完第二篇：继续阅读退回第一篇。
  await openWordsFromLibrary(page, TITLE_TWO)
  await toLibrary(page)
  await nav(page, '首页')
  await expect(
    page.getByRole('region', { name: '继续阅读' }).getByRole('heading', { level: 1 })
  ).toHaveText('仔细阅读 Passage One')

  // 读完最后一篇：文章库里三篇都给同一句已读完，首页只说自己读完的 3 篇。
  await openWordsFromLibrary(page, TITLE_ONE)
  await toLibrary(page)
  await expect(page.locator('.library-row-progress')).toHaveText([
    '已读完 · 100%',
    '已读完 · 100%',
    '已读完 · 100%'
  ])
  await nav(page, '首页')
  const finished = page.getByRole('region', { name: '已读完' })
  await expect(finished).toBeVisible()
  await expect(finished.locator('.eyebrow')).toHaveText('已读完 3 篇')
  await expect(finished.getByRole('heading', { name: '没有读到一半的文章了' })).toBeVisible()
  await expect(page.getByRole('region', { name: '继续阅读' })).toHaveCount(0)

  // 「阅读」tab 此时没有可续读的篇目：打开空阅读页，而不是把读完的最后一篇再端出来。
  await nav(page, '阅读')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/reading?from=home')
  await expect(page.getByRole('heading', { name: '先挑一篇' })).toBeVisible()
  await expect(page.getByRole('navigation', { name: '全局导航' })).toHaveCount(0)
})
