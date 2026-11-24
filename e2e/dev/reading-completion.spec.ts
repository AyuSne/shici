import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { failIpcReply } from '../fixtures/bridge'
import { seedWordEntries } from '../fixtures/entries'

/**
 * 读完状态与「本篇选词」的入口是两件事：
 * 顶栏「查看本篇已拾词」、文章库详情「打开本篇选词」与直接打开地址都只读，
 * 只有阅读页底部显式「读完并整理本篇选词」才写完成时间；写失败就留在阅读页报错，
 * 不拿乐观的 100% 冒充已读完。已读完可以用「取消已读完」收回，且保留阅读位置、
 * 本篇设置与已收词条；收回是幂等的。
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
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
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

/** 阅读顶栏的「查看本篇已拾词」是纯查看，不写完成时间。 */
async function openWordsFromTopbar(page: Page): Promise<void> {
  await page.getByRole('button', { name: '查看本篇已拾词' }).click()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
}

/** 阅读页底部唯一的显式完成动作：成功后才进本篇选词。 */
async function finishReading(page: Page): Promise<void> {
  await page.getByRole('button', { name: '读完并整理本篇选词' }).click()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
}

/** 本篇选词收起全局栏；从地址直接回文章库，验证的是完成状态而不是返回栈。 */
async function toLibrary(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/library'
  })
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
}

function libraryRow(page: Page, title: string) {
  return page.locator('.library-row').filter({ hasText: title.split(' · ').at(-1) })
}

async function readingFontSize(page: Page): Promise<string> {
  return page
    .locator('.reading')
    .evaluate((element) => getComputedStyle(element).getPropertyValue('--reading-font-size').trim())
}

test('顶部查看、文章库入口与直接地址都只读：没点底部读完就仍是读到一半', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: articleOne, paragraphIndex: 0, needle: 'approach' }]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, TITLE_ONE)

  await openWordsFromTopbar(page)
  await expect(page.locator('.article-words-summary')).toHaveText('1 个词条 · 1 条原句')
  await toLibrary(page)
  await expect(libraryRow(page, TITLE_ONE).locator('.library-row-progress')).toHaveText(/读到 \d+%/)

  // 文章库详情的入口同样只是读：进去再回来看进度，仍未读完。
  await openWordsFromLibrary(page, TITLE_ONE)
  await toLibrary(page)
  await expect(libraryRow(page, TITLE_ONE).locator('.library-row-progress')).toHaveText(/读到 \d+%/)

  // 直接打开本篇选词地址也只看，不写完成。
  await page.evaluate((id) => {
    window.location.hash = `#/reading/${id}/words`
  }, articleOne.id)
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  await toLibrary(page)
  const progress = libraryRow(page, TITLE_ONE).locator('.library-row-progress')
  await expect(progress).toHaveText(/读到 \d+%/)
  await expect(progress).not.toContainText('已读完')

  await nav(page, '首页')
  await expect(page.getByRole('region', { name: '已读完' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: '继续阅读' })).toBeVisible()
})

test('底部「读完并整理本篇选词」才写完成：文章库、首页一致；重读、刷新与取消都不丢位置', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: articleOne, paragraphIndex: 0, needle: 'approach' },
      { entry: articleOne, paragraphIndex: 1, needle: 'habit' }
    ]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, TITLE_ONE)

  // 本篇设置调到 22，读到末尾，记下页脚位置；读完与收回都不该改这两项。
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

  await finishReading(page)
  await expect(page.locator('.article-words-summary')).toHaveText('2 个词条 · 2 条原句')
  await expect(page.locator('.article-words-completed')).toHaveText('已读完')

  // 回到文章库：列表与详情用同一句「已读完 · 100%」。
  await toLibrary(page)
  await expect(libraryRow(page, TITLE_ONE).locator('.library-row-progress')).toHaveText(
    '已读完 · 100%'
  )
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

  // 收起已读完：回到真实进度，位置、设置与已收词条都保留。
  await openWordsFromTopbar(page)
  await page.getByRole('button', { name: '取消已读完' }).click()
  await expect(page.locator('.article-words-completed')).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText('已收回')
  await expect(page.locator('.article-words-summary')).toHaveText('2 个词条 · 2 条原句')

  // 刷新后仍是收回后的状态，不会被挂载副作用再写回去。
  await page.reload()
  await expect(page.locator('[data-article-words="true"]')).toBeVisible()
  await expect(page.locator('.article-words-completed')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '取消已读完' })).toHaveCount(0)

  await toLibrary(page)
  const reverted = libraryRow(page, TITLE_ONE).locator('.library-row-progress')
  await expect(reverted).toHaveText(/读到 \d+%/)
  await expect(reverted).not.toContainText('已读完')

  // 回阅读页：位置与字号仍是原来的，已收词条也还在。
  await nav(page, '文章库')
  await selectArticle(page, TITLE_ONE)
  await detail.getByRole('button', { name: /继续阅读|重读/ }).click()
  await expect(page.locator('.reading-foot span').first()).toHaveText(footer)
  expect(await readingFontSize(page)).toBe('22px')
  await page.getByRole('button', { name: '查看本篇已拾词' }).click()
  await expect(page.locator('.article-words-summary')).toHaveText('2 个词条 · 2 条原句')

  // 收回不是不可逆：回到阅读页再次显式读完，文章库重新变成已读完。
  await page.getByRole('button', { name: '回到阅读' }).click()
  await finishReading(page)
  await toLibrary(page)
  await expect(libraryRow(page, TITLE_ONE).locator('.library-row-progress')).toHaveText(
    '已读完 · 100%'
  )

  // 幂等交给服务单测；界面在有标记时提供回收入口。
  await openArticle(page, TITLE_ONE)
  await openWordsFromTopbar(page)
  await expect(page.getByRole('button', { name: '取消已读完' })).toHaveCount(1)
})

test('读完命令失败：留在阅读页、就地报错，绝不乐观标记 100%', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: articleOne, paragraphIndex: 0, needle: 'approach' }]
  })
  const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  if (electronApp === null) throw new Error('开发态用例需要 Electron 句柄')
  await openArticle(page, TITLE_ONE)
  await failIpcReply(electronApp, 'reading:complete', '模拟完成命令失败')

  await page.getByRole('button', { name: '读完并整理本篇选词' }).click()

  // 没有跳去本篇选词；错误就地可见，还可以再试。
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.locator('[data-article-words="true"]')).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('没有把这篇标记成已读完')
  await expect(page.getByRole('button', { name: '读完并整理本篇选词' })).toBeEnabled()

  await toLibrary(page)
  const progress = libraryRow(page, TITLE_ONE).locator('.library-row-progress')
  await expect(progress).toHaveText(/读到 \d+%/)
  await expect(progress).not.toContainText('已读完')
  await nav(page, '首页')
  await expect(page.getByRole('region', { name: '已读完' })).toHaveCount(0)
})

test('继续阅读按最近未读完回退，阅读 tab 与首页用同一份选择，全部读完才给空态', async ({
  launch
}) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  // 依次打开三篇，让「最近打开」的次序固定为 THREE > TWO > ONE。
  await openArticle(page, TITLE_ONE)
  await page.keyboard.press('Escape')
  await openArticle(page, TITLE_TWO)
  await page.keyboard.press('Escape')
  await openArticle(page, TITLE_THREE)
  await page.keyboard.press('Escape')

  // 读完最近打开的第三篇：继续阅读退回第二篇。
  await openArticle(page, TITLE_THREE)
  await finishReading(page)
  await toLibrary(page)
  await nav(page, '首页')
  await expect(
    page.getByRole('region', { name: '继续阅读' }).getByRole('heading', { level: 1 })
  ).toHaveText('仔细阅读 Passage Two')

  // 全局「阅读」tab 走同一个 loadHomeSummary 的继续阅读，不另查一套。
  await nav(page, '阅读')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(
    `#/reading/${articleTwo.id}?from=home`
  )
  await expect(page.getByRole('heading', { name: TITLE_TWO, level: 1 })).toBeVisible()
  await page.keyboard.press('Escape')

  // 读完第二篇：继续阅读退回第一篇。
  await openArticle(page, TITLE_TWO)
  await finishReading(page)
  await toLibrary(page)
  await nav(page, '首页')
  await expect(
    page.getByRole('region', { name: '继续阅读' }).getByRole('heading', { level: 1 })
  ).toHaveText('仔细阅读 Passage One')

  // 读完最后一篇：文章库里三篇都给同一句已读完，首页只说自己读完的 3 篇。
  await openArticle(page, TITLE_ONE)
  await finishReading(page)
  await toLibrary(page)
  const rows = page.locator('.library-row-progress')
  await expect(rows).toHaveText(['已读完 · 100%', '已读完 · 100%', '已读完 · 100%'])
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

test('本篇选词地址指向已不存在的文章时沿用 #41 的退路回到文章库', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.evaluate(() => {
    window.location.hash = '#/reading/no-such-article/words'
  })

  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await expect(page.getByText('这篇文章已经不在库里了。')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/library\/.+$/)
})
