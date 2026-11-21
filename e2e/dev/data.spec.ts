import type { ElectronApplication, Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  startSseStub,
  type SseStub,
  type StubScript
} from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { seedLegacyModelProfiles } from '../fixtures/database'

const stubs: SseStub[] = []
let workspace: string

test.beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'english-learning-data-e2e-'))
})

test.afterAll(async () => {
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: StubScript): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

const noEnvironmentConfig = { DEEPSEEK_API_KEY: '' }

function settingsNav(page: Page) {
  return page.getByRole('complementary', { name: '设置分区' })
}

async function openSettings(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '设置' })
    .click()
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
}

async function openData(page: Page): Promise<void> {
  await openSettings(page)
  await settingsNav(page).getByRole('button', { name: '数据' }).click()
  await expect(page.getByRole('heading', { name: '数据' })).toBeVisible()
}

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

function chatEnvironment(baseUrl: string): Record<string, string> {
  return {
    DEEPSEEK_BASE_URL: baseUrl,
    DEEPSEEK_API_KEY: 'e2e-test-key',
    DEEPSEEK_MODEL: 'deepseek-flash'
  }
}

test.describe('备份、恢复与导出', () => {
  test('一键备份落盘且不含密钥；恢复整体替换，替换前自动留快照', async ({
    launch,
    userDataDirectory
  }) => {
    const backupFile = join(workspace, 'chosen', 'english-learning-backup.db')
    const stub = await createStub({ kind: 'stream', text: ['恢复后不该匿名发出。'] })
    // 升级前的旧库：模型配置躺在 model_profile 里，密钥是密文。
    seedLegacyModelProfiles(
      join(userDataDirectory, 'english-learning.db'),
      [
        {
          id: 'profile-deepseek',
          name: 'DeepSeek 官方',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          apiKeySecret: 'e2e-secret-ciphertext-0001',
          verification: 'verified'
        }
      ],
      'profile-deepseek'
    )
    const handle = await launch({ env: noEnvironmentConfig })
    const { page, electronApp } = handle
    if (electronApp === null) throw new Error('开发态用例拿不到主进程句柄')

    // 升级后就地迁移成 provider，设置页能看到只读卡片。
    await openSettings(page)
    await expect(page.locator('.profile-card')).toContainText('DeepSeek 官方')
    await expect(page.locator('.profile-card')).toContainText('已验证')

    await openData(page)
    await expect(page.locator('.data-line').first()).toContainText('上次备份：还没有备份')

    await stubSaveDialog(electronApp, backupFile)
    await page.getByRole('button', { name: '立即备份' }).click()

    await expect(page.getByRole('status')).toContainText('已备份到 english-learning-backup.db')
    await expect(page.locator('.data-line').first()).toContainText(
      /上次备份：\d{4}-\d{2}-\d{2} \d{2}:\d{2} · \d+(?:\.\d)? (?:B|KB|MB)/
    )
    expect(existsSync(backupFile)).toBe(true)

    const copy = new Database(backupFile, { readonly: true, fileMustExist: true })
    try {
      const provider = copy
        .prepare('SELECT secret_ciphertext, verification FROM model_provider')
        .get() as { secret_ciphertext: string | null; verification: string }
      expect(provider.secret_ciphertext).toBeNull()
      expect(provider.verification).toBe('unverified')
      const legacy = copy
        .prepare('SELECT api_key_secret, verification FROM model_profile')
        .get() as { api_key_secret: string | null; verification: string }
      expect(legacy.api_key_secret).toBeNull()
      expect(legacy.verification).toBe('unverified')
      // 模型目录随 provider 一起进备份。
      expect(copy.prepare('SELECT COUNT(*) AS count FROM model_provider_model').get()).toEqual({
        count: 1
      })
    } finally {
      copy.close()
    }
    // 连密文字节都不该留在副本里（否则从空闲页里还能捞出来）。
    expect(readFileSync(backupFile).includes('e2e-secret-ciphertext-0001')).toBe(false)

    // 备份之后改成深色主题；恢复应当退回备份时的浅色。
    await settingsNav(page).getByRole('button', { name: '外观' }).click()
    await page.getByRole('group', { name: '主题' }).getByRole('button', { name: '深色' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await openData(page)
    await stubOpenDialog(electronApp, backupFile)
    await page.getByRole('button', { name: '从备份恢复…' }).click()

    const confirm = page.getByRole('alertdialog', { name: '确认恢复' })
    await expect(confirm).toContainText('english-learning-backup.db')
    await expect(confirm).toContainText('替换前会自动留一份当前快照')
    await expect(confirm).toContainText('备份里没有密钥')

    // 恢复成功后整库换过，界面重新载入；路由留在设置页。
    const reloaded = page.waitForEvent('load')
    await confirm.getByRole('button', { name: '恢复' }).click()
    await reloaded
    await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

    const snapshots = readdirSync(join(handle.userDataDirectory, 'snapshots'))
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]?.endsWith('.db')).toBe(true)

    // 恢复后配置还在，但密钥回到「缺失」。
    await openSettings(page)
    const card = page.locator('.profile-card').filter({ hasText: 'DeepSeek 官方' })
    await expect(card).toContainText('未验证')
    await expect(card).toContainText('缺失')

    // 缺失的密钥不能匿名发送，也不能改读环境变量：先在本地明确报错。
    // 把地址指到本机 stub，证明请求确实没有发出去（而不是碰真服务）。
    const restoredDatabase = new Database(
      join(handle.userDataDirectory, 'english-learning.db')
    )
    try {
      restoredDatabase
        .prepare("UPDATE model_provider SET base_url = ? WHERE provider_key = 'deepseek'")
        .run(stub.baseUrl)
    } finally {
      restoredDatabase.close()
    }
    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '对话' })
      .click()
    await expect(page.getByRole('textbox', { name: '输入问题' })).toBeVisible()
    await page.getByRole('textbox', { name: '输入问题' }).fill('恢复后发送')
    await page.getByRole('button', { name: '发送' }).click()
    const error = page.locator('.message-error')
    await expect(error).toContainText('这套提供商还没有密钥')
    expect(stub.requests).toHaveLength(0)

    // 数据区也记得这次恢复留下的快照，以及刚用过的这份备份。
    await openData(page)
    await expect(page.locator('.data-line').first()).toContainText(
      /上次备份：\d{4}-\d{2}-\d{2} \d{2}:\d{2} · \d+(?:\.\d)? (?:B|KB|MB)/
    )
    await expect(page.locator('.data-line').nth(1)).toContainText('恢复前快照：')
    await expect(page.locator('.data-line').nth(1)).toContainText(/\d+(?:\.\d)? (?:B|KB|MB)/)
  })

  test('把一条线程导出为可读 JSONL', async ({ launch }) => {
    const stub = await createStub({ kind: 'stream', text: ['答案来了。'] })
    const exportFile = join(workspace, 'exports', 'thread.jsonl')
    const { page, electronApp } = await launch({
      env: { ...noEnvironmentConfig, ...chatEnvironment(stub.baseUrl) }
    })
    if (electronApp === null) throw new Error('开发态用例拿不到主进程句柄')

    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '对话' })
      .click()
    await expect(page.getByRole('heading', { name: '新的学习' })).toBeVisible()
    await page.getByRole('textbox', { name: '输入问题' }).fill('什么是 lament？')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.getByText('答案来了。')).toBeVisible()

    await openData(page)
    await page.getByLabel('线程').selectOption({ index: 1 })
    await stubSaveDialog(electronApp, exportFile)
    await page.getByRole('button', { name: '导出为 JSONL' }).click()

    await expect(page.getByText('已导出到')).toContainText(exportFile)
    const content = readFileSync(exportFile, 'utf8')
    const records = content
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>)

    expect(records[0]).toMatchObject({
      type: 'thread',
      version: 1,
      title: '什么是 lament？'
    })
    expect(records[1]).toMatchObject({ type: 'question', text: '什么是 lament？' })
    expect(records[2]).toMatchObject({
      type: 'answer',
      text: '答案来了。',
      model: 'deepseek-flash',
      phase: 'done'
    })
    expect(content.startsWith('\uFEFF')).toBe(false)
  })
})
