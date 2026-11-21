import {
  _electron as electron,
  chromium,
  test as base,
  type Browser,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOwnedProcessShutdown } from '../../src/testing/process-shutdown'

const repositoryRoot = process.cwd()

/**
 * 测试进程可能从宿主继承 ELECTRON_RUN_AS_NODE（比如从 Electron 应用里跑命令），
 * 那会让 electron.exe 变成纯 Node，窗口起不来。启动被测应用前把它与 NODE_OPTIONS 去掉。
 */
function applicationEnvironment(
  overrides: Record<string, string> = {}
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key === 'NODE_OPTIONS') continue
    if (value !== undefined) environment[key] = value
  }
  return { ...environment, ...overrides }
}

export type AppHandle = {
  readonly page: Page
  readonly userDataDirectory: string
  /**
   * 开发态才有：用例可以在主进程里替换系统对话框（备份 / 恢复 / 导出都靠它）。
   * 打包产物是经由 CDP 连的，拿不到这一个句柄。
   */
  readonly electronApp: ElectronApplication | null
  /**
   * 模拟断电 / 强杀：不经过 before-quit 与 SQLite close，直接结束整个进程树。
   * 用来验证重启后数据仍一致。
   */
  kill(): Promise<void>
  close(): Promise<void>
}

export type LaunchOptions = {
  packaged?: boolean
  userDataDirectory?: string
  /** 覆盖被测应用的模型配置，指向本地 SSE stub。 */
  env?: Record<string, string>
}

type Fixtures = {
  userDataDirectory: string
  launch: (options?: LaunchOptions) => Promise<AppHandle>
}

/**
 * 开发产物：入口是仓库根，Playwright 用已安装的 Electron 直接拉起 `out/main/index.js`。
 * userData 指到临时目录，每次用例都是干净的一本库。
 */
async function launchDevelopmentApp(
  userDataDirectory: string,
  environment: Record<string, string>
): Promise<AppHandle> {
  const electronApp = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDirectory}`],
    cwd: repositoryRoot,
    env: environment
  })
  const page = await electronApp.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  // 只处理 Playwright 为这条用例拉起的 Electron 进程：先有界等它自己退，
  // 超时后只对它的进程树强制结束；等真的退出后才交给 fixture 删临时目录。
  const shutdown = createOwnedProcessShutdown(electronApp.process(), {
    graceful: () => electronApp.close(),
    gracefulTimeoutMs: 10_000,
    forceTimeoutMs: 10_000
  })
  return {
    page,
    userDataDirectory,
    electronApp,
    async kill() {
      // 崩溃/断电语义：不经过 before-quit 与 SQLite close，直接结束进程树。
      await shutdown.kill()
    },
    async close() {
      await shutdown.close()
    }
  }
}

function packagedExecutablePath(): string {
  const manifestPath = join(repositoryRoot, 'release', 'packaged-app.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`找不到打包产物清单 ${manifestPath}，请先运行 npm run package`)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    executablePath: string
  }
  return manifest.executablePath
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * 打包产物不能用 Playwright 的 Electron 启动器（它只在用 npm 里那份 Electron 时才注入
 * 自己的主进程 loader），所以按远程调试端口连上去，渲染出来的 DOM 一样能断言。
 */
async function launchPackagedApp(
  userDataDirectory: string,
  environment: Record<string, string>
): Promise<AppHandle> {
  const executablePath = packagedExecutablePath()
  const port = await findFreePort()
  const endpoint = `http://127.0.0.1:${port}`
  const child = spawn(
    executablePath,
    [`--user-data-dir=${userDataDirectory}`, `--remote-debugging-port=${port}`],
    { stdio: 'ignore', env: environment }
  )

  /** 启动失败时也只用强制结束清掉这条用例拉起的进程树。 */
  async function killOnFailure(): Promise<void> {
    await createOwnedProcessShutdown(child, {
      graceful: async () => {
        child.kill()
      }
    }).kill()
  }

  let browser: Browser
  try {
    browser = await waitForBrowser(endpoint)
  } catch (error) {
    await killOnFailure()
    throw error
  }

  const context = browser.contexts()[0]
  if (!context) {
    await browser.close().catch(() => undefined)
    await killOnFailure()
    throw new Error('打包产物没有可用的渲染上下文')
  }

  const page = context.pages()[0] ?? (await context.waitForEvent('page', { timeout: 30_000 }))
  await page.waitForLoadState('domcontentloaded')

  const shutdown = createOwnedProcessShutdown(child, {
    graceful: async () => {
      await Promise.all([
        browser.close().catch(() => undefined),
        Promise.resolve().then(() => child.kill())
      ])
    },
    gracefulTimeoutMs: 10_000,
    forceTimeoutMs: 10_000
  })
  return {
    page,
    userDataDirectory,
    electronApp: null,
    async kill() {
      await shutdown.kill()
      await browser.close().catch(() => undefined)
    },
    async close() {
      await shutdown.close()
    }
  }
}

async function waitForBrowser(endpoint: string): Promise<Browser> {
  const deadline = Date.now() + 30_000
  let lastError: unknown = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`)
      if (response.ok) {
        return await chromium.connectOverCDP(endpoint)
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`打包产物没有在 30 秒内打开调试端口 ${endpoint}：${String(lastError)}`)
}

export const test = base.extend<Fixtures>({
  userDataDirectory: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'english-learning-e2e-'))
    await use(directory)
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  },

  launch: async ({ userDataDirectory }, use) => {
    const launched: AppHandle[] = []
    await use(async (options: LaunchOptions = {}) => {
      const directory = options.userDataDirectory ?? userDataDirectory
      const environment = applicationEnvironment(options.env)
      const handle = options.packaged
        ? await launchPackagedApp(directory, environment)
        : await launchDevelopmentApp(directory, environment)
      launched.push(handle)
      return handle
    })
    const errors: unknown[] = []
    for (const handle of launched.reverse()) {
      try {
        await handle.close()
      } catch (error) {
        errors.push(error)
      }
    }
    // 清理失败不能静默吞掉：让 teardown 明确失败，而不是留一个还在跑的
    // Electron 子进程去和临时目录删除赛跑。
    if (errors.length > 0) {
      throw new AggregateError(errors, '关闭这条用例拉起的被测应用时失败')
    }
  }
})

export { expect } from '@playwright/test'
