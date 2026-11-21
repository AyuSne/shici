import type { Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/database'
import { startSseStub, type SseStub, type StubScript } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { seedAnsweredThread } from '../fixtures/chat'
import { seedBuiltinProvider } from '../fixtures/database'

const stubs: SseStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: StubScript): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

const noEnvKey = { DEEPSEEK_API_KEY: '' }

function databaseFile(userDataDirectory: string): string {
  return join(userDataDirectory, 'english-learning.db')
}

async function openSettings(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '设置' })
    .click()
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
}

async function openChat(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '对话' })
    .click()
  await expect(page.getByRole('textbox', { name: '输入问题' })).toBeVisible()
}

async function ask(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: '输入问题' }).fill(text)
  await page.getByRole('button', { name: '发送' }).click()
}

test.describe('内置提供商的聊天链路', () => {
  test('保存后的内置 provider 真流式：思考先到、正文后到，默认模型与切换只影响后续消息，成功后转已验证', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({
      kind: 'stream',
      thinking: ['先想一下。'],
      text: ['答案来了。'],
      firstChunkDelayMs: 400,
      textDelayMs: 1200,
      chunkDelayMs: 10
    })
    const file = databaseFile(userDataDirectory)
    seedBuiltinProvider(file, {
      catalogProviderId: 'deepseek',
      baseUrl: stub.baseUrl,
      active: true
    })
    seedBuiltinProvider(file, {
      catalogProviderId: 'kimi',
      baseUrl: stub.baseUrl,
      active: false
    })

    const handle = await launch({
      env: { ...noEnvKey, E2E_PROVIDER_KEY: 'sk-provider-e2e' }
    })
    const { page } = handle
    await openSettings(page)
    const deepseek = page.locator('[data-provider-key="deepseek"]')
    await expect(deepseek).toContainText('使用中')
    await expect(deepseek).toContainText('未验证')

    // 第一次：使用目录默认模型 deepseek-flash，请求显式要思考。
    await openChat(page)
    await ask(page, '第一问')
    await expect(page.getByText(/正在思考…/)).toBeVisible()
    await expect(page.getByText('答案来了。').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /已思考 [1-9]\d* 秒/ })).toBeVisible()

    await expect.poll(() => stub.requests.length).toBe(1)
    const firstRequest = stub.requests[0]
    expect(firstRequest?.url).toBe('/chat/completions')
    expect(firstRequest?.headers.authorization).toBe('Bearer sk-provider-e2e')
    expect(firstRequest?.body).toMatchObject({
      model: 'deepseek-flash',
      stream: true,
      thinking: { type: 'enabled' },
      reasoning_effort: 'high'
    })

    // 一次真实成功之后，provider 自动转已验证。
    await openSettings(page)
    await expect(deepseek).toContainText('已验证')

    // 换默认模型：下一次才用 deepseek-v4-pro。
    await deepseek.getByRole('radio', { name: /deepseek-v4-pro/ }).check()
    await expect(
      deepseek.getByRole('radio', { name: /deepseek-v4-pro/ })
    ).toBeChecked()
    await openChat(page)
    await ask(page, '第二问')
    await expect.poll(() => stub.requests.length).toBe(2)
    expect(stub.requests[1]?.body.model).toBe('deepseek-v4-pro')

    // 切到 Kimi：之后的消息走 Kimi，前面两轮回答原样留着。
    await openSettings(page)
    const kimi = page.locator('[data-provider-key="kimi"]')
    await kimi.getByRole('button', { name: '设为当前' }).click()
    await expect(kimi).toContainText('使用中')
    await expect(deepseek).not.toContainText('使用中')

    await openChat(page)
    await expect(page.locator('.chat-message-user').filter({ hasText: '第一问' })).toBeVisible()
    await ask(page, '第三问')
    await expect.poll(() => stub.requests.length).toBe(3)
    expect(stub.requests[2]?.body.model).toBe('kimi-k2.6')
    await expect(page.getByText('答案来了。')).toHaveCount(3)

    // 重启后选择与验证状态都还在。
    await handle.close()
    const reopened = await launch({
      userDataDirectory,
      env: { ...noEnvKey, E2E_PROVIDER_KEY: 'sk-provider-e2e' }
    })
    await openSettings(reopened.page)
    await expect(reopened.page.locator('[data-provider-key="kimi"]')).toContainText('使用中')
    await expect(reopened.page.locator('[data-provider-key="deepseek"]')).toContainText(
      '已验证'
    )
  })

  test('Esc 停止保留已输出内容，停止不上报 error 或 done', async ({ launch, userDataDirectory }) => {
    const stub = await createStub({
      kind: 'hang',
      thinking: ['想一下。'],
      text: ['先写到这里']
    })
    seedBuiltinProvider(databaseFile(userDataDirectory), {
      catalogProviderId: 'deepseek',
      baseUrl: stub.baseUrl,
      active: true
    })

    const { page } = await launch({
      env: { ...noEnvKey, E2E_PROVIDER_KEY: 'sk-provider-e2e' }
    })
    await openChat(page)
    await ask(page, '写一半停下')
    await expect(page.getByText('先写到这里')).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(page.getByText('已停止 · 未完成')).toBeVisible()
    await expect(page.getByText('先写到这里')).toBeVisible()
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
    await expect.poll(() => stub.abortedConnections).toBe(1)
    // 停止之后不能因为超时/断流再补一条错误。
    await expect(page.getByRole('alert')).toHaveCount(0)
  })
})

test.describe('删除使用中的提供商', () => {
  test('明确清空选择、不使用环境变量里的另一套凭据，历史线程与钉住都保留', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['不该被调用'] })
    const file = databaseFile(userDataDirectory)
    seedBuiltinProvider(file, {
      catalogProviderId: 'deepseek',
      baseUrl: stub.baseUrl,
      active: true
    })
    seedBuiltinProvider(file, {
      catalogProviderId: 'kimi',
      baseUrl: stub.baseUrl,
      active: false
    })
    const database = openDatabase(file)
    try {
      const seeded = seedAnsweredThread(database, {
        question: '旧问题',
        answer: '旧回答',
        model: 'deepseek-flash'
      })
      database
        .prepare(
          `INSERT INTO pin (
             id, thread_id, thread_title, answer_id, turn_index, model, captured_text,
             char_start, char_end, target_kind, created_at
           ) VALUES ('e2e-pin', ?, '新的学习', ?, 0, 'deepseek-flash', '旧回答', 0, 3,
                     'unfiled', '2026-11-21T00:00:00.000Z')`
        )
        .run(seeded.threadId, seeded.answerId)
    } finally {
      database.close()
    }

    // DEEPSEEK_* 环境变量故意留着一套地址与密钥：删掉 provider 后不能悄悄用它。
    const handle = await launch({
      env: {
        DEEPSEEK_API_KEY: 'sk-env-fallback',
        DEEPSEEK_BASE_URL: stub.baseUrl,
        DEEPSEEK_MODEL: 'deepseek-flash',
        E2E_PROVIDER_KEY: 'sk-provider-e2e'
      }
    })
    const { page } = handle

    await openSettings(page)
    const deepseek = page.locator('[data-provider-key="deepseek"]')
    await expect(deepseek).toContainText('使用中')
    await deepseek.getByRole('button', { name: '删除' }).click()
    await expect(deepseek).toContainText('删除当前提供商后，需要另选一套才能继续对话')
    await deepseek.getByRole('button', { name: '确认删除' }).click()

    await expect(page.getByRole('status')).toContainText('已删除使用中的提供商')
    // 还有另一套 Kimi，但没有被自动选中：必须明确提示「现在没有使用中的提供商」。
    await expect(page.locator('.profile-card')).toHaveCount(1)
    await expect(page.locator('[data-provider-key="kimi"]')).toBeVisible()
    await expect(page.locator('.settings-hint.is-warning')).toContainText(
      '现在没有使用中的提供商'
    )
    await expect(page.locator('[data-provider-key="kimi"]')).not.toContainText('使用中')

    // 历史线程与钉住仍在；对话才提示没有配置，且没有回退到环境变量去请求。
    await openChat(page)
    await expect(
      page
        .getByRole('complementary', { name: '线程列表' })
        .getByRole('button', { name: '未归档 1' })
    ).toBeVisible()
    await page.locator('.thread-row').filter({ hasText: '旧问题' }).click()
    await expect(page.getByText('旧回答')).toBeVisible()
    await ask(page, '删除后的问题')
    await expect(page.getByText('还没有配置模型服务')).toBeVisible()
    expect(stub.requests).toHaveLength(0)

    // 重启后选择仍被明确清空，不偷偷回到环境变量。
    await handle.close()
    const stored = new Database(file, { readonly: true, fileMustExist: true })
    try {
      expect(stored.prepare('SELECT COUNT(*) AS count FROM model_provider').get()).toEqual({
        count: 1
      })
      expect(
        stored.prepare("SELECT value FROM setting WHERE key = 'chat.activeProviderId'").get()
      ).toBeUndefined()
      expect(
        stored
          .prepare("SELECT value FROM setting WHERE key = 'chat.providerSelectionCleared'")
          .get()
      ).toEqual({ value: '1' })
      expect(stored.prepare('SELECT COUNT(*) AS count FROM thread').get()).toEqual({ count: 1 })
      expect(stored.prepare('SELECT COUNT(*) AS count FROM pin').get()).toEqual({ count: 1 })
    } finally {
      stored.close()
    }

    const reopened = await launch({
      userDataDirectory,
      env: {
        DEEPSEEK_API_KEY: 'sk-env-fallback',
        DEEPSEEK_BASE_URL: stub.baseUrl,
        DEEPSEEK_MODEL: 'deepseek-flash'
      }
    })
    await openSettings(reopened.page)
    await expect(reopened.page.locator('.profile-card')).toHaveCount(1)
    await expect(reopened.page.locator('.settings-hint.is-warning')).toContainText(
      '现在没有使用中的提供商'
    )
  })
})
