import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPin } from '../../src/main/pins/pins'
import { openDatabase } from '../../src/main/db/database'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test, type AppHandle } from '../fixtures/app'
import { seedAnsweredThread } from '../fixtures/chat'
import { databasePath } from '../fixtures/database'
import { seedWordEntries } from '../fixtures/entries'

/**
 * #80 外壳：融合标题栏、A+B 可折叠侧栏（224 ↔ 56、Ctrl+B、悬停提示、未归档琥珀点、
 * 重启持久化、阅读页全隐藏并恢复偏好），以及 prefers-reduced-motion 下 0ms。
 * 全部走真实 Electron 窗口与真实 SQLite，不用页面内假状态。
 */

const article = fixtureArticle({
  id: 'fixture-shell-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Context keeps the skill alive.'],
    ['A steady habit keeps the reading going.']
  ]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-shell-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function environment(): Record<string, string> {
  return { CORPUS_DIRECTORY: corpusDirectory, DEEPSEEK_API_KEY: '' }
}

function nav(page: Page) {
  return page.getByRole('navigation', { name: '全局导航' })
}

async function sidebarWidth(page: Page): Promise<number> {
  const box = await page.locator('.globals').boundingBox()
  return Math.round(box?.width ?? 0)
}

async function waitForWidth(page: Page, width: number): Promise<void> {
  await expect.poll(() => sidebarWidth(page), { timeout: 5_000 }).toBe(width)
}

/** 在库里种一条未归档钉住，用来验证收起态对话图标上的琥珀微点。 */
function seedUnfiledPin(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    const entry = database
      .prepare("SELECT id FROM word_entry WHERE main_form = 'approach'")
      .get() as { id: string }
    const { threadId, answerId } = seedAnsweredThread(database, {
      main: { kind: 'entry', entryId: entry.id },
      question: '这句怎么理解？',
      answer: '第一段：approach 是接近。',
      model: 'fixture-model'
    })
    const pinned = createPin(database, {
      threadId,
      answerId,
      start: 0,
      end: '第一段'.length,
      target: { kind: 'unfiled' }
    })
    if (pinned.status !== 'pinned') throw new Error('未归档钉住没造出来')
  } finally {
    database.close()
  }
}

/** 把主窗口的覆盖标题栏调用录下来；颜色随主题实时更新要能在真实窗口上观察到。 */
async function recordTitleBarOverlay(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window === undefined) throw new Error('没有主窗口')
    const calls: unknown[] = []
    ;(globalThis as unknown as { __titleBarOverlayCalls: unknown[] }).__titleBarOverlayCalls =
      calls
    const original = window.setTitleBarOverlay.bind(window)
    window.setTitleBarOverlay = (options) => {
      calls.push(options)
      original(options)
    }
  })
}

async function overlayCalls(app: ElectronApplication): Promise<unknown[]> {
  return app.evaluate(
    () =>
      (globalThis as unknown as { __titleBarOverlayCalls?: unknown[] })
        .__titleBarOverlayCalls ?? []
  )
}

/** 走真实设置页切换主题：渲染层与主进程原生侧都必须一起变。 */
async function saveTheme(
  page: Page,
  theme: '浅色' | '深色' | '跟随系统'
): Promise<void> {
  await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '设置' }).click()
  await page
    .getByRole('complementary', { name: '设置分区' })
    .getByRole('button', { name: '外观' })
    .click()
  await page.getByRole('group', { name: '主题' }).getByRole('button', { name: theme }).click()
}

test.describe('A+B 可折叠侧栏', () => {
  test('按钮与 Ctrl+B 在 224 / 56 间切换，收起态悬停显示页面名与计数，重启保持', async ({
    launch,
    userDataDirectory
  }) => {
    seedWordEntries(userDataDirectory, corpusDirectory, {
      picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
    })
    const first = await launch({ env: environment() })
    const page = first.page
    await expect(nav(page)).toBeVisible()
    await waitForWidth(page, 224)

    await page.getByRole('button', { name: '收起侧栏' }).click()
    await waitForWidth(page, 56)
    // 单 DOM：只是同一个 .globals 加收起态，不换成另一棵导航树。
    await expect(page.locator('.globals')).toHaveCount(1)
    await expect(page.locator('.nav-label').first()).toBeHidden()

    // 收起态悬停「词条」：页面名与计数一起出现。
    await nav(page).getByRole('button', { name: '词条', exact: true }).hover()
    const tip = nav(page).getByRole('button', { name: '词条', exact: true }).locator('.nav-tip')
    await expect(tip).toHaveText('词条 · 词条 1 个')
    await expect
      .poll(() => tip.evaluate((element) => getComputedStyle(element).opacity))
      .toBe('1')

    await page.keyboard.press('Control+b')
    await waitForWidth(page, 224)
    await expect(page.locator('.nav-label').first()).toBeVisible()

    await page.keyboard.press('Control+b')
    await waitForWidth(page, 56)
    await first.close()

    const second = await launch({ userDataDirectory, env: environment() })
    await waitForWidth(second.page, 56)
    await second.page.getByRole('button', { name: '展开侧栏' }).click()
    await waitForWidth(second.page, 224)
  })

  test('Ctrl+B 忽略输入法组合态与长按重复，不会连跳', async ({ launch }) => {
    const { page } = await launch({ env: environment() })
    await waitForWidth(page, 224)

    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'b',
          ctrlKey: true,
          isComposing: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await page.waitForTimeout(250)
    await waitForWidth(page, 224)

    await page.evaluate(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'b',
          ctrlKey: true,
          repeat: true,
          bubbles: true,
          cancelable: true
        })
      )
    })
    await page.waitForTimeout(250)
    await waitForWidth(page, 224)

    await page.keyboard.press('Control+b')
    await waitForWidth(page, 56)
  })

  test('阅读页完全隐藏全局栏，退出后恢复用户偏好的收起态', async ({ launch, userDataDirectory }) => {
    seedWordEntries(userDataDirectory, corpusDirectory, {
      picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
    })
    const { page } = await launch({ env: environment() })
    await waitForWidth(page, 224)
    await page.getByRole('button', { name: '收起侧栏' }).click()
    await waitForWidth(page, 56)

    await nav(page).getByRole('button', { name: '文章库' }).click()
    await page.locator('.library-row').first().click()
    await page
      .getByRole('complementary', { name: '文章详情' })
      .getByRole('button', { name: '继续阅读' })
      .click()
    await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
    await expect(page.locator('.globals')).toHaveCount(0)
    await expect(page.locator('.titlebar')).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await waitForWidth(page, 56)
  })

  test('有未归档钉住时，收起态对话图标显示琥珀微点，展开后不显示', async ({
    launch,
    userDataDirectory
  }) => {
    seedUnfiledPin(userDataDirectory)
    const { page } = await launch({ env: environment() })
    const chat = nav(page).getByRole('button', { name: '对话', exact: true })
    await expect(chat.locator('.nav-dot')).toBeHidden()

    await page.getByRole('button', { name: '收起侧栏' }).click()
    await waitForWidth(page, 56)
    await expect(chat.locator('.nav-dot')).toBeVisible()
    const color = await chat
      .locator('.nav-dot')
      .evaluate((element) => getComputedStyle(element).backgroundColor)
    expect(color).toBe('rgb(143, 90, 26)')

    await page.getByRole('button', { name: '展开侧栏' }).click()
    await waitForWidth(page, 224)
    await expect(chat.locator('.nav-dot')).toBeHidden()
  })
})

/** 系统对话框在 E2E 里没法点：把它换成直接返回用例给的路径。 */
async function stubSaveDialog(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath
    })) as unknown as typeof dialog.showSaveDialog
  }, file)
}

async function stubOpenDialog(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [filePath]
    })) as unknown as typeof dialog.showOpenDialog
  }, file)
}

test('侧栏折叠偏好随整库备份 / 恢复往返，不升 schema 版本', async ({ launch }) => {
  const workspace = await mkdtemp(join(tmpdir(), 'english-learning-shell-backup-'))
  try {
    const backupFile = join(workspace, 'shell-backup.db')
    const { page, electronApp } = await launch({ env: environment() })
    if (electronApp === null) throw new Error('需要开发版 Electron 进程')
    await waitForWidth(page, 224)
    const schemaVersion = await page.evaluate(async () => {
      const api = (window as unknown as {
        api: { invoke(channel: string, payload?: unknown): Promise<unknown> }
      }).api
      const bootstrap = (await api.invoke('app:bootstrap')) as { schemaVersion: number }
      return bootstrap.schemaVersion
    })

    // 备份时是收起态。
    await page.getByRole('button', { name: '收起侧栏' }).click()
    await waitForWidth(page, 56)
    await stubSaveDialog(electronApp, backupFile)
    await nav(page).getByRole('button', { name: '设置' }).click()
    await page
      .getByRole('complementary', { name: '设置分区' })
      .getByRole('button', { name: '数据', exact: true })
      .click()
    await page.getByRole('button', { name: '立即备份' }).click()
    await expect(page.locator('.toast')).toContainText('已备份到 shell-backup.db')

    // 备份后展开，恢复应当退回备份时的 56px。
    await page.getByRole('button', { name: '展开侧栏' }).click()
    await waitForWidth(page, 224)

    await stubOpenDialog(electronApp, backupFile)
    await page.getByRole('button', { name: '从备份恢复…' }).click()
    const confirm = page.getByRole('alertdialog', { name: '确认恢复' })
    await expect(confirm).toBeVisible()
    const reloaded = page.waitForEvent('load')
    await confirm.getByRole('button', { name: '恢复', exact: true }).click()
    await reloaded
    await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
    await waitForWidth(page, 56)

    const schemaAfter = await page.evaluate(async () => {
      const api = (window as unknown as {
        api: { invoke(channel: string, payload?: unknown): Promise<unknown> }
      }).api
      const bootstrap = (await api.invoke('app:bootstrap')) as { schemaVersion: number }
      return bootstrap.schemaVersion
    })
    expect(schemaAfter).toBe(schemaVersion)
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

test.describe('融合标题栏与纸墨微动效', () => {
  test('顶栏可拖动、右上角给原生控制区留位，颜色随浅色 / 深色 / 跟随系统实时更新', async ({
    launch
  }) => {
    const handle: AppHandle = await launch({ env: environment() })
    const { page, electronApp } = handle
    if (electronApp === null) throw new Error('需要开发版 Electron 进程')

    const titlebar = page.locator('.titlebar')
    await expect(titlebar).toBeVisible()
    const geometry = await titlebar.evaluate((element) => {
      const style = getComputedStyle(element)
      const box = element.getBoundingClientRect()
      return {
        height: box.height,
        appRegion: style.getPropertyValue('-webkit-app-region'),
        paddingRight: Number.parseFloat(style.paddingRight)
      }
    })
    expect(Math.round(geometry.height)).toBe(34)
    expect(geometry.appRegion).toBe('drag')
    // 原生最小化 / 最大化 / 关闭在右上角约 138px；渲染层必须让开。
    expect(geometry.paddingRight).toBeGreaterThanOrEqual(138)

    // 标题栏里没有可点控件落进右上角控制区。
    const controlsOverlap = await page.evaluate(() => {
      const bar = document.querySelector('.titlebar')
      if (bar === null) return false
      const barBox = bar.getBoundingClientRect()
      return Array.from(bar.querySelectorAll('button, a, input')).some((element) => {
        const box = element.getBoundingClientRect()
        return barBox.right - box.right < 138
      })
    })
    expect(controlsOverlap).toBe(false)

    await recordTitleBarOverlay(electronApp)
    await saveTheme(page, '深色')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect
      .poll(async () => (await overlayCalls(electronApp)).at(-1))
      .toEqual({ color: '#1A1A1E', symbolColor: '#E8E4DA', height: 34 })

    await saveTheme(page, '浅色')
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
    await expect
      .poll(async () => (await overlayCalls(electronApp)).at(-1))
      .toEqual({ color: '#FBFAF3', symbolColor: '#1A1A17', height: 34 })

    // 跟随系统：nativeTheme 的 updated 事件真的会重新推一份颜色到真实窗口。
    await saveTheme(page, '跟随系统')
    await electronApp.evaluate(({ nativeTheme }) => {
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', {
        configurable: true,
        get: () => true
      })
      nativeTheme.emit('updated')
    })
    await expect
      .poll(async () => (await overlayCalls(electronApp)).at(-1))
      .toEqual({ color: '#1A1A1E', symbolColor: '#E8E4DA', height: 34 })

    await electronApp.evaluate(({ nativeTheme }) => {
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', {
        configurable: true,
        get: () => false
      })
      nativeTheme.emit('updated')
    })
    await expect
      .poll(async () => (await overlayCalls(electronApp)).at(-1))
      .toEqual({ color: '#FBFAF3', symbolColor: '#1A1A17', height: 34 })
  })

  test('侧栏收合 200ms 纸墨缓出；减少动态效果时全局归零', async ({ launch }) => {
    const { page } = await launch({ env: environment() })
    await waitForWidth(page, 224)
    const normal = await page
      .locator('.globals')
      .evaluate((element) => getComputedStyle(element).transitionDuration)
    expect(normal).toContain('0.2s')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    const reduced = await page.evaluate(() => ({
      globals: getComputedStyle(document.querySelector('.globals')!).transitionDuration,
      button: getComputedStyle(document.querySelector('.button')!).transitionDuration,
      chat: getComputedStyle(document.querySelector('.globals')!).animationDuration
    }))
    expect(reduced.globals).toBe('0s')
    expect(reduced.button).toBe('0s')
    expect(reduced.chat).toBe('0s')

    // 关掉动画后仍能切换，只是不再过渡。
    await page.getByRole('button', { name: '收起侧栏' }).click()
    await waitForWidth(page, 56)
  })
})
