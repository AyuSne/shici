import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub, type SseStub, type StubScript } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'
import { clickAway, selectText } from '../fixtures/reading'

/**
 * T18 存为文章与 AI 文章：带词上下文的回答完成后才出现「存为文章」，保存整次回答正文
 * 而不是钉住；生成文章进文章库 AI 段、能像真题一样打开、选词、收原句、回链，
 * 详情显示来源词，重命名后来源保留；重复保存新建一篇，不覆盖。
 */

const sourceArticle = fixtureArticle({
  id: 'fixture-generated-e2e',
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['Context keeps the skill alive.', 'Repeated words stick.']
  ]
})

const picks: SeedPick[] = [
  { entry: sourceArticle, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
  { entry: sourceArticle, paragraphIndex: 1, needle: 'Context', at: '2026-11-18T08:05:00.000Z' }
]

const GENERATED_BODY =
  'Approach shapes how we read. Context keeps the meaning alive.\n\n' +
  'A second paragraph follows here. The final line has no period'

const GENERATED_TITLE = 'approach、Context'

let corpusDirectory: string
const stubs: SseStub[] = []

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-generated-article-'))
  writeCorpusDirectory(corpusDirectory, [sourceArticle])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: StubScript): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

function launchEnv(stub: SseStub | null = null): Record<string, string> {
  return {
    CORPUS_DIRECTORY: corpusDirectory,
    ...(stub === null
      ? {}
      : {
          DEEPSEEK_BASE_URL: stub.baseUrl,
          DEEPSEEK_API_KEY: 'e2e-test-key',
          DEEPSEEK_MODEL: 'deepseek-flash'
        })
  }
}

async function openEntries(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' })
    .click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
}

async function openLibrary(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' })
    .click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  const toggle = page.getByRole('region', { name: 'AI 生成' }).getByRole('button', { name: /^AI 生成 \d+ 篇$/ })
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
}

async function openChat(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '对话' })
    .click()
}

const saveButton = (page: Page) =>
  page.locator('.assistant-actions').getByRole('button', { name: '存为文章' })

/** 从词条页多选一组词开线程，再选用「生成文章」示例。 */
async function startGeneratedThread(page: Page, words: readonly string[]): Promise<void> {
  await openEntries(page)
  for (const word of words) {
    await page.getByRole('checkbox', { name: `选择词条：${word}` }).check()
  }
  await page.getByRole('button', { name: '用这些词学习' }).click()
  await expect(page.getByRole('heading', { name: new RegExp(`^${words[0]}`), level: 1 })).toBeVisible()

  const instructions = page.getByRole('region', { name: '学习指令' })
  await instructions.getByRole('button', { name: '选用指令' }).click()
  await instructions.getByRole('button', { name: '示例：生成文章' }).click()
  await expect(page.getByRole('textbox', { name: '输入问题' })).not.toHaveValue('')
}

test('生成文章全链路：回答完成后存为文章，AI 段阅读、选词、回链、来源词、重命名与删除', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const stub = await createStub({
    kind: 'stream',
    text: [GENERATED_BODY],
    firstChunkDelayMs: 400
  })
  const { page } = await launch({ env: launchEnv(stub) })

  await startGeneratedThread(page, ['approach', 'Context'])
  await page.getByRole('textbox', { name: '输入问题' }).fill('用这两个词写一篇短文。')
  await page.getByRole('button', { name: '发送' }).click()

  // 生成中：正文还没出来，旧回答的「存为文章」也不该出现。
  await expect(page.locator('.waiting-dots')).toBeVisible()
  await expect(saveButton(page)).toHaveCount(0)

  await expect(page.getByText('Approach shapes how we read.')).toBeVisible()
  await expect(saveButton(page)).toHaveCount(1)
  await saveButton(page).click()
  await expect(page.getByText(/已存为文章「/)).toBeVisible()

  await openLibrary(page)
  const aiSection = page.getByRole('region', { name: 'AI 生成' })
  await expect(aiSection).toContainText('1 篇')
  const aiRow = aiSection.locator('.library-row').filter({ hasText: GENERATED_TITLE })
  await expect(aiRow).toContainText('AI 生成')
  await expect(aiRow).toContainText('词')
  // 真题仍按场次分组，场次数不把生成文章算进去。
  await expect(page.locator('.library-session')).toHaveCount(1)
  await expect(page.locator('.library-count')).toHaveText('2 篇 · 1 个场次')

  await aiRow.click()
  const detail = page.getByRole('complementary', { name: '文章详情' })
  await expect(detail.locator('.library-detail-title')).toHaveText(GENERATED_TITLE)
  // 不假装有真题年份、场次与 PDF 原卷。
  await expect(detail).not.toContainText('2024年6月')
  await expect(detail).not.toContainText('原卷')
  const sourceWords = detail.getByRole('region', { name: '来源词' })
  await expect(sourceWords.getByRole('button', { name: 'approach' })).toBeVisible()
  await expect(sourceWords.getByRole('button', { name: 'Context' })).toBeVisible()

  // 来源词点回词条。
  await sourceWords.getByRole('button', { name: 'approach' }).click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await openLibrary(page)
  await aiRow.click()
  await detail.getByRole('button', { name: '继续阅读' }).click()

  // 打开走现有阅读页：不显示段字母，正文按段与句呈现。
  await expect(page.getByRole('heading', { name: GENERATED_TITLE, level: 1 })).toBeVisible()
  await expect(page.locator('.reading-paragraph')).toHaveCount(2)
  await expect(page.locator('.reading-letter')).toHaveCount(0)
  await expect(page.getByText('The final line has no period')).toBeVisible()

  // 真实阅读圈词：生成文章里的词也能收成原句，并从选词卡进词条。
  await selectText(page, 0, 'Context')
  // 收下后先是本次选中的麦色底；点开正文外收起，变成已收集的弱高亮。
  await expect(page.locator('.reading-selected').filter({ hasText: 'Context' })).toBeVisible()
  await clickAway(page)
  await expect(page.locator('.reading-collected').filter({ hasText: 'Context' })).toBeVisible()
  await page.locator('.reading-collected').filter({ hasText: 'Context' }).first().click()
  const entryPanel = page.getByRole('complementary', { name: '词条' })
  await expect(entryPanel).toBeVisible()
  await entryPanel.getByRole('button', { name: '打开词条' }).click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()

  // 重命名：标题与列表同步，来源词仍在。
  await openLibrary(page)
  await aiRow.click()
  await detail.getByRole('button', { name: '重命名' }).click()
  await detail.getByRole('textbox', { name: '篇名' }).fill('我的 AI 文章')
  await detail.getByRole('button', { name: '保存篇名' }).click()
  await expect(detail.locator('.library-detail-title')).toHaveText('我的 AI 文章')
  await expect(aiSection.locator('.library-row').filter({ hasText: '我的 AI 文章' })).toBeVisible()
  await expect(sourceWords.getByRole('button', { name: 'Context' })).toBeVisible()

  // 把回答钉到这篇生成文章：删除后钉住应保留快照并转为未归档。
  await openChat(page)
  await expect(page.getByRole('article', { name: '学习助手' })).toBeVisible()
  await page.locator('.assistant-actions').getByRole('button', { name: '钉住' }).click()
  const pinDialog = page.getByRole('dialog', { name: '钉到哪儿' })
  await pinDialog.getByRole('button', { name: /^文章 · / }).click()
  await pinDialog.getByRole('combobox', { name: '选择文章' }).fill('我的 AI')
  await pinDialog.getByRole('option', { name: /我的 AI 文章/ }).click()
  await pinDialog.getByRole('button', { name: '钉住', exact: true }).click()
  await expect(page.getByText('已钉到文章 我的 AI 文章')).toBeVisible()

  // 删除生成文章：影响面显示原句与钉住，确认后钉住转未归档、快照仍在。
  await openLibrary(page)
  await aiSection.locator('.library-row').filter({ hasText: '我的 AI 文章' }).click()
  await expect(detail.locator('.library-detail-title')).toHaveText('我的 AI 文章')
  await detail.getByRole('button', { name: '删除文章' }).click()
  const deleteDialog = page.getByRole('alertdialog', { name: '删除文章' })
  await expect(deleteDialog).toContainText('将删除 1 条原句关联。')
  await expect(deleteDialog).toContainText('1 条钉住会移到未归档，内容与出处仍可查看。')
  await deleteDialog.getByRole('button', { name: '确认删除' }).click()

  await expect(page.getByText('文章已删除。')).toBeVisible()
  await expect(aiSection).toContainText('用一组词生成第一篇')
  await expect(aiSection.getByRole('button', { name: '去词条页选词' })).toBeVisible()

  await openChat(page)
  await page.getByRole('button', { name: /^钉板 / }).click()
  const board = page.getByRole('complementary', { name: '钉板', exact: true })
  await board.getByRole('tab', { name: '未归档 1' }).click()
  await expect(board).toContainText('Approach shapes how we read.')
})

test('停止后继续生成成功，整条回答可以存为文章并正常阅读', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const stub = await createStub({
    kind: 'hang',
    text: ['Half an answer starts here.']
  })
  const { page } = await launch({ env: launchEnv(stub) })

  await startGeneratedThread(page, ['approach'])
  await page.getByRole('textbox', { name: '输入问题' }).fill('写一篇短文。')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('Half an answer starts here.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('已停止 · 未完成')).toBeVisible()
  await expect(saveButton(page)).toHaveCount(0)

  // 续写成功之后，最后一段完成，整条正文（含早先停下的部分）都可保存。
  stub.setScript({ kind: 'stream', text: [' The ending arrives cleanly.'] })
  await page.getByRole('button', { name: '继续生成' }).click()
  await expect(page.locator('.assistant-text')).toHaveText(
    'Half an answer starts here. The ending arrives cleanly.'
  )
  await expect(saveButton(page)).toHaveCount(1)
  await saveButton(page).click()
  await expect(page.getByText(/已存为文章「/)).toBeVisible()

  await openLibrary(page)
  const aiRow = page.getByRole('region', { name: 'AI 生成' }).locator('.library-row').first()
  await aiRow.click()
  await page.getByRole('complementary', { name: '文章详情' }).getByRole('button', { name: '继续阅读' }).click()
  await expect(page.locator('.reading-paragraph')).toHaveText([
    'Half an answer starts here. The ending arrives cleanly.'
  ])
})

test('没有词上下文就没有存为文章；同一回答重复保存新建两篇而不覆盖', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const stub = await createStub({
    kind: 'stream',
    text: [GENERATED_BODY],
    firstChunkDelayMs: 400
  })
  const { page } = await launch({ env: launchEnv(stub) })

  // AI 段为空时给的是可用的词条入口，点了真的到词条页。
  await openLibrary(page)
  const initialAi = page.getByRole('region', { name: 'AI 生成' })
  await expect(initialAi).toContainText('用一组词生成第一篇')
  await initialAi.getByRole('button', { name: '去词条页选词' }).click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()

  // 空白线程没有带词：回答完成后也不出现存为文章。
  await openChat(page)
  await page.getByRole('textbox', { name: '输入问题' }).fill('不带词也聊一句。')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('Approach shapes how we read.')).toBeVisible()
  await expect(saveButton(page)).toHaveCount(0)

  // 带词线程：同一回答点两次存为文章，AI 段出现两篇独立文章。
  await startGeneratedThread(page, ['approach'])
  await page.getByRole('textbox', { name: '输入问题' }).fill('写一篇短文。')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('Approach shapes how we read.')).toBeVisible()
  await expect(saveButton(page)).toHaveCount(1)
  await saveButton(page).click()
  await expect(page.getByText(/已存为文章「/)).toBeVisible()
  await saveButton(page).click()
  await expect(page.getByText(/已存为文章「/)).toBeVisible()

  await openLibrary(page)
  const aiSection = page.getByRole('region', { name: 'AI 生成' })
  await expect(aiSection.locator('.library-row')).toHaveCount(2)
  await expect(page.locator('.library-count')).toHaveText('3 篇 · 1 个场次')
})

test('文章库删到一篇不剩时，AI 空态入口仍可用且不再暗示已删文章会复活', async ({
  launch
}) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openLibrary(page)
  await expect(page.locator('.library-row')).toHaveCount(1)
  await page.locator('.library-row').first().click()

  const detail = page.getByRole('complementary', { name: '文章详情' })
  await detail.getByRole('button', { name: '删除文章', exact: true }).click()
  await page
    .getByRole('alertdialog', { name: '删除文章' })
    .getByRole('button', { name: '确认删除', exact: true })
    .click()

  await expect(page.locator('.library-row')).toHaveCount(0)
  await expect(
    page.getByText('还没有文章。语料随应用分发，重新启动会再导入一次。', { exact: true })
  ).toHaveCount(0)
  const aiSection = page.getByRole('region', { name: 'AI 生成' })
  await expect(aiSection).toContainText('用一组词生成第一篇')
  await aiSection.getByRole('button', { name: '去词条页选词' }).click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
})

test('只有 AI 文章时默认选中第一篇，刷新后 URL 与选中一致', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const stub = await createStub({ kind: 'stream', text: [GENERATED_BODY] })
  const { page } = await launch({ env: launchEnv(stub) })

  await startGeneratedThread(page, ['approach'])
  await page.getByRole('textbox', { name: '输入问题' }).fill('写一篇短文。')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('Approach shapes how we read.')).toBeVisible()
  await saveButton(page).click()
  await expect(page.getByText(/已存为文章「/)).toBeVisible()

  // 先删掉唯一一篇真题，库里只剩生成文章。
  await openLibrary(page)
  await page.locator('.library-session .library-row').first().click()
  const detail = page.getByRole('complementary', { name: '文章详情' })
  await detail.getByRole('button', { name: '删除文章' }).click()
  await page
    .getByRole('alertdialog', { name: '删除文章' })
    .getByRole('button', { name: '确认删除' })
    .click()
  await expect(page.getByText('文章已删除。')).toBeVisible()

  const aiRow = page
    .getByRole('region', { name: 'AI 生成' })
    .locator('.library-row')
    .first()
  await expect(page.locator('.library-row')).toHaveCount(1)
  await expect(aiRow).toHaveAttribute('aria-current', 'true')
  await expect(detail.locator('.library-detail-title')).toHaveText('approach')
  await expect(page.locator('.library-count')).toHaveText('1 篇')
  const selectedHash = await page.evaluate(() => window.location.hash)

  await page.reload()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await expect(page.locator('.library-row')).toHaveCount(1)
  await expect(page.locator('.library-row[aria-current="true"]')).toHaveCount(1)
  await expect(page.locator('.library-detail-title')).toHaveText('approach')
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(selectedHash)
})
