import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub, type SseStub, type StubScript } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { seedLegacyModelProfiles, seedModelProvider } from '../fixtures/database'

const stubs: SseStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: StubScript): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

/** 空的 env 密钥把开发态 .env 挡住：这些用例从「没有环境变量配置」开始。 */
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

const firstArticle = fixtureArticle({
  id: 'fixture-settings-2024-06-s1-c1',
  year: 2024,
  month: 6,
  set: 1,
  sentences: [
    ['Settings keep the global default in one place.', 'Each passage can still keep its own.'],
    ['Reading never loses the sentence it came from.']
  ]
})

const secondArticle = fixtureArticle({
  id: 'fixture-settings-2024-06-s1-c2',
  year: 2024,
  month: 6,
  set: 1,
  sentences: [
    ['A second passage follows the global default.', 'No override has been written for it yet.'],
    ['The reading column stays at six hundred and twenty pixels.']
  ]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-settings-corpus-'))
  writeCorpusDirectory(corpusDirectory, [firstArticle, secondArticle])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test.describe('设置与密钥', () => {
  test('升级后模型服务是只读卡片：名称、协议、模型、验证与使用中都不丢，也没有编辑口', async ({
    launch,
    userDataDirectory
  }) => {
    seedLegacyModelProfiles(
      join(userDataDirectory, 'english-learning.db'),
      [
        {
          id: 'profile-deepseek',
          name: 'DeepSeek 官方',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-flash',
          apiKeySecret: null,
          verification: 'verified'
        },
        {
          id: 'profile-backup',
          name: 'Backup API',
          baseUrl: 'https://backup.example.com/v1',
          model: 'deepseek-v4-pro',
          apiKeySecret: null,
          verification: 'unverified'
        }
      ],
      'profile-deepseek'
    )

    const handle = await launch({ env: noEnvironmentConfig })
    const { page } = handle
    await openSettings(page)

    // 五个分区还在。
    for (const label of ['模型服务', '阅读', '外观', '数据', '关于']) {
      await expect(settingsNav(page).getByRole('button', { name: label })).toBeVisible()
    }

    const cards = page.locator('.profile-card')
    await expect(cards).toHaveCount(2)
    const first = cards.filter({ hasText: 'DeepSeek 官方' })
    await expect(first).toContainText('使用中')
    await expect(first).toContainText('已验证')
    await expect(first).toContainText('OpenAI Chat Completions')
    await expect(first).toContainText('deepseek-flash')
    await expect(first).toContainText('deepseek')
    await expect(first).toContainText('缺失')

    const second = cards.filter({ hasText: 'Backup API' })
    await expect(second).not.toContainText('使用中')
    await expect(second).toContainText('未验证')
    await expect(second).toContainText('backup-api')
    await expect(second).toContainText('deepseek-v4-pro')

    // 只读：没有新增、编辑、删除或表单入口。
    await expect(page.getByRole('button', { name: '新增一套' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^编辑/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^删除/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /切换/ })).toHaveCount(0)
    await expect(page.getByLabel('名称')).toHaveCount(0)
    await expect(page.getByLabel('API 密钥')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '测试当前连接' })).toHaveCount(0)

    // 重启后从迁移后的新表读回来，卡片原样还在；迁移不会重复跑。
    await handle.close()
    const reopened = await launch({ userDataDirectory, env: noEnvironmentConfig })
    await openSettings(reopened.page)
    await expect(reopened.page.locator('.profile-card')).toHaveCount(2)
    await expect(
      reopened.page.locator('.profile-card').filter({ hasText: 'DeepSeek 官方' })
    ).toContainText('使用中')
  })

  test('真实对话成功后 provider 自动转已验证，旧表不再参与', async ({
    launch,
    userDataDirectory
  }) => {
    const stream = await createStub({ kind: 'stream', text: ['答'] })
    seedModelProvider(join(userDataDirectory, 'english-learning.db'), {
      id: 'provider-chat',
      providerKey: 'chat-provider',
      displayName: 'Chat Provider',
      baseUrl: stream.baseUrl,
      modelId: 'deepseek-flash',
      authMode: 'env',
      envVar: 'E2E_CHAT_KEY',
      verification: 'unverified'
    })
    const { page } = await launch({
      env: { ...noEnvironmentConfig, E2E_CHAT_KEY: 'e2e-chat-key' }
    })
    await openSettings(page)

    const card = page.locator('.profile-card').filter({ hasText: 'Chat Provider' })
    await expect(card).toContainText('未验证')

    // 真发一次调用，成功后主进程自动把 provider 标成已验证。
    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '对话' })
      .click()
    await expect(page.getByRole('heading', { name: '新的学习' })).toBeVisible()
    await page.getByRole('textbox', { name: '输入问题' }).fill('给我一个例句')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.getByText('答', { exact: true })).toBeVisible()

    await openSettings(page)
    await expect(card).toContainText('已验证')
    await expect(card.locator('.profile-check')).toContainText('通过')
  })

  test('关于页列出程序版本、Electron 版本与词典版权', async ({ launch }) => {
    const { page } = await launch({ env: noEnvironmentConfig })
    await openSettings(page)
    await settingsNav(page).getByRole('button', { name: '关于' }).click()

    const about = page.getByRole('region', { name: '关于' })
    await expect(about).toContainText(/版本 0\.1\.0 · Electron 4\d/)
    await expect(about).toContainText('ECDICT（MIT License）')
    await expect(about).toContainText('ADR 0001')
    await expect(about).toContainText('ADR 0003')
  })

  test('主题浅色 / 深色 / 跟随系统立即生效，刷新后仍是选过的那档', async ({ launch }) => {
    const { page } = await launch({ env: noEnvironmentConfig })
    await openSettings(page)
    await settingsNav(page).getByRole('button', { name: '外观' }).click()

    const theme = page.getByRole('group', { name: '主题' })
    await expect(theme.getByRole('button', { name: '浅色' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )

    await theme.getByRole('button', { name: '深色' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.getByRole('status')).toContainText('已切换到深色')

    // 刷新后 bootstrap 从本机库读回深色。
    await page.reload()
    await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

    await settingsNav(page).getByRole('button', { name: '外观' }).click()
    await theme.getByRole('button', { name: '跟随系统' }).click()
    await expect(theme.getByRole('button', { name: '跟随系统' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const systemTheme = await page.evaluate(() =>
      window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    )
    await expect(page.locator('html')).toHaveAttribute('data-theme', systemTheme)

    await theme.getByRole('button', { name: '浅色' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  })

  test('设置页改的是全局默认，单篇覆盖不被覆盖', async ({ launch }) => {
    const { page } = await launch({
      env: { ...noEnvironmentConfig, CORPUS_DIRECTORY: corpusDirectory }
    })

    async function openArticle(index: number): Promise<void> {
      await page
        .getByRole('navigation', { name: '全局导航' })
        .getByRole('button', { name: '文章库' })
        .click()
      await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
      await page.locator('.library-row').nth(index).click()
      await page
        .getByRole('complementary', { name: '文章详情' })
        .getByRole('button', { name: '继续阅读' })
        .click()
      await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
      await expect(page.locator('.reading-paragraph').first()).toBeVisible()
    }

    async function leaveReading(): Promise<void> {
      // 阅读设置面板开着时，第一次 Esc 只关面板；没开时按一次就退回文章库。
      const panel = page.getByRole('region', { name: '阅读设置' })
      if (await panel.isVisible()) {
        await page.keyboard.press('Escape')
        await expect(panel).toBeHidden()
      }
      await page.keyboard.press('Escape')
      await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    }

    // 第一篇：在阅读页面板里改成本篇覆盖值 22。
    await openArticle(0)
    await page.getByRole('button', { name: '阅读设置' }).click()
    await page.getByRole('group', { name: '字号' }).getByRole('button', { name: '22' }).click()
    await expect(page.locator('.reading-paragraph').first()).toHaveCSS('font-size', '22px')
    await leaveReading()

    // 设置页把全局默认改成 16。
    await openSettings(page)
    await settingsNav(page).getByRole('button', { name: '阅读' }).click()
    await page.getByRole('group', { name: '默认字号' }).getByRole('button', { name: '16' }).click()
    await expect(page.getByRole('status')).toContainText('已保存为全局默认')
    await expect(page.locator('.settings-summary')).toHaveText(
      '当前全局默认 · 字号 16 · 行距 1.8 · 注释显示 · 弱高亮开'
    )

    // 有本篇覆盖的第一篇仍是 22。
    await openArticle(0)
    await expect(page.locator('.reading-paragraph').first()).toHaveCSS('font-size', '22px')
    await leaveReading()

    // 没单独调过的第二篇跟着全局默认走 16。
    await openArticle(1)
    await expect(page.locator('.reading-paragraph').first()).toHaveCSS('font-size', '16px')
  })
})
