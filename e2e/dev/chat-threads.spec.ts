import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import {
  startSseStub,
  type SseStub,
  type StubScript
} from '../../src/testing/sse-stub'
import { CONTINUE_INSTRUCTION } from '../../src/shared/threads'
import { expect, test, type AppHandle, type LaunchOptions } from '../fixtures/app'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'

const firstArticle = fixtureArticle({
  id: 'fixture-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['She approached the counter quietly.', 'The clerk smiled.'],
    ['Context keeps the skill alive.', 'Repeated words stick.']
  ]
})

const secondArticle = fixtureArticle({
  id: 'fixture-2026-06-s2-c2',
  year: 2026,
  month: 6,
  set: 2,
  label: '2026年6月 · 第2套 · 仔细阅读 Passage Two',
  sentences: [['Another passage approaches the same idea.', 'It reaches a different conclusion.']]
})

const standardPicks: SeedPick[] = [
  { entry: firstArticle, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
  {
    entry: firstArticle,
    paragraphIndex: 0,
    needle: 'Approaching',
    at: '2026-11-18T08:05:00.000Z'
  },
  {
    entry: secondArticle,
    paragraphIndex: 0,
    needle: 'approaches',
    at: '2026-11-18T08:10:00.000Z'
  },
  {
    entry: firstArticle,
    paragraphIndex: 2,
    needle: 'Context',
    at: '2026-11-18T08:15:00.000Z'
  }
]

let corpusDirectory: string
const stubs: SseStub[] = []

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-threads-corpus-'))
  writeCorpusDirectory(corpusDirectory, [firstArticle, secondArticle])
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

function chatEnvironment(baseUrl: string): Record<string, string> {
  return {
    DEEPSEEK_BASE_URL: baseUrl,
    DEEPSEEK_API_KEY: 'e2e-test-key',
    DEEPSEEK_MODEL: 'deepseek-flash'
  }
}

function seededEnvironment(baseUrl: string): Record<string, string> {
  return { ...chatEnvironment(baseUrl), CORPUS_DIRECTORY: corpusDirectory }
}

function seed(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks: standardPicks })
}

async function launchApp(
  launch: (options?: LaunchOptions) => Promise<AppHandle>,
  options: LaunchOptions
): Promise<Page> {
  const handle = await launch(options)
  return handle.page
}

async function openBlankChat(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '对话' })
    .click()
  await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
}

async function ask(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: '输入问题' }).fill(text)
  await page.getByRole('button', { name: '发送' }).click()
}

function entryRow(page: Page, name: string) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.locator('.entries-row').filter({
    has: page.locator('.entries-row-name', { hasText: new RegExp(`^${escaped}$`) })
  })
}

async function openEntry(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' })
    .click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await entryRow(page, name).click()
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
}

function requestMessages(stub: SseStub, index: number): { role: string; content: string }[] {
  const body = stub.requests[index]?.body ?? {}
  return (body.messages ?? []) as { role: string; content: string }[]
}

test.describe('线程主对象与上下文', () => {
  test('空白线程首问后新开学习，第二问进入另一条线程', async ({ launch }) => {
    const stub = await createStub({ kind: 'stream', text: ['好的。'] })
    const page = await launchApp(launch, { env: seededEnvironment(stub.baseUrl) })
    await openBlankChat(page)
    await ask(page, '第一条线程的问题')
    await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
    const firstHash = await page.evaluate(() => window.location.hash)
    expect(firstHash).toMatch(/^#\/chat\/.+/)

    await page.getByRole('complementary', { name: '线程列表' })
      .getByRole('button', { name: '新的学习' }).click()
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/chat')
    await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
    await expect(page.locator('.chat-scroll').getByText('第一条线程的问题')).toHaveCount(0)

    await ask(page, '第二条线程的问题')
    await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
    await expect.poll(() => stub.requests.length).toBe(2)
    const secondHash = await page.evaluate(() => window.location.hash)
    expect(secondHash).toMatch(/^#\/chat\/.+/)
    expect(secondHash).not.toBe(firstHash)
    expect(requestMessages(stub, 1)).toEqual([{ role: 'user', content: '第二条线程的问题' }])
    await expect(page.locator('.thread-row')).toHaveCount(2)
  })

  test('词条连点复用线程，头部回词条并可明确新开', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    const page = await launchApp(launch, { env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntry(page, 'approach')
    await page.getByRole('button', { name: '开始对话' }).dblclick()
    await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
    const firstUrl = page.url()
    await expect(page.locator('.thread-row')).toHaveCount(1)
    await page.getByRole('button', { name: /词条 approach · 3 条原句/ }).click()
    await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
    await page.getByRole('button', { name: '开始对话' }).click()
    await expect.poll(() => page.url()).toBe(firstUrl)
    await expect(page.locator('.thread-row')).toHaveCount(1)
    await page.getByRole('button', { name: /词条 approach · 3 条原句/ }).click()
    await page.getByRole('button', { name: '新开一条' }).dblclick()
    await expect(page.locator('.thread-row')).toHaveCount(2)
    expect(page.url()).not.toBe(firstUrl)
  })

  test('原句线程头回词条并定位那条原句', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    const page = await launchApp(launch, { env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntry(page, 'approach')
    const sentence = page.locator('.entry-sentence').filter({ hasText: 'Employers approach hiring differently.' })
    await sentence.hover()
    await sentence.getByRole('button', { name: '用这句提问' }).click()
    await page.getByRole('button', { name: /2026年6月 · 第1套.*第 1 句/ }).click()
    await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
    await expect(sentence).toHaveAttribute('data-focused', 'true')
    await expect(sentence).toBeInViewport()
    expect(page.url()).toContain('?sentence=')
  })

  test('词条原句可以复用已有线程或另开线程，各自保留对话和原句上下文', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    const stub = await createStub({ kind: 'stream', text: ['好的。'] })
    const { page, electronApp } = await launch({ env: seededEnvironment(stub.baseUrl) })
    if (electronApp === null) throw new Error('需要开发版 Electron 进程')
    await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('没有主窗口')
      window.setContentSize(898, 820)
    })
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(900)
    await openEntry(page, 'approach')
    const sentence = page.locator('.entry-sentence').filter({ hasText: 'Employers approach hiring differently.' })
    await sentence.getByRole('button', { name: '用这句提问' }).click()
    await expect(page.locator('.context-chip-label')).toHaveText(['approach', 'Employers approach hiring differently.'])
    await ask(page, '原线程的问题')
    await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
    const firstHash = await page.evaluate(() => window.location.hash)

    await page.locator('.chat-subtitle button').click()
    await sentence.getByRole('button', { name: '用这句提问' }).click()
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(firstHash)
    await expect(page.locator('.chat-scroll').getByText('原线程的问题')).toBeVisible()
    await page.locator('.chat-subtitle button').click()
    await sentence.getByRole('button', { name: '为这句新建线程' }).click()
    await expect(page.locator('.context-chip-label')).toHaveText(['approach', 'Employers approach hiring differently.'])
    await expect(page.locator('.chat-scroll').getByText('原线程的问题')).toHaveCount(0)
    expect(await page.evaluate(() => window.location.hash)).not.toBe(firstHash)
    await ask(page, '新线程的问题')
    await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
    await expect.poll(() => stub.requests.length).toBe(2)
    expect(requestMessages(stub, 1)[0]?.content).toContain('[原句] Employers approach hiring differently.')
    await page.goBack()
    await page.goBack()
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(firstHash)
    await expect(page.locator('.chat-scroll').getByText('原线程的问题')).toBeVisible()
    await expect(page.locator('.chat-scroll').getByText('新线程的问题')).toHaveCount(0)
    await expect(page.locator('.context-chip-label')).toHaveText(['approach', 'Employers approach hiring differently.'])
  })

  test('文章连点复用线程，头部回阅读并可明确新开', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    const page = await launchApp(launch, { env: { CORPUS_DIRECTORY: corpusDirectory } })
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '文章库' }).click()
    const detailTitle = await page.locator('.library-detail-title').innerText()
    await page.getByRole('button', { name: '与这篇对话' }).dblclick()
    await expect(page.getByRole('heading', { name: detailTitle, level: 1 })).toBeVisible()
    const firstUrl = page.url()
    await expect(page.locator('.thread-row')).toHaveCount(1)
    await page.locator('.chat-subtitle button').click()
    await expect.poll(() => page.url()).toContain('#/reading/')
    await page.goBack()
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '文章库' }).click()
    await page.getByRole('button', { name: '与这篇对话' }).click()
    await expect.poll(() => page.url()).toBe(firstUrl)
    await expect(page.locator('.thread-row')).toHaveCount(1)
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '文章库' }).click()
    await page.getByRole('button', { name: '新开一条' }).click()
    await expect(page.locator('.thread-row')).toHaveCount(2)
    expect(page.url()).not.toBe(firstUrl)
  })

  test('并发 IPC 按主对象打开只创建一条，查询返回同一条', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    const page = await launchApp(launch, { env: { CORPUS_DIRECTORY: corpusDirectory } })
    const result = await page.evaluate(async () => {
      const api = (window as unknown as { api: { invoke(channel: string, payload?: unknown): Promise<unknown> } }).api
      const listing = await api.invoke('entries:list', {}) as { entries: { id: string; mainForm: string }[] }
      const entryId = listing.entries.find((entry) => entry.mainForm === 'approach')?.id
      if (!entryId) throw new Error('missing fixture entry')
      const request = { main: { kind: 'entry', entryId } }
      const opened = await Promise.all(Array.from({ length: 8 }, () => api.invoke('chat:open-for-main', request))) as
        { status: string; thread: { id: string } }[]
      const found = await api.invoke('chat:find-for-main', request) as { id: string } | null
      const threads = await api.invoke('chat:list') as { threads: { id: string }[] }
      return { opened, found, threads }
    })
    expect(result.opened.filter((item) => item.status === 'created')).toHaveLength(1)
    expect(new Set(result.opened.map((item) => item.thread.id)).size).toBe(1)
    expect(result.found?.id).toBe(result.opened[0]?.thread.id)
    expect(result.threads.threads).toHaveLength(1)
  })

  test('主对象删除后，线程头提示并给出继续选择的入口', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    const page = await launchApp(launch, { env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntry(page, 'approach')
    const sentence = page.locator('.entry-sentence').filter({ hasText: 'Employers approach hiring differently.' })
    await sentence.hover()
    await sentence.getByRole('button', { name: '用这句提问' }).click()
    const threadUrl = page.url()
    await openEntry(page, 'approach')
    await sentence.hover()
    await sentence.getByRole('button', { name: '删除' }).click()
    await expect(sentence).toHaveCount(0)
    await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '对话' }).click()
    await page.locator('.chat-subtitle button').click()
    await expect(page.getByRole('alert')).toContainText('主对象已经不在了')
    await expect(page.getByRole('button', { name: '选择词条' })).toBeVisible()
    await page.reload()
    await expect.poll(() => page.url()).toBe(threadUrl)
    await expect(page.getByRole('alert')).toContainText('主对象已经不在了')
    await page.getByRole('button', { name: '选择词条' }).click()
    await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  })

  test('来源词条已删除时，开始对话在当前页面提示并提供刷新', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    const page = await launchApp(launch, { env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openEntry(page, 'approach')
    const ids = await page.locator('.entry-sentence').evaluateAll((rows) =>
      rows.map((row) => (row as HTMLElement).dataset.entrySentenceId).filter((id): id is string => !!id)
    )
    await page.evaluate(async (sentenceIds) => {
      const api = (window as unknown as { api: { invoke(channel: string, payload: unknown): Promise<unknown> } }).api
      for (const entrySentenceId of sentenceIds) {
        await api.invoke('entries:delete-sentence', { entrySentenceId })
      }
    }, ids)
    await page.getByRole('button', { name: '开始对话' }).click()
    await expect(page.getByRole('alert')).toContainText('这个对象已经不在了')
    await expect(page.getByRole('button', { name: '刷新列表' })).toBeVisible()
    await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  })

  test('挂词条时预填上下文，可增删，发送时作为 system 前言带上', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    const stub = await createStub({ kind: 'stream', text: ['答案来了。'] })
    const page = await launchApp(launch, {
      env: seededEnvironment(stub.baseUrl)
    })

    await openEntry(page, 'approach')
    await page.getByRole('button', { name: '开始对话' }).click()

    await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
    await expect(page.getByText('词条 approach · 3 条原句 · 2 篇')).toBeVisible()

    // 默认带主词形与最近收的那一句。
    await expect(page.getByTestId('context-summary')).toHaveText(/^1 条原句 · 1 个词 · 约 \d+ 字$/)
    const originalSentence = 'Another passage approaches the same idea.'
    await expect(page.locator('.context-chip-label')).toHaveText(['approach', originalSentence])

    // 每项可单独移除。
    await page.getByRole('button', { name: `移除上下文：${originalSentence}`, exact: true }).click()
    await expect(page.getByTestId('context-summary')).toHaveText('1 个词 · 约 8 字')

    // 从候选里加回另一句。
    await page.getByRole('button', { name: '添加上下文' }).click()
    const picker = page.getByRole('group', { name: '可加入的上下文' })
    await picker
      .locator('.context-candidate[data-context-kind="sentence"]')
      .filter({ hasText: 'Employers approach hiring differently.' })
      .click()
    await expect(page.getByTestId('context-summary')).toHaveText(/^1 条原句 · 1 个词 · 约 \d+ 字$/)
    await page.getByRole('button', { name: '添加上下文' }).click()

    await ask(page, '这句里 approach 是什么用法？')
    await expect(page.getByText('答案来了。')).toBeVisible()
    await expect.poll(() => stub.requests.length).toBe(1)

    const messages = requestMessages(stub, 0)
    expect(messages[0]?.role).toBe('system')
    expect(messages[0]?.content).toContain('[原句] Employers approach hiring differently.')
    expect(messages.at(-1)).toEqual({ role: 'user', content: '这句里 approach 是什么用法？' })
  })

  test('四种主对象都能开线程：词条、原句、文章与空白', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    const stub = await createStub({ kind: 'stream', text: ['好的。'] })
    const page = await launchApp(launch, { env: seededEnvironment(stub.baseUrl) })

    await openEntry(page, 'approach')
    await page.getByRole('button', { name: '开始对话' }).click()
    await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()

    // 原句：词条页一条原句上的「提问」。
    await openEntry(page, 'approach')
    const sentence = page
      .locator('.entry-sentence')
      .filter({ hasText: 'Employers approach hiring differently.' })
    await sentence.hover()
    await sentence.getByRole('button', { name: '用这句提问' }).click()
    await expect(page.getByRole('heading', { name: 'approach · 原句', level: 1 })).toBeVisible()
    await expect(
      page.getByText('2026年6月 · 第1套 · 仔细阅读 Passage One · 段 1 · 第 1 句')
    ).toBeVisible()
    await expect(page.getByTestId('context-summary')).toHaveText(/^1 条原句 · 1 个词 · 约 \d+ 字$/)

    // 空白：线程栏里的「新的学习」。
    await page.getByRole('complementary', { name: '线程列表' }).getByRole('button', { name: '新的学习' }).click()
    await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
    await expect(page.getByText('未挂任何对象 · 从词或文章开始')).toBeVisible()

    // 文章：文章库详情的「与这篇对话」。
    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '文章库' })
      .click()
    const detailTitle = await page.locator('.library-detail-title').innerText()
    await page.getByRole('button', { name: '与这篇对话' }).click()
    await expect(page.getByRole('heading', { name: detailTitle, level: 1 })).toBeVisible()
    await expect(page.locator('.chat-subtitle')).toHaveText(
      /^\d{4}年\d{1,2}月 · 第\d+套 · .+ · \d+ 词$/
    )
    await expect(page.getByTestId('context-summary')).toHaveText(/^1 篇全文 · 约 \d+ 字$/)
  })
})

test.describe('回答版本与分支', () => {
  test('重新生成产生可切换的版本，切回旧版后重启仍在', async ({ launch, userDataDirectory }) => {
    const stub = await createStub({ kind: 'stream', thinking: ['想一下。'], text: ['第一版。'] })
    const first = await launch({ userDataDirectory, env: chatEnvironment(stub.baseUrl) })
    await openBlankChat(first.page)
    await ask(first.page, '给我两个例句')
    await expect(first.page.getByText('第一版。')).toBeVisible()
    await expect(first.page.getByRole('group', { name: '回答版本' })).toHaveCount(0)

    stub.setScript({ kind: 'stream', text: ['第二版。'] })
    await first.page.getByRole('button', { name: '重新生成' }).click()
    await expect(first.page.getByText('第二版。')).toBeVisible()

    const versions = first.page.getByRole('group', { name: '回答版本' })
    await expect(versions.getByRole('button')).toHaveCount(2)
    await expect(versions.getByRole('button', { name: '版本 2' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await versions.getByRole('button', { name: '版本 1' }).click()
    await expect(first.page.getByText('第一版。')).toBeVisible()
    await expect(first.page.getByText('第二版。')).toHaveCount(0)
    await first.close()

    // 重启后仍在原线程，旧版与选中的版本都保留。
    const second = await launch({ userDataDirectory, env: chatEnvironment(stub.baseUrl) })
    await expect(second.page.getByRole('complementary', { name: '线程列表' })).toContainText(
      '给我两个例句'
    )
    await expect(second.page.getByText('第一版。')).toBeVisible()
    const reloaded = second.page.getByRole('group', { name: '回答版本' })
    await expect(reloaded.getByRole('button', { name: '版本 1' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await reloaded.getByRole('button', { name: '版本 2' }).click()
    await expect(second.page.getByText('第二版。')).toBeVisible()
  })

  test('后面又问了一句时，仍能切回旧回答，切回来后续问也跟着回来', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['第一版。'] })
    const page = await launchApp(launch, {
      userDataDirectory,
      env: chatEnvironment(stub.baseUrl)
    })
    await openBlankChat(page)
    await ask(page, '第一问')
    await expect(page.getByText('第一版。')).toBeVisible()

    stub.setScript({ kind: 'stream', text: ['第二版。'] })
    await page.getByRole('button', { name: '重新生成' }).click()
    await expect(page.getByText('第二版。')).toBeVisible()

    stub.setScript({ kind: 'stream', text: ['后续回答。'] })
    await ask(page, '再问一句')
    await expect(page.getByText('后续回答。')).toBeVisible()

    const versions = page.getByRole('group', { name: '回答版本' })
    await versions.getByRole('button', { name: '版本 1' }).click()
    await expect(page.locator('.assistant-text')).toHaveText('第一版。')
    await expect(page.locator('.chat-message-user')).toHaveText(['第一问'])

    await versions.getByRole('button', { name: '版本 2' }).click()
    await expect(page.locator('.chat-message-user')).toHaveText(['第一问', '再问一句'])
    await expect(page.getByText('后续回答。')).toBeVisible()
  })

  test('改上一条提问走新分支，原回答保留可切回', async ({ launch, userDataDirectory }) => {
    const stub = await createStub({ kind: 'stream', text: ['原来的回答'] })
    const page = await launchApp(launch, {
      userDataDirectory,
      env: chatEnvironment(stub.baseUrl)
    })
    await openBlankChat(page)
    await ask(page, '原来的问法')
    await expect(page.getByText('原来的回答')).toBeVisible()

    await page.getByRole('button', { name: '编辑上一条提问' }).click()
    await expect(page.getByText('正在编辑这一条提问 · 发送后会新建分支，原来的回答保留')).toBeVisible()
    await expect(page.getByRole('textbox', { name: '输入问题' })).toHaveValue('原来的问法')

    stub.setScript({ kind: 'stream', text: ['新分支的回答'] })
    await page.getByRole('textbox', { name: '输入问题' }).fill('改过的问法')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.getByText('新分支的回答')).toBeVisible()
    await expect(page.locator('.chat-message-user')).toHaveText('改过的问法')

    const nav = page.getByRole('group', { name: '提问版本' })
    await expect(nav).toContainText('2/2')
    await nav.getByRole('button', { name: '上一个提问版本' }).click()
    await expect(page.locator('.chat-message-user')).toHaveText('原来的问法')
    await expect(page.getByText('原来的回答')).toBeVisible()
    await nav.getByRole('button', { name: '下一个提问版本' }).click()
    await expect(page.locator('.chat-message-user')).toHaveText('改过的问法')

    // 改口的那次请求只带新问法，旧提问不重复带上。
    expect(requestMessages(stub, 1).map((message) => message.content)).toEqual(['改过的问法'])
  })

  test('继续生成接在同一版回答后面，不产生新版本', async ({ launch, userDataDirectory }) => {
    const stub = await createStub({ kind: 'stream', text: ['第一段。'] })
    const page = await launchApp(launch, {
      userDataDirectory,
      env: chatEnvironment(stub.baseUrl)
    })
    await openBlankChat(page)
    await ask(page, '写一段')
    await expect(page.getByText('第一段。')).toBeVisible()

    stub.setScript({ kind: 'stream', text: ['第二段。'] })
    await page.getByRole('button', { name: '继续生成' }).click()
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
    await expect(page.locator('.assistant-text')).toHaveText('第一段。第二段。')
    await expect(page.getByRole('group', { name: '回答版本' })).toHaveCount(0)

    expect(requestMessages(stub, 1).map((message) => message.content)).toEqual([
      '写一段',
      '第一段。',
      CONTINUE_INSTRUCTION
    ])
    expect(requestMessages(stub, 1).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user'
    ])
  })
})
