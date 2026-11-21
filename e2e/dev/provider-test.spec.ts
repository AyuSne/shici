import type { Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { startSseStub, type SseStub, type StubScript } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { seedModelProvider } from '../fixtures/database'

const stubs: SseStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: StubScript): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

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

/** 挡住开发态 .env，并给环境变量模式准备一把本地密钥。 */
const localEnv = { DEEPSEEK_API_KEY: '', E2E_TEST_KEY: 'sk-e2e-test' }

test.describe('保存与测试连接分离', () => {
  test('保存不联网、状态未验证；显式测试按协议发一次最小请求，通过后转已验证', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({
      kind: 'stream',
      text: ['ok'],
      firstChunkDelayMs: 300
    })
    const handle = await launch({ env: localEnv })
    const { page } = handle
    await openSettings(page)

    await page.getByRole('button', { name: '自定义 API' }).click()
    const form = page.locator('[data-custom-provider-form="true"]')
    await form.getByLabel('Provider ID').fill('provider-test-relay')
    await form.getByLabel('显示名').fill('测试中转')
    await form.getByLabel('自定义接口地址').fill(stub.baseUrl)
    await form.getByRole('radio', { name: '使用环境变量' }).check()
    await form.getByLabel('环境变量名').fill('E2E_TEST_KEY')
    await form.getByLabel('首个模型 ID').fill('relay-test-model')

    // 保存是纯本地动作：不发任何请求，保存完仍是未验证。
    await form.getByRole('button', { name: '保存自定义提供商' }).click()
    await expect(page.getByRole('status')).toContainText('未验证（保存时不联网）')
    const card = page.locator('[data-provider-key="provider-test-relay"]')
    await expect(card).toContainText('未验证')
    await expect(card).toContainText('环境 · E2E_TEST_KEY')
    expect(stub.requests).toHaveLength(0)

    // 显式「测试连接」：忙碌态可见，完成后转已验证。
    const testButton = card.getByRole('button', { name: '测试连接 测试中转' })
    await testButton.click()
    await expect(testButton).toContainText('测试中…')
    await expect(card).toContainText('已验证')
    await expect.poll(() => stub.requests.length).toBe(1)

    // 只发一次最小请求：自带模型、环境变量里的密钥、极小输出预算、不打开思考。
    const request = stub.requests[0]!
    expect(request.url).toBe('/chat/completions')
    expect(request.headers.authorization).toBe('Bearer sk-e2e-test')
    expect(request.body).toMatchObject({ model: 'relay-test-model', stream: true })
    expect(
      (request.body.max_tokens ?? request.body.max_completion_tokens) as number
    ).toBeLessThanOrEqual(16)
    const thinking = request.body.thinking as { type?: string } | undefined
    expect(thinking?.type ?? 'disabled').toBe('disabled')
    expect(request.body.reasoning_effort).toBeUndefined()

    await handle.close()
    const database = new Database(databaseFile(userDataDirectory), {
      readonly: true,
      fileMustExist: true
    })
    try {
      const row = database
        .prepare(
          `SELECT verification, last_error, last_checked_at, last_verified_at,
                  base_url, auth_mode, env_var, secret_ciphertext
             FROM model_provider WHERE provider_key = 'provider-test-relay'`
        )
        .get() as Record<string, unknown>
      expect(row).toMatchObject({
        verification: 'verified',
        last_error: null,
        base_url: stub.baseUrl,
        auth_mode: 'env',
        env_var: 'E2E_TEST_KEY',
        secret_ciphertext: null
      })
      expect(row.last_checked_at).not.toBeNull()
      expect(row.last_verified_at).not.toBeNull()
    } finally {
      database.close()
    }
  })

  test('测试失败保留原配置与原密钥，显示原因与 request id，并把已验证收回', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({
      kind: 'status',
      status: 401,
      headers: { 'x-request-id': 'req-e2e-401' }
    })
    seedModelProvider(databaseFile(userDataDirectory), {
      id: 'provider-failing',
      providerKey: 'failing-relay',
      displayName: '失败中转',
      baseUrl: stub.baseUrl,
      modelId: 'relay-failing-model',
      authMode: 'env',
      envVar: 'E2E_TEST_KEY',
      verification: 'verified'
    })

    const handle = await launch({ env: localEnv })
    const { page } = handle
    await openSettings(page)
    const card = page.locator('[data-provider-key="failing-relay"]')
    await expect(card).toContainText('已验证')

    await card.getByRole('button', { name: '测试连接 失败中转' }).click()

    await expect(card).toContainText('未验证')
    await expect(card.locator('.profile-check')).toContainText('密钥无效')
    await expect(card.locator('.profile-check')).toContainText('请求 ID req-e2e-401')
    await expect(card.locator('[data-test-result="provider-failing"]')).toContainText(
      '测试没通过：密钥无效 · 请求 ID req-e2e-401'
    )

    await handle.close()
    const database = new Database(databaseFile(userDataDirectory), {
      readonly: true,
      fileMustExist: true
    })
    try {
      const row = database
        .prepare(
          `SELECT verification, last_error, base_url, auth_mode, env_var, secret_ciphertext
             FROM model_provider WHERE provider_key = 'failing-relay'`
        )
        .get() as Record<string, unknown>
      expect(row).toMatchObject({
        verification: 'unverified',
        base_url: stub.baseUrl,
        auth_mode: 'env',
        env_var: 'E2E_TEST_KEY',
        secret_ciphertext: null
      })
      expect(JSON.parse(String(row.last_error))).toEqual({
        reason: 'invalid-key',
        requestId: 'req-e2e-401'
      })
    } finally {
      database.close()
    }
  })
})

test.describe('真实对话与验证状态', () => {
  test('对话成功转已验证；之后失败只记录最后错误，不降级已验证', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['真实回答。'] })
    seedModelProvider(databaseFile(userDataDirectory), {
      id: 'provider-chat',
      providerKey: 'chat-relay',
      displayName: '对话中转',
      baseUrl: stub.baseUrl,
      modelId: 'relay-chat-model',
      authMode: 'env',
      envVar: 'E2E_TEST_KEY',
      verification: 'unverified'
    })

    const handle = await launch({ env: localEnv })
    const { page } = handle
    await openChat(page)
    await ask(page, '第一问')
    await expect(page.getByText('真实回答。').first()).toBeVisible()

    await openSettings(page)
    const card = page.locator('[data-provider-key="chat-relay"]')
    await expect(card).toContainText('已验证')

    // 服务端故障的真实对话：只记录最后错误，不把已验证降级。
    stub.setScript({
      kind: 'status',
      status: 500,
      headers: { 'x-request-id': 'req-e2e-500' }
    })
    await openChat(page)
    await ask(page, '第二问')
    await expect(page.getByText(/服务繁忙/).first()).toBeVisible()

    await openSettings(page)
    await expect(card).toContainText('已验证')
    await expect(card.locator('.profile-check')).toContainText('最近一次失败')
    await expect(card.locator('.profile-check')).toContainText('服务繁忙')
    await expect(card.locator('.profile-check')).toContainText('请求 ID req-e2e-500')

    await handle.close()
    const database = new Database(databaseFile(userDataDirectory), {
      readonly: true,
      fileMustExist: true
    })
    try {
      const row = database
        .prepare(
          `SELECT verification, last_error, last_verified_at
             FROM model_provider WHERE provider_key = 'chat-relay'`
        )
        .get() as Record<string, unknown>
      expect(row).toMatchObject({ verification: 'verified' })
      expect(row.last_verified_at).not.toBeNull()
      expect(JSON.parse(String(row.last_error))).toEqual({
        reason: 'server',
        requestId: 'req-e2e-500'
      })
    } finally {
      database.close()
    }
  })
})
