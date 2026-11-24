import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { holdIpcReply } from '../fixtures/bridge'
import { seedWordEntries } from '../fixtures/entries'
import { openArticle, selectText } from '../fixtures/reading'

/**
 * 阅读页右侧的迷你轻问抽屉：
 * - 顶栏 / 词条卡 / 跨句摘录的「问模型」都在原地打开，不跳离文章；
 * - 复用同一个对话 store：提问、思维链、流式、停止与部分结果落库都和对话页一致；
 * - 「在对话页展开」带同一个 threadId，草稿、上下文与流式状态不丢；
 * - 只 AI 正文可钉，思维链不可钉；Esc 先内层弹层再收回抽屉，不退出阅读、不动滚动。
 */

const TITLE = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-drawer',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE,
  sentences: [
    ['Employers approach hiring differently.', 'Practice keeps the skill alive.'],
    ['Approaching a new desk takes patience.'],
    ['She approached the counter quietly.']
  ]
})

let corpusDirectory: string
const stubs: SseStub[] = []

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-drawer-e2e-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function environment(baseUrl = ''): Record<string, string> {
  return {
    CORPUS_DIRECTORY: corpusDirectory,
    ...(baseUrl === ''
      ? {}
      : {
          DEEPSEEK_BASE_URL: baseUrl,
          DEEPSEEK_API_KEY: 'e2e-test-key',
          DEEPSEEK_MODEL: 'deepseek-flash'
        })
  }
}

async function startStream(
  script: Parameters<typeof startSseStub>[0]
): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

function drawer(page: Page) {
  return page.locator('[data-question-drawer="true"]')
}

function hash(page: Page): Promise<string> {
  return page.evaluate(() => window.location.hash)
}

/** 在指定容器里精确选中一段文字，并把 mouseup 交给抽屉正文（与真实划词同路）。 */
async function selectInside(page: Page, containerSelector: string, text: string): Promise<void> {
  await page.evaluate(
    ({ containerSelector: selector, text: target }) => {
      const container = document.querySelector(selector)
      if (!container) throw new Error(`没有 ${selector}`)
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      let node: Node | null = null
      let index = -1
      for (let next = walker.nextNode(); next; next = walker.nextNode()) {
        const found = (next as Text).data.indexOf(target)
        if (found >= 0) {
          node = next
          index = found
          break
        }
      }
      if (node === null || index < 0) throw new Error(`没有可选文字 ${target}`)
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + target.length)
      const selection = window.getSelection()
      if (!selection) throw new Error('没有选区')
      selection.removeAllRanges()
      selection.addRange(range)
      document
        .querySelector('.reading-drawer-body')
        ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    },
    { containerSelector, text }
  )
}

async function askDrawer(page: Page, text: string): Promise<void> {
  await drawer(page).getByRole('textbox', { name: '轻问输入' }).fill(text)
  await drawer(page).getByRole('button', { name: '发送' }).click()
}

test('顶栏问模型在原地打开抽屉：流式回答、同一 threadId 展开、草稿与上下文都不丢', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const stub = await startStream({
    kind: 'stream',
    thinking: ['先想一下。'],
    text: ['答案来了。'],
    firstChunkDelayMs: 900,
    textDelayMs: 2500,
    chunkDelayMs: 10
  })
  const { page } = await launch({ env: environment(stub.baseUrl) })
  await openArticle(page, TITLE)
  const readingHash = await hash(page)

  await page.getByRole('button', { name: '问模型' }).click()
  await expect(drawer(page)).toBeVisible()
  expect(await hash(page)).toBe(readingHash)
  await expect(drawer(page).locator('.reading-drawer-subtitle')).toContainText('1 篇全文')
  await expect(drawer(page).getByText('还没有问过')).toBeVisible()

  await askDrawer(page, '概括这一段')
  await expect(drawer(page).locator('.reading-drawer-waiting')).toBeVisible()
  await expect(drawer(page).getByText('先想一下。')).toBeVisible()

  // 回答还在路上，先写下一条草稿，再带着同一个 threadId 展开到完整对话页。
  const draft = '还没发出去的问题'
  await drawer(page).getByRole('textbox', { name: '轻问输入' }).fill(draft)
  const threads = (await page.evaluate(async () => {
    const api = (
      window as unknown as {
        api: { invoke(channel: string, payload?: unknown): Promise<unknown> }
      }
    ).api
    return api.invoke('chat:list')
  })) as { threads: { id: string }[] }
  expect(threads.threads).toHaveLength(1)
  const threadId = threads.threads[0]?.id ?? ''
  await drawer(page).getByRole('button', { name: '在对话页展开' }).click()

  await expect(page.getByRole('textbox', { name: '输入问题' })).toBeVisible()
  expect(await hash(page)).toBe(`#/chat/${encodeURIComponent(threadId)}`)
  await expect(page.getByRole('textbox', { name: '输入问题' })).toHaveValue(draft)
  await expect(page.getByTestId('context-summary')).toContainText('1 篇全文')
  await expect(page.getByText('答案来了。')).toBeVisible()
  await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
  await expect.poll(() => stub.requests.length).toBe(1)
})

test('词条卡与跨句摘录都在抽屉就地打开，并带上对的主对象与摘录', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach' },
      { entry: article, paragraphIndex: 1, needle: 'Approaching' }
    ]
  })
  const stub = await startStream({ kind: 'stream', text: ['好的。'] })
  const { page } = await launch({ env: environment(stub.baseUrl) })
  await openArticle(page, TITLE)

  // 词条卡：默认主对象是这条原句，上下文预填词 + 原句。
  await page.locator('.reading-collected').filter({ hasText: 'approach' }).first().click()
  await page
    .getByRole('complementary', { name: '词条' })
    .getByRole('button', { name: '问模型' })
    .click()
  await expect(drawer(page)).toBeVisible()
  await expect(drawer(page).locator('.reading-drawer-subtitle')).toContainText('1 个词')
  await expect(drawer(page).locator('.reading-drawer-subtitle')).toContainText('1 条原句')
  await drawer(page).getByRole('button', { name: '在对话页展开' }).click()
  await expect(page.locator('.context-chip-label')).toHaveText([
    'approach',
    'Employers approach hiring differently.'
  ])

  // 回到阅读页；跨句摘录也在这里就地打开，带上全文 + 摘录，且不与同篇段落重复。
  await page.goBack()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await selectText(page, 0, 'differently. Practice')
  const toolbar = page.getByRole('toolbar', { name: '摘录操作' })
  await expect(toolbar).toBeVisible()
  await toolbar.getByRole('button', { name: '问模型' }).click()
  await expect(drawer(page)).toBeVisible()
  await expect(drawer(page).locator('.reading-drawer-subtitle')).toContainText('1 篇全文 · 1 条摘录')
  await drawer(page).getByRole('button', { name: '在对话页展开' }).click()
  await expect(page.locator('.context-chip-label')).toHaveText([TITLE, '摘录'])
})

test('抽屉内可停止并保留部分结果；只 AI 正文可钉到对应词条，Esc 收回不动阅读滚动', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const stub = await startStream({
    kind: 'hang',
    thinking: ['思考中。'],
    text: ['先写到这里']
  })
  const { page } = await launch({ env: environment(stub.baseUrl) })
  await openArticle(page, TITLE)
  await page.locator('.reading-scroll').evaluate((element) => {
    element.scrollTop = 240
  })
  await page.waitForTimeout(200)

  await page.locator('.reading-collected').filter({ hasText: 'approach' }).first().click()
  const scrollTop = await page
    .locator('.reading-scroll')
    .evaluate((element) => element.scrollTop)
  await page
    .getByRole('complementary', { name: '词条' })
    .getByRole('button', { name: '问模型' })
    .click()
  await expect(drawer(page)).toBeVisible()

  await askDrawer(page, '这句怎么理解？')
  await expect(drawer(page).getByText('先写到这里')).toBeVisible()
  await drawer(page).getByRole('button', { name: '停止生成' }).click()
  await expect(drawer(page).getByText('已停止 · 未完成')).toBeVisible()
  await expect.poll(() => stub.abortedConnections).toBe(1)

  // 思维链不可钉：选中思维链不出现胶囊。
  await expect(drawer(page).getByRole('button', { name: '收回轻问' })).toBeVisible()
  const thinkingToggle = page.getByRole('button', { name: /已思考/ })
  if (await thinkingToggle.count()) {
    await thinkingToggle.click()
  }
  // 领域术语表把「思考过程」列为 Avoid，界面统一说「已思考」。
  await expect(page.locator('.reading-drawer')).not.toContainText('思考过程')
  await selectInside(page, '.reading-drawer-thinking-body', '思考中。')
  await expect(page.locator('.selection-capsule')).toHaveCount(0)

  // Esc 收回抽屉：仍在阅读页，滚动位置不变。
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  expect(
    await page.locator('.reading-scroll').evaluate((element) => element.scrollTop)
  ).toBe(scrollTop)

  // 重新打开同一入口：部分结果已落库，仍在同一条对话里。
  await page.locator('.reading-collected').filter({ hasText: 'approach' }).first().click()
  await page
    .getByRole('complementary', { name: '词条' })
    .getByRole('button', { name: '问模型' })
    .click()
  await expect(drawer(page).getByText('先写到这里')).toBeVisible()
  await expect(drawer(page).getByText('已停止 · 未完成')).toBeVisible()

  // 只 AI 正文可钉：选中正文片段 → 胶囊 → 默认落点是这条原句的词条。
  await selectInside(page, '.reading-drawer .assistant-text[data-answer-id]', '先写到这里')
  const capsule = page.getByRole('toolbar', { name: '选中片段操作' })
  await expect(capsule).toBeVisible()
  await capsule.getByRole('button', { name: '钉住' }).click()
  const dialog = page.getByRole('dialog', { name: '钉到哪儿' })
  await expect(dialog.getByRole('button', { name: /词条 · approach/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await dialog.getByRole('button', { name: '钉住', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已钉到词条 approach')

  // 到对话页确认这条钉住确实在当前对话里。
  await drawer(page).getByRole('button', { name: '在对话页展开' }).click()
  await page.getByRole('button', { name: /^钉板 / }).click()
  await expect(page.getByRole('tab', { name: '当前对话 1' })).toBeVisible()
  const card = page.locator('.pin-card').first()
  await expect(card).toContainText('先写到这里')
  await expect(card).toContainText('approach')
})

test('抽屉打开迟到时按 Esc 收回：结果不重开也不导航，下一次仍能正常打开', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const stub = await startStream({ kind: 'stream', text: ['好的。'] })
  const { page, electronApp } = await launch({ env: environment(stub.baseUrl) })
  if (electronApp === null) throw new Error('开发态用例需要 Electron 句柄')
  await openArticle(page, TITLE)
  const readingHash = await hash(page)

  const hold = await holdIpcReply(electronApp as ElectronApplication, 'chat:open-for-main')
  await page.getByRole('button', { name: '问模型' }).click()
  await expect.poll(hold.pending).toBe(true)
  await page.keyboard.press('Escape')
  await hold.release()

  await page.waitForTimeout(600)
  await expect(drawer(page)).toHaveCount(0)
  expect(await hash(page)).toBe(readingHash)
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()

  // 取消只作废这一次所有权，不把 store 的打开路径弄坏。
  await page.getByRole('button', { name: '问模型' }).click()
  await expect(drawer(page)).toBeVisible()
})

test('另一条对话正在生成时抽屉只给明确忙状态，不把旧流算到新 thread 上', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const stub = await startStream({ kind: 'hang', text: ['另一条的回答'] })
  const { page } = await launch({ env: environment(stub.baseUrl) })
  await openArticle(page, TITLE)
  await page.keyboard.press('Escape')

  // 先在对话页发起一条会挂住的生成。
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '对话' })
    .click()
  await page.getByRole('textbox', { name: '输入问题' }).fill('先问一句')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('另一条的回答')).toBeVisible()

  // 回到阅读页打开抽屉：这是另一条对话，不能显示旧流的内容，也不能发新问题。
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '阅读' })
    .click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await page.getByRole('button', { name: '问模型' }).click()
  await expect(drawer(page)).toBeVisible()
  await expect(drawer(page).getByText('还没有问过')).toBeVisible()
  await expect(drawer(page).getByText('另一条的回答')).toHaveCount(0)
  await expect(drawer(page).getByText('另一条对话正在生成，等它结束再发。')).toBeVisible()
  await expect(drawer(page).getByRole('button', { name: '发送' })).toBeDisabled()

  // 收回抽屉不打断那条流；回对话页能看到它仍在输出并能停止。
  await page.keyboard.press('Escape')
  await expect(drawer(page)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('navigation', { name: '全局导航' })).toBeVisible()
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '对话' })
    .click()
  await page.locator('.thread-row').filter({ hasText: '先问一句' }).click()
  await expect(page.getByText('另一条的回答')).toBeVisible()
  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByText('已停止 · 未完成')).toBeVisible()
  await expect(page.getByText('另一条的回答')).toBeVisible()
  await expect.poll(() => stub.abortedConnections).toBe(1)
})
