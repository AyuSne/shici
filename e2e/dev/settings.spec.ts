import type { Page } from '@playwright/test'
import Database from 'better-sqlite3'
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
  test('升级后的卡片可切换与删除：迁移身份保留、目录元数据不冒充，旧表只是只读副本', async ({
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
    await expect(first).toContainText('自定义')
    // 迁移来的模型没有容量元数据：不冒充 DeepSeek 的 1,000,000 / 384,000。
    await expect(first).toContainText('目录未提供容量')

    const second = cards.filter({ hasText: 'Backup API' })
    await expect(second).not.toContainText('使用中')
    await expect(second).toContainText('未验证')
    await expect(second).toContainText('backup-api')
    await expect(second).toContainText('deepseek-v4-pro')

    // 可操作：内置目录添加、默认模型选择、切换、删除都在，但没有地址/模型编辑与测试连接。
    await expect(page.getByLabel('内置提供商')).toBeVisible()
    await expect(page.getByLabel('API 密钥')).toBeVisible()
    await expect(page.getByRole('button', { name: '保存提供商' })).toBeVisible()
    await expect(second.getByRole('radio')).toHaveCount(1)
    await expect(page.getByRole('button', { name: '测试当前连接' })).toHaveCount(0)
    await expect(page.getByLabel('名称')).toHaveCount(0)

    // 切换使用中只写选择；卡片上的「使用中」跟着走。
    await second.getByRole('button', { name: '设为当前' }).click()
    await expect(second).toContainText('使用中')
    await expect(first).not.toContainText('使用中')

    // 删除使用中的迁移 provider：先明确警告，删完留下「没有使用中」的提示。
    await second.getByRole('button', { name: '删除' }).click()
    await expect(second).toContainText('删除当前提供商后，需要另选一套才能继续对话')
    await second.getByRole('button', { name: '确认删除' }).click()
    await expect(page.locator('.profile-card')).toHaveCount(1)
    await expect(page.locator('.settings-hint.is-warning')).toContainText(
      '现在没有使用中的提供商'
    )

    // 重启后仍是迁移后的状态；旧 model_profile 表作为回滚副本原样保留。
    await handle.close()
    const legacy = new Database(join(userDataDirectory, 'english-learning.db'), {
      readonly: true,
      fileMustExist: true
    })
    try {
      expect(legacy.pragma('user_version', { simple: true })).toBe(14)
      expect(legacy.prepare('SELECT COUNT(*) AS count FROM model_profile').get()).toEqual({
        count: 2
      })
      expect(legacy.prepare('SELECT COUNT(*) AS count FROM model_provider').get()).toEqual({
        count: 1
      })
      expect(
        legacy.prepare("SELECT value FROM setting WHERE key = 'chat.activeProviderId'").get()
      ).toBeUndefined()
    } finally {
      legacy.close()
    }

    const reopened = await launch({ userDataDirectory, env: noEnvironmentConfig })
    await openSettings(reopened.page)
    await expect(reopened.page.locator('.profile-card')).toHaveCount(1)
    await expect(
      reopened.page.locator('.profile-card').filter({ hasText: 'DeepSeek 官方' })
    ).toContainText('自定义')
    await expect(reopened.page.locator('.settings-hint.is-warning')).toContainText(
      '现在没有使用中的提供商'
    )
  })

  test('从内置目录添加 DeepSeek / Kimi / GLM：自动带出端点与目录模型，保存不联网、密钥只显示掩码', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['密钥可用。'] })
    const handle = await launch({ env: noEnvironmentConfig })
    const { page } = handle
    await openSettings(page)

    async function addProvider(
      catalogId: 'deepseek' | 'kimi' | 'glm',
      apiKey: string
    ): Promise<void> {
      await page.getByLabel('内置提供商').selectOption(catalogId)
      await page.getByLabel('API 密钥').fill(apiKey)
      await page.getByRole('button', { name: '保存提供商' }).click()
      await expect(page.getByRole('status')).toContainText('已保存')
      await expect(page.getByLabel('API 密钥')).toHaveValue('')
    }

    // 目录预览：端点、环境变量与模型列表都由内置目录带出。
    await page.getByLabel('内置提供商').selectOption('deepseek')
    const preview = page.locator('.builtin-preview')
    await expect(preview).toContainText('https://api.deepseek.com')
    await expect(preview).toContainText('DEEPSEEK_API_KEY')
    await expect(preview).toContainText('deepseek-flash')
    await expect(preview).toContainText('deepseek-v4-pro')

    await addProvider('deepseek', 'sk-e2e-deepseek-1111')
    const firstDeepSeek = page.locator('[data-provider-key="deepseek"]')
    await expect(firstDeepSeek).toContainText('DeepSeek')
    await expect(firstDeepSeek).toContainText('未验证')
    await expect(firstDeepSeek).toContainText('内置目录 · deepseek')
    await expect(firstDeepSeek).toContainText('sk-·············1111')
    await expect(firstDeepSeek).toContainText('上下文 1,000,000 · 输出 384,000 · 支持思考')
    await expect(firstDeepSeek.getByRole('radio', { name: /deepseek-flash/ })).toBeChecked()
    await expect(firstDeepSeek.getByRole('radio', { name: /deepseek-v4-pro/ })).not.toBeChecked()

    // 真实用这套「本机保存」的密钥聊天：先选为使用中，再把地址指到本地 stub，
    // 验证 safeStorage 解出的是刚存的密钥。
    await firstDeepSeek.getByRole('button', { name: '设为当前' }).click()
    await expect(firstDeepSeek).toContainText('使用中')
    const liveDatabase = new Database(join(userDataDirectory, 'english-learning.db'))
    try {
      liveDatabase
        .prepare("UPDATE model_provider SET base_url = ? WHERE provider_key = 'deepseek'")
        .run(stub.baseUrl)
    } finally {
      liveDatabase.close()
    }
    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '对话' })
      .click()
    await expect(page.getByRole('textbox', { name: '输入问题' })).toBeVisible()
    await page.getByRole('textbox', { name: '输入问题' }).fill('用这套密钥回答')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.getByText('密钥可用。')).toBeVisible()
    await expect.poll(() => stub.requests.length).toBe(1)
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-e2e-deepseek-1111')
    expect(stub.requests[0]?.body.model).toBe('deepseek-flash')

    // 一次真实成功之后，本机密钥的 provider 自动转已验证。
    await openSettings(page)
    await expect(page.locator('[data-provider-key="deepseek"]')).toContainText('已验证')

    // 同一厂商第二套：Provider ID 唯一且不可改，目录身份仍是 deepseek。
    await addProvider('deepseek', 'sk-e2e-deepseek-2222')
    const secondDeepSeek = page.locator('[data-provider-key="deepseek-2"]')
    await expect(secondDeepSeek).toContainText('DeepSeek 2')
    await expect(secondDeepSeek).toContainText('sk-·············2222')
    await expect(secondDeepSeek).toContainText('内置目录 · deepseek')

    await addProvider('kimi', 'sk-e2e-kimi-3333')
    const kimi = page.locator('[data-provider-key="kimi"]')
    await expect(kimi).toContainText('Kimi')
    await expect(kimi).toContainText('https://api.moonshot.cn/v1')
    await expect(kimi).toContainText('MOONSHOT_API_KEY')
    await expect(kimi).toContainText('上下文 262,144 · 输出 262,144 · 支持思考')
    await expect(kimi.getByRole('radio', { name: /kimi-k2.6/ })).toBeChecked()

    await page.getByLabel('内置提供商').selectOption('glm')
    await expect(preview).toContainText('https://open.bigmodel.cn/api/paas/v4')
    await expect(preview).toContainText('ZAI_API_KEY')
    await addProvider('glm', 'sk-e2e-glm-4444')
    const glm = page.locator('[data-provider-key="glm"]')
    await expect(glm).toContainText('智谱 GLM')
    await expect(glm).toContainText('上下文 204,800 · 输出 131,072 · 支持思考')

    // 页面上只有掩码；IPC 概览里也没有任何明文密钥。
    const pageText = await page.locator('body').innerText()
    for (const key of [
      'sk-e2e-deepseek-1111',
      'sk-e2e-deepseek-2222',
      'sk-e2e-kimi-3333',
      'sk-e2e-glm-4444'
    ]) {
      expect(pageText).not.toContain(key)
    }
    const overviewJson = await page.evaluate(async () => {
      const api = (window as unknown as { api: { invoke(channel: string): Promise<unknown> } }).api
      return JSON.stringify(await api.invoke('settings:overview'))
    })
    expect(overviewJson).not.toContain('sk-e2e-deepseek-1111')
    expect(overviewJson).not.toContain('sk-e2e-kimi-3333')
    expect(overviewJson).toContain('·············')

    // 重启后四套配置都在，掩码仍在（本机 safeStorage 能解出来），明文仍不可见。
    await handle.close()
    const reopened = await launch({ userDataDirectory, env: noEnvironmentConfig })
    await openSettings(reopened.page)
    await expect(reopened.page.locator('.profile-card')).toHaveCount(4)
    await expect(reopened.page.locator('[data-provider-key="deepseek"]')).toContainText(
      'sk-·············1111'
    )
    await expect(reopened.page.locator('[data-provider-key="deepseek-2"]')).toContainText(
      'sk-·············2222'
    )
    await expect(reopened.page.locator('[data-provider-key="kimi"]')).toContainText(
      'sk-·············3333'
    )
    await expect(reopened.page.locator('[data-provider-key="glm"]')).toContainText(
      'sk-·············4444'
    )

    // 密钥只以 safeStorage 密文落库。
    const database = new Database(join(userDataDirectory, 'english-learning.db'), {
      readonly: true,
      fileMustExist: true
    })
    try {
      const rows = database
        .prepare('SELECT provider_key, secret_ciphertext, verification FROM model_provider')
        .all() as { provider_key: string; secret_ciphertext: string; verification: string }[]
      expect(rows).toHaveLength(4)
      for (const row of rows) {
        expect(row.secret_ciphertext).not.toContain('sk-e2e')
        expect(row.secret_ciphertext.startsWith('dpapi:v1:')).toBe(true)
      }
      const byKey = new Map(rows.map((row) => [row.provider_key, row]))
      // 刚用过一次的那套已转已验证；其余仍是保存后的未验证。
      expect(byKey.get('deepseek')?.verification).toBe('verified')
      for (const key of ['deepseek-2', 'kimi', 'glm']) {
        expect(byKey.get(key)?.verification).toBe('unverified')
      }
    } finally {
      database.close()
    }
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

  test('关于页列出程序版本与词典版权', async ({ launch }) => {
    const { page } = await launch({ env: noEnvironmentConfig })
    await openSettings(page)
    await settingsNav(page).getByRole('button', { name: '关于' }).click()

    const about = page.getByRole('region', { name: '关于' })
    await expect(about).toContainText('版本 0.1.0')
    await expect(about).toContainText('ECDICT（MIT License）')
    await expect(about).not.toContainText('ADR')
  })

  test('主题浅色 / 深色 / 跟随系统立即生效，刷新后仍是选过的那档', async ({ launch }) => {
    const { page } = await launch({ env: noEnvironmentConfig })
    await openSettings(page)
    await settingsNav(page).getByRole('button', { name: '外观' }).click()
    await expect(page.getByRole('region', { name: '外观' })).not.toContainText(/token|#[0-9A-Fa-f]{6}/)

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
