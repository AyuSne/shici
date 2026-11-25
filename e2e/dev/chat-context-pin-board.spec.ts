import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/database'
import { createPin } from '../../src/main/pins/pins'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedAnsweredThread } from '../fixtures/chat'
import { databasePath } from '../fixtures/database'
import { seedWordEntries } from '../fixtures/entries'

const SHORT_SENTENCE = 'Employers approach hiring differently.'
const LONG_SENTENCE = 'Approaching a new desk takes patience, especially when every unfamiliar detail of the workplace makes it harder to find the notes left by the previous team.'
const article = fixtureArticle({
  id: 'fixture-context-pin-board',
  sentences: [[SHORT_SENTENCE], [LONG_SENTENCE]]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-context-pin-board-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('词条和原句线程区分主词形与原句，长句截断但悬停可看全文', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
      { entry: article, paragraphIndex: 1, needle: 'Approaching', at: '2026-11-18T08:01:00.000Z' }
    ]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await page.locator('.entries-main-actions').getByRole('button', { name: '问模型' }).click()

  const context = page.getByRole('region', { name: '学习上下文' })
  const chips = context.locator('.context-chip-label')
  await expect(chips).toHaveText(['approach', LONG_SENTENCE], { timeout: 3000 })
  const original = context.getByTitle(LONG_SENTENCE, { exact: true })
  await expect(original).toBeVisible()
  await expect(original).toHaveCSS('text-overflow', 'ellipsis')
  expect(await original.evaluate((label) => label.scrollWidth > label.clientWidth)).toBe(true)

  await page.getByRole('heading', { name: 'approach', level: 1 }).getByRole('button').click()
  const shortSentence = page.locator('.entry-sentence').filter({ hasText: SHORT_SENTENCE })
  await shortSentence.hover()
  await shortSentence.getByRole('button', { name: '问模型' }).click()
  await expect(chips).toHaveText(['approach', SHORT_SENTENCE])
  await expect(context.getByTitle(SHORT_SENTENCE, { exact: true })).toBeVisible()
})

function seedPinThreads(userDataDirectory: string): string {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks: [] })
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    const seedThread = (question: string, filed: string, unfiled: string[]): string => {
      const text = [filed, ...unfiled].join('\n\n')
      const { threadId, answerId } = seedAnsweredThread(database, { question, answer: text })
      for (const excerpt of [filed, ...unfiled]) {
        const start = text.indexOf(excerpt)
        const result = createPin(database, {
          threadId, answerId, start, end: start + excerpt.length,
          target: excerpt === filed ? { kind: 'article', articleId: article.id } : { kind: 'unfiled' }
        })
        if (result.status !== 'pinned') throw new Error('没钉上')
      }
      return threadId
    }
    const currentId = seedThread('本线程的提问', '本线程已归档', ['本线程的暂存'])
    seedThread('另一条线程的提问', '其他线程已归档', ['其他线程的第一条暂存', '其他线程的第二条暂存'])
    return currentId
  } finally {
    database.close()
  }
}

test('顶栏和窄条区分本线程与全局未归档，两类 tab 的计数对应实际卡片', async ({
  launch,
  userDataDirectory
}) => {
  const currentId = seedPinThreads(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.evaluate((id) => { window.location.hash = `#/chat/${id}` }, currentId)
  await expect(page.getByRole('heading', { name: '本线程的提问', level: 1 })).toBeVisible()

  const board = page.getByRole('complementary', { name: '钉板', exact: true })
  await page.getByRole('button', { name: /^钉板 / }).click()
  await board.getByRole('tab', { name: '未归档 3', exact: true }).click()
  await expect(board.getByRole('tab', { name: '未归档 3', exact: true })).toHaveAttribute('aria-selected', 'true')
  const panel = board.getByRole('tabpanel')
  await expect(panel.getByRole('article')).toHaveCount(3)
  await expect(panel).toContainText('本线程的暂存')
  await expect(panel).toContainText('其他线程的第二条暂存')
  await expect(panel).not.toContainText('已归档')

  const threadTab = board.getByRole('tab', { name: '当前对话 1', exact: true })
  await threadTab.click()
  await expect(threadTab).toHaveAttribute('aria-selected', 'true')
  await expect(panel.getByRole('article')).toHaveCount(1)
  await expect(panel).toContainText('本线程已归档')
  await expect(panel).not.toContainText('其他线程已归档')

  await board.getByRole('tab', { name: '未归档 3', exact: true }).click()
  await panel.getByRole('article').filter({ hasText: '本线程的暂存' })
    .getByRole('button', { name: '归到文章' }).click()
  const dialog = page.getByRole('dialog', { name: '归到哪儿' })
  await dialog.getByRole('combobox', { name: '选择文章' }).fill(String(article.json.label).slice(0, 6))
  await dialog.getByRole('option').first().click()
  await dialog.getByRole('button', { name: '归位', exact: true }).click()
  await expect(board.getByRole('tab', { name: '未归档 2', exact: true })).toBeVisible()
  await board.getByRole('tab', { name: '当前对话 2', exact: true }).click()
  await expect(panel.getByRole('article')).toHaveCount(2)
  await expect(panel).toContainText('本线程的暂存')
  await expect(panel).not.toContainText('其他线程')
})

test('窄窗钉板覆盖而不挤压正文，空态一行并可用关闭按钮、遮罩或 Esc 收起', async ({ launch }) => {
  const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  if (electronApp === null) throw new Error('需要开发版 Electron 进程')
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (!window) throw new Error('没有主窗口')
    window.setContentSize(1080, 820)
  })
  await expect.poll(() => page.evaluate(() => matchMedia('(max-width: 1100px)').matches)).toBe(true)
  await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '对话' }).click()
  const answerColumn = page.locator('.chat-column')
  const composer = page.getByRole('textbox', { name: '输入问题' })
  await composer.fill('暂不发送的提问')
  const originalColumn = await answerColumn.boundingBox()
  if (originalColumn === null) throw new Error('找不到正文列')
  const handle = page.getByRole('button', { name: /^钉板 / })
  const board = page.getByRole('complementary', { name: '钉板', exact: true })
  const close = board.getByRole('button', { name: '关闭钉板' })
  const panel = board.getByRole('tabpanel')

  await handle.click()
  await board.getByRole('tab', { name: '当前对话 0', exact: true }).click()
  await expect(panel).toHaveText('当前对话还没有钉住')
  expect(await answerColumn.boundingBox()).toEqual(originalColumn)
  await expect(close).toHaveText('关闭', { timeout: 3000 })
  await close.click()
  await expect(handle).toBeVisible()

  await handle.click()
  await expect(panel).toHaveText('没有未归档')
  await expect(board).not.toContainText('未归档 0 条 · 不计入收集')
  await page.mouse.click(originalColumn.x + 8, originalColumn.y + 8)
  await expect(handle).toBeVisible()

  await handle.click()
  await page.keyboard.press('Escape')
  await expect(handle).toBeVisible()
  await expect(composer).toHaveValue('暂不发送的提问')
})

test('上下文选择器向上浮出不挤压输入区，支持快速加全文及收起/完成/点外部/Esc关闭', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks: [] })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '对话' }).click()

  const composer = page.locator('.chat-composer')
  const beforeBox = await composer.boundingBox()
  if (beforeBox === null) throw new Error('找不到底部输入区')

  const openButton = page.getByRole('button', { name: '添加上下文' })
  await openButton.click()

  const picker = page.getByRole('group', { name: '可加入的上下文' })
  await expect(picker).toBeVisible()
  await expect(picker).toHaveCSS('position', 'absolute')

  // 向上浮出，不撑高底部输入区。
  const afterBox = await composer.boundingBox()
  expect(Math.round(afterBox?.height ?? 0)).toBe(Math.round(beforeBox.height))

  // 开关按钮切换成「收起」，搜索框获得焦点且套用了暖纸输入框样式。
  const collapseButton = page.getByRole('button', { name: '收起上下文' })
  await expect(collapseButton).toHaveText('收起')
  await expect(collapseButton).toHaveAttribute('aria-expanded', 'true')
  const search = picker.getByRole('textbox', { name: '搜索上下文' })
  await expect(search).toBeFocused()
  expect(await search.evaluate((el) => getComputedStyle(el).borderRadius)).toBe('8px')
  expect(await search.evaluate((el) => el.getBoundingClientRect().width)).toBeGreaterThan(300)

  // 文章与段落支持直接点「+ 全文」，不必先展开段落。
  await picker.getByRole('tab', { name: '文章与段落' }).click()
  const quickAdd = picker.locator('.context-article-quick').first()
  await quickAdd.click()
  await expect(quickAdd).toHaveText('已加全文')
  await expect(page.getByTestId('context-summary')).toHaveText(/^1 篇全文 · 约 \d+ 字$/)

  // 点外部输入框自动收起，且焦点留在输入框里供继续打字。
  const input = page.getByRole('textbox', { name: '输入问题' })
  await input.click()
  await expect(picker).toHaveCount(0)
  await expect(input).toBeFocused()

  // 再打开后点「完成」或按 Esc 都能关闭并把焦点还给开关按钮。
  await page.getByRole('button', { name: '添加上下文' }).click()
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: '完成' }).click()
  await expect(picker).toHaveCount(0)
  await expect(page.getByRole('button', { name: '添加上下文' })).toBeFocused()

  await page.getByRole('button', { name: '添加上下文' }).click()
  await expect(picker).toBeVisible()
  // Tab 移出浮层但仍在控件内或外部时按 Esc，照样关闭并把焦点还给开关按钮。
  await picker.getByRole('tab', { name: '当前相关' }).focus()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(page.getByRole('button', { name: '添加上下文' })).toBeFocused()
})
