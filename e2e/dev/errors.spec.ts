import type { ElectronApplication, Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { selectAnswerText } from '../fixtures/answer-selection'
import { seedWordEntries } from '../fixtures/entries'
import { selectText } from '../fixtures/reading'

/**
 * 收官验收：错误态不只是把报错抛出来。
 * 每个错误块都要有一句人话和一个动作；断开主进程处理函数（真实的 IPC 失败），
 * 再修好、点「再试一次」，确认动作真的把页面救回来。
 */

const stubs: SseStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(
  script: Parameters<typeof startSseStub>[0]
): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

async function nav(page: Page, label: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: label, exact: true })
    .click()
}

function invoke(page: Page, channel: string, payload?: unknown): Promise<unknown> {
  return page.evaluate(
    ({ channel: name, payload: body }) =>
      (
        window as unknown as {
          api: { invoke(channel: string, payload?: unknown): Promise<unknown> }
        }
      ).api.invoke(name, body),
    { channel, payload }
  )
}

/** 把主进程的某个 channel 拿掉：渲染层调用会真的被拒绝。 */
async function removeHandler(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate(({ ipcMain }, name) => {
    ipcMain.removeHandler(name)
  }, channel)
}

/** 用一份固定的可序列化结果把 channel 修好。 */
async function restoreHandler(
  app: ElectronApplication,
  channel: string,
  value: unknown
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, input) => {
      ipcMain.removeHandler(input.channel)
      ipcMain.handle(input.channel, async () => input.value)
    },
    { channel, value }
  )
}

const firstArticle = fixtureArticle({
  id: 'fixture-errors-2024-06-s1-c1',
  year: 2024,
  month: 6,
  set: 1,
  sentences: [
    ['A broken import should leave the rest of the library readable.', 'The warning names the failed article.'],
    ['Retrying after the file is fixed brings it back without a restart.']
  ]
})

const secondArticle = fixtureArticle({
  id: 'fixture-errors-2024-06-s1-c2',
  year: 2024,
  month: 6,
  set: 1,
  sentences: [
    ['The second article arrives when the broken file is repaired.'],
    ['Two rows then fill the same session group.']
  ]
})

let importCorpusDirectory: string
let brokenFile: string
let brokenContent: string

test.beforeAll(async () => {
  importCorpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-errors-import-'))
  writeCorpusDirectory(importCorpusDirectory, [firstArticle, secondArticle])
  brokenFile = join(importCorpusDirectory, secondArticle.file)
  brokenContent = readFileSync(brokenFile, 'utf8')
  writeFileSync(brokenFile, '{ not json\n', 'utf8')
})

test.afterAll(async () => {
  await rm(importCorpusDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  await rm(readingCorpusDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const readingArticle = fixtureArticle({
  id: 'fixture-errors-2026-06-s1-b',
  year: 2026,
  month: 6,
  set: 1,
  kind: 'long_match',
  sentences: [
    [
      'Reading settings and positions must be retryable when a write fails.',
      'The page keeps the text readable while the error block explains the next step.'
    ],
    [
      'A second paragraph gives the scroll container something to move.',
      'The position write happens after the scroll stops.'
    ],
    [
      'A third paragraph makes the page tall enough for a real scroll.',
      'Retrying the write should clear the error once the database is back.'
    ],
    [
      'A fourth paragraph keeps adding height to the reading column.',
      'The retry button should be reachable without scrolling back.'
    ],
    [
      'A fifth paragraph is here so the footer is far below the first screen.',
      'Reading position changes as the sentence at the top changes.'
    ],
    [
      'A sixth paragraph continues the same typography and spacing.',
      'Nothing about the layout changes from paragraph to paragraph.'
    ],
    [
      'A seventh paragraph brings the article close to its end.',
      'The last sentence is the one the position write should report.'
    ],
    [
      'An eighth paragraph closes the fixture article.',
      'Every write failure leaves an error block with a retry action.'
    ]
  ],
  annotations: [{ surface: 'retryable', gloss: '可重试', paragraph: 0, sentence: 0 }]
})

let readingCorpusDirectory: string

test.beforeAll(async () => {
  readingCorpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-errors-reading-'))
  writeCorpusDirectory(readingCorpusDirectory, [readingArticle])
})

async function openReading(page: Page): Promise<void> {
  await nav(page, '文章库')
  await page.locator('.library-row').first().click()
  await page
    .getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' })
    .click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
}

test.describe('收官验收 · 错误态', () => {
  test('导入失败时列出原因并给「重新导入」，修好后不用重启', async ({ launch }) => {
    const { page } = await launch({
      env: { CORPUS_DIRECTORY: importCorpusDirectory, DEEPSEEK_API_KEY: '' }
    })
    await nav(page, '文章库')

    const warning = page.getByRole('alert').filter({ hasText: '没导进来' })
    await expect(warning).toBeVisible()
    await expect(warning).toContainText('有 1 篇没导进来')
    await expect(warning).toContainText(secondArticle.id)
    await expect(warning.getByRole('button', { name: '重新导入' })).toBeVisible()
    await expect(page.locator('.library-count')).toHaveText('1 篇 · 1 个场次')

    writeFileSync(brokenFile, brokenContent, 'utf8')
    await warning.getByRole('button', { name: '重新导入' }).click()

    await expect(page.getByRole('status')).toContainText('重新导入完成：2 篇都在库里了。')
    await expect(page.getByRole('alert').filter({ hasText: '没导进来' })).toHaveCount(0)
    await expect(page.locator('.library-count')).toHaveText('2 篇 · 1 个场次')
    await expect(page.locator('.library-row')).toHaveCount(2)
  })

  test('首页、文章库、词条、设置与对话的加载错误都能原地重试', async ({
    launch
  }) => {
    const { page, electronApp } = await launch({ env: { DEEPSEEK_API_KEY: '' } })
    if (electronApp === null) throw new Error('开发态用例拿不到主进程句柄')

    // 首页。
    const homeSummary = await invoke(page, 'home:summary')
    await removeHandler(electronApp, 'home:summary')
    await nav(page, '文章库')
    await nav(page, '首页')
    const homeError = page.locator('.error-block')
    await expect(homeError).toContainText('首页没有读出来。')
    await expect(homeError.getByRole('button', { name: '再试一次' })).toBeVisible()
    await restoreHandler(electronApp, 'home:summary', homeSummary)
    await homeError.getByRole('button', { name: '再试一次' }).click()
    await expect(page.getByRole('heading', { name: '先读一篇' })).toBeVisible()
    await expect(page.locator('.error-block')).toHaveCount(0)

    // 文章库。
    await nav(page, '文章库')
    await expect(page.locator('.library-count')).toContainText('63 篇')
    const listing = await invoke(page, 'library:list')
    await removeHandler(electronApp, 'library:list')
    await nav(page, '首页')
    await nav(page, '文章库')
    const libraryError = page.locator('.error-block')
    await expect(libraryError).toContainText('文章库没有读出来。')
    await restoreHandler(electronApp, 'library:list', listing)
    await libraryError.getByRole('button', { name: '再试一次' }).click()
    await expect(page.locator('.library-count')).toHaveText('63 篇 · 7 个场次')
    await expect(page.locator('.error-block')).toHaveCount(0)

    // 词条。
    const entryList = await invoke(page, 'entries:list', {})
    await removeHandler(electronApp, 'entries:list')
    await nav(page, '词条')
    const entriesError = page.locator('.error-block')
    await expect(entriesError).toContainText('词条列表没有读出来。')
    await restoreHandler(electronApp, 'entries:list', entryList)
    await entriesError.getByRole('button', { name: '再试一次' }).click()
    await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
    await expect(page.locator('.error-block')).toHaveCount(0)
    await expect(page.locator('.entries-main-empty .eyebrow')).toHaveText('还没有词条')

    // 设置。
    const overview = await invoke(page, 'settings:overview')
    await removeHandler(electronApp, 'settings:overview')
    await nav(page, '设置')
    const settingsError = page.locator('.error-block')
    await expect(settingsError).toContainText('设置没有读出来。')
    await restoreHandler(electronApp, 'settings:overview', overview)
    await settingsError.getByRole('button', { name: '再试一次' }).click()
    await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
    await expect(page.getByRole('complementary', { name: '设置分区' })).toBeVisible()
    await expect(page.locator('.error-block')).toHaveCount(0)

    // 对话：对话列表打不开时也是同一套文案 + 动作。
    const threadList = await invoke(page, 'chat:list')
    await removeHandler(electronApp, 'chat:list')
    await nav(page, '对话')
    const chatError = page.locator('.error-block')
    await expect(chatError).toContainText('对话没有读出来。')
    await restoreHandler(electronApp, 'chat:list', threadList)
    await chatError.getByRole('button', { name: '再试一次' }).click()
    await expect(page.getByRole('heading', { name: '新的学习' })).toBeVisible()
    await expect(page.locator('.error-block')).toHaveCount(0)
  })

  test('没配模型与密钥被拒时给「去设置」，可重试的错误才给重试', async ({ launch }) => {
    const unconfigured = await launch({ env: { DEEPSEEK_API_KEY: '' } })
    const unconfiguredPage = unconfigured.page
    await nav(unconfiguredPage, '对话')
    await unconfiguredPage.getByRole('textbox', { name: '输入问题' }).fill('帮我看一个词')
    await unconfiguredPage.getByRole('button', { name: '发送' }).click()
    const unconfiguredAlert = unconfiguredPage.getByRole('alert')
    await expect(unconfiguredAlert).toContainText('还没有配置模型服务')
    await expect(unconfiguredAlert).toContainText('下一步：到设置 → 模型服务')
    await expect(unconfiguredAlert.getByRole('button', { name: '重试' })).toHaveCount(0)
    await unconfiguredAlert.getByRole('button', { name: '去设置' }).click()
    await expect(unconfiguredPage.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()

    const denied = await createStub({ kind: 'status', status: 401 })
    const configured = await launch({
      env: {
        DEEPSEEK_BASE_URL: denied.baseUrl,
        DEEPSEEK_API_KEY: 'e2e-errors-key',
        DEEPSEEK_MODEL: 'deepseek-flash'
      }
    })
    const page = configured.page
    await nav(page, '对话')
    await page.getByRole('textbox', { name: '输入问题' }).fill('再试一次')
    await page.getByRole('button', { name: '发送' }).click()
    const alert = page.getByRole('alert')
    await expect(alert).toContainText('密钥无效（401）')
    await expect(alert).toContainText('下一步：到设置 → 模型服务里换一个有效的 API 密钥')
    await expect(alert.getByRole('button', { name: '重试' })).toHaveCount(0)
    await alert.getByRole('button', { name: '去设置' }).click()
    await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
  })

  test('钉住弹层读不到落点时能重新读取，而不是只剩一句报错', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['这段可以钉住。'] })
    seedWordEntries(userDataDirectory, readingCorpusDirectory, {
      picks: [{ entry: readingArticle, paragraphIndex: 0, needle: 'retryable' }]
    })
    const { page, electronApp } = await launch({
      env: {
        CORPUS_DIRECTORY: readingCorpusDirectory,
        DEEPSEEK_BASE_URL: stub.baseUrl,
        DEEPSEEK_API_KEY: 'e2e-errors-key',
        DEEPSEEK_MODEL: 'deepseek-flash'
      }
    })
    if (electronApp === null) throw new Error('开发态用例拿不到主进程句柄')

    await nav(page, '词条')
    await page.locator('.entries-row').first().click()
    await page.getByRole('button', { name: '开始对话' }).click()
    await page.getByRole('textbox', { name: '输入问题' }).fill('这段能收吗？')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.locator('.assistant-text')).toContainText('这段可以钉住。')

    const entryList = await invoke(page, 'entries:list', {})
    await removeHandler(electronApp, 'entries:list')
    await selectAnswerText(page, '这段可以钉住')
    await page
      .locator('.pin-selection-card')
      .getByRole('button', { name: '钉住', exact: true })
      .click()

    const dialog = page.getByRole('dialog', { name: '钉到哪儿' })
    await expect(dialog.locator('.error-block')).toContainText('钉住的目标没有读出来。')
    await expect(dialog.getByRole('button', { name: '重新读取' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: '钉住', exact: true })).toBeDisabled()

    await restoreHandler(electronApp, 'entries:list', entryList)
    await dialog.getByRole('button', { name: '重新读取' }).click()
    await expect(dialog.locator('.error-block')).toHaveCount(0)
    await expect(dialog.getByRole('button', { name: /词条 · / })).toBeVisible()
    await dialog.getByRole('button', { name: '取消' }).click()
  })

  test('阅读设置与阅读位置写失败时都能重试成功', async ({ launch }) => {
    const { page, electronApp } = await launch({
      env: { CORPUS_DIRECTORY: readingCorpusDirectory, DEEPSEEK_API_KEY: '' }
    })
    if (electronApp === null) throw new Error('开发态用例拿不到主进程句柄')
    await openReading(page)

    // 阅读位置：写库被拒 → 错误块 + 重试保存。
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('reading:progress')
      ipcMain.handle('reading:progress', async () => {
        throw new Error('本机资料库暂时不可写')
      })
    })
    await page.locator('.reading-scroll').evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    const writeError = page.locator('.reading-write-error')
    await expect(writeError).toContainText('阅读位置没有记住，本机资料库可能不可写。')
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('reading:progress')
      ipcMain.handle('reading:progress', async () => ({ saved: true }))
    })
    await writeError.getByRole('button', { name: '重试保存' }).click()
    await expect(page.locator('.reading-write-error')).toHaveCount(0)

    // 阅读设置：保存被拒 → 面板里给「再存一次」，重试写入的是刚才那份值。
    await page.getByRole('button', { name: '阅读设置' }).click()
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('reading:settings')
      ipcMain.handle('reading:settings', async () => {
        throw new Error('本机资料库暂时不可写')
      })
    })
    await page.getByRole('group', { name: '字号' }).getByRole('button', { name: '22' }).click()
    const settingsError = page.locator('.reading-settings-error')
    await expect(settingsError).toContainText('这次阅读设置没有写入本机资料库。')
    await expect(page.locator('.reading-paragraph').first()).toHaveCSS('font-size', '20px')

    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('reading:settings')
      ipcMain.handle(
        'reading:settings',
        async (_event, payload: { preferences: Record<string, unknown> }) => ({
          saved: true,
          settings: { ...payload.preferences, source: 'article' }
        })
      )
    })
    await settingsError.getByRole('button', { name: '再存一次' }).click()
    await expect(page.locator('.reading-settings-error')).toHaveCount(0)
    await expect(page.locator('.reading-paragraph').first()).toHaveCSS('font-size', '22px')
  })

  test('词典没随包加载时说清楚，阅读与选词照常能用', async ({ launch, userDataDirectory }) => {
    const emptyDictionary = join(userDataDirectory, 'no-dictionary-here')
    await mkdir(emptyDictionary, { recursive: true })
    const { page } = await launch({
      env: {
        CORPUS_DIRECTORY: readingCorpusDirectory,
        DICTIONARY_DIRECTORY: emptyDictionary,
        DEEPSEEK_API_KEY: ''
      }
    })
    await openReading(page)

    await selectText(page, 0, 'retryable')

    const panel = page.getByRole('complementary', { name: '选词结果' })
    await expect(panel).toBeVisible()
    await expect(panel.locator('.dictionary-status')).toContainText(
      '词典没有随包加载 · 去问 LLM'
    )
    await expect(panel.locator('.reading-panel-entry')).toContainText('词条')
    await page.locator('.reading-bar-title').click()
    await expect(page.locator('.reading-collected')).toHaveCount(1)
  })
})
