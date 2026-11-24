import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/database'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub, type SseStub, type StubScript } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { holdIpcReply } from '../fixtures/bridge'
import { seedAnsweredThread } from '../fixtures/chat'
import { databasePath } from '../fixtures/database'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'

/**
 * T17 用一组词学习：词条列表多选（最多 20 个不同词条）后开一条新线程，
 * 主对象保持为空，默认上下文是每个词与它最近收的原句；线程里还能继续增删，
 * 钉住默认落到未归档。取消选择或离开页面后不残留误选。
 */
const groupArticle = fixtureArticle({
  id: 'fixture-group-thread',
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['Context keeps the skill alive.', 'Repeated words stick.']
  ]
})

const groupPicks: SeedPick[] = [
  { entry: groupArticle, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
  {
    entry: groupArticle,
    paragraphIndex: 0,
    needle: 'Approaching',
    at: '2026-11-18T08:05:00.000Z'
  },
  { entry: groupArticle, paragraphIndex: 1, needle: 'Context', at: '2026-11-18T08:10:00.000Z' }
]

const ALPHA_WORDS = [
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf',
  'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november',
  'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango', 'uniform'
] as const

const manyWordsArticle = fixtureArticle({
  id: 'fixture-group-limit',
  sentences: [0, 1, 2].map((paragraph) =>
    ALPHA_WORDS.slice(paragraph * 7, paragraph * 7 + 7).map(
      (word) => `The ${word} appears in this practice sentence.`
    )
  )
})

const manyWordPicks: SeedPick[] = ALPHA_WORDS.map((word, index) => ({
  entry: manyWordsArticle,
  paragraphIndex: Math.floor(index / 7),
  needle: word,
  at: new Date(Date.UTC(2026, 10, 18, 8, index)).toISOString()
}))

const contextSummary = (page: Page) => page.getByTestId('context-summary')
const selectionBar = (page: Page) => page.getByRole('group', { name: '已选词条' })
const nextButton = (page: Page) => page.getByRole('button', { name: '用这些词学习' })
const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name, exact: true })

async function openEntries(page: Page): Promise<void> {
  await nav(page, '词条').click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
}

async function resizeTo(page: Page, electronApp: ElectronApplication | null, width: number): Promise<void> {
  if (electronApp !== null) {
    await electronApp.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (window === undefined) throw new Error('没有主窗口')
        window.setContentSize(size.width, size.height)
      },
      { width, height: 820 }
    )
  } else {
    await page.setViewportSize({ width, height: 820 })
  }
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 5_000 })
    .toBeLessThanOrEqual(width + 2)
  await page.waitForTimeout(200)
}

function threadIdOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const match = /#\/chat\/([^?&]+)/.exec(window.location.hash)
    if (match === null) throw new Error(`地址里没有线程：${window.location.hash}`)
    return decodeURIComponent(match[1] as string)
  })
}

let corpusDirectory: string
const stubs: SseStub[] = []

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-group-thread-'))
  writeCorpusDirectory(corpusDirectory, [groupArticle, manyWordsArticle])
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

test('多选两个词开一条新线程：带词与各自原句，可增删，钉住默认到未归档', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks: groupPicks })
  const stub = await createStub({ kind: 'stream', text: ['这两个词可以放在一起练。'] })
  const { page } = await launch({
    env: {
      CORPUS_DIRECTORY: corpusDirectory,
      DEEPSEEK_BASE_URL: stub.baseUrl,
      DEEPSEEK_API_KEY: 'e2e-test-key',
      DEEPSEEK_MODEL: 'deepseek-flash'
    }
  })
  await openEntries(page)

  await page.getByRole('checkbox', { name: '选择词条：approach' }).check()
  await page.getByRole('checkbox', { name: '选择词条：Context' }).check()
  // 已选数量写在列表里，动作按钮只在有选择时出现。
  await expect(selectionBar(page)).toContainText('已选 2 个词')

  await nextButton(page).click()
  // 主对象为空：标题按选中的词起名，副标题仍是空白线程那一句。
  await expect(page.getByRole('heading', { name: 'approach 等 2 个词', level: 1 })).toBeVisible()
  await expect(page.getByText('从词或文章开始')).toBeVisible()
  await expect(contextSummary(page)).toHaveText(/^2 条原句 · 2 个词 · 约 \d+ 字$/)
  await expect(page.locator('.context-chip-label')).toHaveText([
    'approach',
    'Approaching a new desk takes patience.',
    'Context',
    'Context keeps the skill alive.'
  ])
  const firstThreadId = await threadIdOf(page)

  // 更多原句可以从候选加进来。
  await page.getByRole('button', { name: '添加上下文' }).click()
  const picker = page.getByRole('group', { name: '可加入的上下文' })
  await picker
    .locator('.context-candidate[data-context-kind="sentence"]')
    .filter({ hasText: 'Employers approach hiring differently.' })
    .click()
  await expect(contextSummary(page)).toHaveText(/^3 条原句 · 2 个词 · 约 \d+ 字$/)
  await page.getByRole('button', { name: '添加上下文' }).click()

  // 移除与恢复：词移除后可从候选加回来，原句还在。
  await page.getByRole('button', { name: '移除上下文：approach', exact: true }).click()
  await expect(contextSummary(page)).toHaveText(/^3 条原句 · 1 个词 · 约 \d+ 字$/)
  await page.getByRole('button', { name: '添加上下文' }).click()
  await picker
    .locator('.context-candidate[data-context-kind="word"]')
    .filter({ hasText: 'approach' })
    .click()
  await expect(contextSummary(page)).toHaveText(/^3 条原句 · 2 个词 · 约 \d+ 字$/)
  await page.getByRole('button', { name: '添加上下文' }).click()

  // 提问时把组词与各自原句作为 system 前言带给模型。
  await page.getByRole('textbox', { name: '输入问题' }).fill('这两个词怎么一起用？')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('这两个词可以放在一起练。')).toBeVisible()
  await expect.poll(() => stub.requests.length).toBe(1)
  const messages = (stub.requests[0]?.body.messages ?? []) as { role: string; content: string }[]
  expect(messages[0]?.role).toBe('system')
  expect(messages[0]?.content).toContain('[词] approach')
  expect(messages[0]?.content).toContain('[词] Context')
  expect(messages[0]?.content).toContain('[原句] Approaching a new desk takes patience.')
  expect(messages[0]?.content).toContain('[原句] Context keeps the skill alive.')

  // 空白主对象的默认落点：钉住弹层预选未归档，钉完真的落在未归档。
  await page.locator('.assistant-actions').getByRole('button', { name: '钉住' }).click()
  const dialog = page.getByRole('dialog', { name: '钉到哪儿' })
  await expect(dialog.getByRole('button', { name: '未归档', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await dialog.getByRole('button', { name: '钉住', exact: true }).click()
  await expect(page.getByText('已放进未归档')).toBeVisible()
  await expect(page.getByRole('button', { name: /^钉板 1 / })).toBeVisible()
  const board = page.getByRole('complementary', { name: '钉板', exact: true })
  await expect(board.getByRole('button', { name: /未归档 1/ })).toBeVisible()

  const boardState = await page.evaluate(async (threadId) => {
    const api = (window as unknown as {
      api: { invoke(channel: string, payload: unknown): Promise<unknown> }
    }).api
    return api.invoke('pins:board', { threadId }) as Promise<{
      threadPins: { target: { kind: string }; defaultTarget: { kind: string } }[]
      unfiledPins: { target: { kind: string }; defaultTarget: { kind: string } }[]
      unfiledCount: number
    }>
  }, firstThreadId)
  expect(boardState.threadPins).toHaveLength(0)
  expect(boardState.unfiledCount).toBe(1)
  expect(boardState.unfiledPins[0]?.target).toEqual({ kind: 'unfiled' })
  expect(boardState.unfiledPins[0]?.defaultTarget).toEqual({ kind: 'unfiled' })

  // 再点一次「用这些词学习」是新线程：回到词条页选择已清空，新线程 id 与上一条不同。
  await openEntries(page)
  await expect(selectionBar(page)).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: '选择词条：approach' })).not.toBeChecked()
  await page.getByRole('checkbox', { name: '选择词条：approach' }).check()
  await page.getByRole('checkbox', { name: '选择词条：Context' }).check()
  await nextButton(page).click()
  await expect(page.getByRole('heading', { name: 'approach 等 2 个词', level: 1 })).toBeVisible()
  expect(await threadIdOf(page)).not.toBe(firstThreadId)
})

test('新的组词线程不继承另一条线程的编辑态，打开后能直接提新问题', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks: groupPicks.slice(0, 1) })
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    seedAnsweredThread(database, { question: '旧线程问题', answer: '旧线程回答' })
  } finally {
    database.close()
  }

  const stub = await createStub({ kind: 'stream', text: ['组词线程的新回答。'] })
  const { page } = await launch({
    env: {
      CORPUS_DIRECTORY: corpusDirectory,
      DEEPSEEK_BASE_URL: stub.baseUrl,
      DEEPSEEK_API_KEY: 'e2e-test-key',
      DEEPSEEK_MODEL: 'deepseek-flash'
    }
  })

  await nav(page, '对话').click()
  await page.locator('.thread-row').filter({ hasText: '旧线程问题' }).click()
  await page.getByRole('button', { name: '编辑上一条提问' }).click()
  await expect(page.locator('.edit-banner')).toBeVisible()

  // 旧线程的编辑态只属于旧线程；从词条页新开一条组词线程后必须从干净输入框开始。
  await openEntries(page)
  await page.getByRole('checkbox', { name: '选择词条：approach' }).check()
  await nextButton(page).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  await expect(page.locator('.edit-banner')).toHaveCount(0)

  await page.getByRole('textbox', { name: '输入问题' }).fill('新线程自己的问题')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('组词线程的新回答。')).toBeVisible()
  await expect.poll(() => stub.requests.length).toBe(1)
})

test('取消选择后迟到的组词结果不重开页面，也不覆盖随后开始的新线程', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks: groupPicks.slice(0, 1) })
  const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  if (!electronApp) throw new Error('需要 Electron 主进程句柄')
  await openEntries(page)

  const approach = page.getByRole('checkbox', { name: '选择词条：approach' })
  await approach.check()
  const held = await holdIpcReply(electronApp, 'chat:create-group')
  await nextButton(page).click()
  await expect.poll(held.pending).toBe(true)

  // 取消只清选择；旧请求仍在主进程里跑完，但它的结果已经不属于当前操作。
  await page.getByRole('button', { name: '取消选择' }).click()
  await expect(selectionBar(page)).toHaveCount(0)
  await approach.check()
  await expect(nextButton(page)).toBeEnabled()
  await nextButton(page).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  const freshId = await threadIdOf(page)

  // 旧结果晚到：不能把页面拉回它创建的那条线程，也不能把新线程的当前状态盖掉。
  await held.release()
  await page.evaluate(() => (window as unknown as {
    api: { invoke(channel: string, payload?: unknown): Promise<unknown> }
  }).api.invoke('chat:list'))
  await expect(page).toHaveURL(new RegExp(`#/chat/${freshId}$`))
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  // 主进程已经建成的旧线程不偷偷删除，稍后回到列表仍能看到。
  await expect(page.locator('.thread-row')).toHaveCount(2)
})

test('离开词条页后迟到的组词结果不劫持导航，线程仍留在列表里', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks: groupPicks.slice(0, 1) })
  const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  if (!electronApp) throw new Error('需要 Electron 主进程句柄')
  await openEntries(page)

  await page.getByRole('checkbox', { name: '选择词条：approach' }).check()
  const held = await holdIpcReply(electronApp, 'chat:create-group')
  await nextButton(page).click()
  await expect.poll(held.pending).toBe(true)

  await nav(page, '首页').click()
  await expect(nav(page, '首页')).toHaveAttribute('aria-current', 'page')
  await held.release()
  await page.evaluate(() => (window as unknown as {
    api: { invoke(channel: string, payload?: unknown): Promise<unknown> }
  }).api.invoke('chat:list'))

  await expect(nav(page, '首页')).toHaveAttribute('aria-current', 'page')
  await expect(page).not.toHaveURL(/#\/chat\//)
  // 迟到结果只是不驱动界面；建成的线程仍应出现在对话列表。
  await nav(page, '对话').click()
  await expect(page.locator('.thread-row')).toHaveCount(1)
})

test('最多 20 个不同词条：第 21 个不准选并明确提示，主进程也拒绝超词数', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks: manyWordPicks })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openEntries(page)

  const checkboxes = page.getByRole('checkbox', { name: /^选择词条：/ })
  await expect(checkboxes).toHaveCount(21)
  const firstName = await page.locator('.entries-row-name').first().innerText()
  for (let index = 0; index < 20; index += 1) {
    await checkboxes.nth(index).check()
  }
  await expect(selectionBar(page)).toContainText('已选 20 个词 · 已满')

  // 第 21 个：不进选择，给出一句明确的提示，计数仍是 20。
  const last = checkboxes.nth(20)
  await last.click()
  await expect(page.getByRole('status').filter({ hasText: '最多选 20 个词' })).toBeVisible()
  await expect(last).not.toBeChecked()
  await expect(selectionBar(page)).toContainText('已选 20 个词')

  // 20 个可以开线程：标题用第一个选中的词，上下文 20 个词 + 各自的默认原句。
  await nextButton(page).click()
  await expect(
    page.getByRole('heading', { name: `${firstName} 等 20 个词`, level: 1 })
  ).toBeVisible()
  await expect(contextSummary(page)).toHaveText(/^20 条原句 · 20 个词 · 约 \d+ 字$/)
  const threadId = await threadIdOf(page)

  // 在线程里再想加第 21 个词：候选里只剩那一个，点了也不进上下文。
  await page.getByRole('button', { name: '添加上下文' }).click()
  const picker = page.getByRole('group', { name: '可加入的上下文' })
  const wordCandidates = picker.locator('.context-candidate[data-context-kind="word"]')
  await expect(wordCandidates).toHaveCount(1)
  await wordCandidates.first().click()
  await expect(page.getByText('一条对话最多带 20 个词。')).toBeVisible()
  await expect(contextSummary(page)).toHaveText(/^20 条原句 · 20 个词 · 约 \d+ 字$/)

  // IPC 边界：伪造 21 个词条的上下文改不动，界面保持 20 个词。
  const rejectedContext = await page.evaluate(async (currentThreadId) => {
    const api = (window as unknown as {
      api: { invoke(channel: string, payload: unknown): Promise<unknown> }
    }).api
    const items = Array.from({ length: 21 }, (_, index) => ({
      id: `word:extra-${index}`,
      kind: 'word',
      label: `词 ${index}`,
      text: `词 ${index}`,
      source: ''
    }))
    return api.invoke('chat:context', { threadId: currentThreadId, items })
  }, threadId)
  expect(rejectedContext).toEqual({ status: 'rejected', reason: 'too-many-words' })
  await expect(contextSummary(page)).toHaveText(/^20 条原句 · 20 个词 · 约 \d+ 字$/)

  // 直接经 IPC 请求 21 个词条开线程也被拒绝。
  const rejectedGroup = await page.evaluate(async () => {
    const api = (window as unknown as {
      api: { invoke(channel: string, payload: unknown): Promise<unknown> }
    }).api
    return api.invoke('chat:create-group', {
      entryIds: Array.from({ length: 21 }, (_, index) => `entry-${index}`)
    })
  })
  expect(rejectedGroup).toEqual({ status: 'rejected', reason: 'too-many-words' })
})

test('取消或切页清空选择；筛选后计数如实、按稳定 id 选择；窄窗口不破版', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks: groupPicks })
  const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await resizeTo(page, electronApp, 1101)
  await openEntries(page)

  const approach = page.getByRole('checkbox', { name: '选择词条：approach' })
  const context = page.getByRole('checkbox', { name: '选择词条：Context' })
  await approach.check()
  await expect(selectionBar(page)).toContainText('已选 1 个词')

  // 搜索过滤后已选不随可见行变化：计数仍如实说 1，按 id 取消也不会串到别的词。
  await page.getByRole('searchbox', { name: '搜词条名、原句或学习内容' }).fill('Context')
  await expect(page.locator('.entries-row')).toHaveCount(1)
  await expect(selectionBar(page)).toContainText('已选 1 个词')
  await context.check()
  await expect(selectionBar(page)).toContainText('已选 2 个词')
  await page.getByRole('searchbox', { name: '搜词条名、原句或学习内容' }).fill('')
  await expect(approach).toBeChecked()
  await expect(context).toBeChecked()

  // 1101 窗口仍是两栏加覆盖抽屉，选择条不挤压中栏、不横向溢出。
  const layout = await page.locator('.entries-page').getAttribute('data-layout')
  expect(layout).toBe('drawer')
  const middle = page.getByRole('region', { name: '词条内容' })
  const box = await middle.boundingBox()
  expect(box!.width).toBeGreaterThanOrEqual(419)
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    inner: window.innerWidth,
    main: document.querySelector('main')?.scrollWidth ?? 0,
    mainClient: document.querySelector('main')?.clientWidth ?? 0
  }))
  expect(overflow.document).toBeLessThanOrEqual(overflow.inner + 1)
  expect(overflow.main).toBeLessThanOrEqual(overflow.mainClient + 1)

  // 取消选择：计数条消失，复选框复位。
  await page.getByRole('button', { name: '取消选择' }).click()
  await expect(selectionBar(page)).toHaveCount(0)
  await expect(approach).not.toBeChecked()
  await expect(context).not.toBeChecked()

  // 离开页面再回来：误选不残留。
  await approach.check()
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '对话' })
    .click()
  await openEntries(page)
  await expect(selectionBar(page)).toHaveCount(0)
  await expect(page.getByRole('checkbox', { name: '选择词条：approach' })).not.toBeChecked()
})
