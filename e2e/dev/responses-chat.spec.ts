import type { Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import {
  startResponsesStub,
  type ResponsesStub,
  type ResponsesStubScript
} from '../../src/testing/responses-sse-stub'
import { expect, test } from '../fixtures/app'

/**
 * #67 OpenAI Responses 的真实 Electron UI 用例。
 *
 * 不联网：OpenAI 内置入口只做本地保存；聊天把地址指到本机 Responses SSE stub，
 * 让主进程里的真实 pi 请求跑完整条链路。密钥全部是合成值。
 */

const stubs: ResponsesStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: ResponsesStubScript): Promise<ResponsesStub> {
  const stub = await startResponsesStub(script)
  stubs.push(stub)
  return stub
}

/** 挡住开发态 .env 的真实密钥；没有使用中的 provider 时也不能回退。 */
const noEnvironmentConfig = { DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '', XAI_API_KEY: '' }

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

test.describe('OpenAI Responses 协议', () => {
  test('内置 OpenAI / xAI 可添加；OpenAI 用默认模型真实流式，思考/正文/停止与验证状态都工作', async ({
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
    const handle = await launch({ env: noEnvironmentConfig })
    const { page } = handle
    await openSettings(page)

    // 自定义入口的协议下拉里，OpenAI Responses 已开放、不再标「后续版本」。
    await page.getByRole('button', { name: '自定义 API', exact: true }).click()
    const customForm = page.locator('[data-custom-provider-form="true"]')
    const protocol = customForm.getByLabel('协议')
    const responsesOption = protocol.locator('option[value="openai-responses"]')
    await expect(responsesOption).toBeEnabled()
    await expect(responsesOption).toContainText('OpenAI Responses')
    await expect(responsesOption).not.toContainText('后续版本')
    await page.getByRole('button', { name: '内置提供商', exact: true }).click()

    // 内置目录新增 OpenAI：自动带出官方地址、环境变量与 Responses 模型目录。
    await page.getByLabel('内置提供商').selectOption('openai')
    const preview = page.locator('.builtin-preview')
    await expect(preview).toContainText('https://api.openai.com/v1')
    await expect(preview).toContainText('OPENAI_API_KEY')
    await expect(preview).toContainText('chat-latest')
    await page.getByLabel('API 密钥').fill('sk-e2e-openai-0001')
    await page.getByRole('button', { name: '保存提供商' }).click()
    await expect(page.getByRole('status')).toContainText('已保存 OpenAI')

    const openai = page.locator('[data-provider-key="openai"]')
    await expect(openai).toContainText('OpenAI')
    await expect(openai).toContainText('OpenAI Responses')
    await expect(openai).toContainText('未验证')
    await expect(openai).toContainText('内置目录 · openai')
    await expect(openai.locator('[data-model-row="chat-latest"]')).toBeVisible()
    await expect(openai.locator('[data-model-row="gpt-5"]')).toBeVisible()
    await expect(
      openai.locator('[data-model-row="chat-latest"]').getByRole('radio')
    ).toBeChecked()
    // 密钥只显示掩码，页面没有明文。
    await expect(openai).toContainText('sk-·············0001')
    expect(await page.locator('body').innerText()).not.toContain('sk-e2e-openai-0001')

    // 内置目录新增 xAI：同样是 OpenAI Responses，带自己的端点与模型。
    await page.getByLabel('内置提供商').selectOption('xai')
    await expect(preview).toContainText('https://api.x.ai/v1')
    await expect(preview).toContainText('XAI_API_KEY')
    await expect(preview).toContainText('grok-4.3')
    await page.getByLabel('API 密钥').fill('sk-e2e-xai-0002')
    await page.getByRole('button', { name: '保存提供商' }).click()
    await expect(page.getByRole('status')).toContainText('已保存 xAI')

    const xai = page.locator('[data-provider-key="xai"]')
    await expect(xai).toContainText('xAI')
    await expect(xai).toContainText('OpenAI Responses')
    await expect(xai).toContainText('XAI_API_KEY')
    await expect(xai.locator('[data-model-row="grok-4.3"]')).toBeVisible()
    await expect(
      xai.locator('[data-model-row="grok-4.3"]').getByRole('radio')
    ).toBeChecked()

    // 选默认模型 gpt-5，再设为使用中。
    await openai.locator('[data-model-row="gpt-5"]').getByRole('radio').check()
    await expect(
      openai.locator('[data-model-row="gpt-5"]').getByRole('radio')
    ).toBeChecked()
    await openai.getByRole('button', { name: '使用这个' }).click()
    await expect(openai).toContainText('使用中')

    // 地址只在用例内改成本机 stub：不联网，但走真实的 pi Responses 请求。
    const liveDatabase = new Database(databaseFile(userDataDirectory))
    try {
      liveDatabase
        .prepare("UPDATE model_provider SET base_url = ? WHERE provider_key = 'openai'")
        .run(`${stub.baseUrl}/v1`)
      expect(
        liveDatabase
          .prepare("SELECT secret_ciphertext FROM model_provider WHERE provider_key = 'openai'")
          .get()
      ).toMatchObject({ secret_ciphertext: expect.stringMatching(/^dpapi:v1:/) })
    } finally {
      liveDatabase.close()
    }

    // 真实请求 + 思维链/正文 UI。
    await openChat(page)
    await ask(page, '第一问')
    await expect(page.getByText(/正在思考…/)).toBeVisible()
    await expect(page.getByText('答案来了。').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /已思考 [1-9]\d* 秒/ })).toBeVisible()

    await expect.poll(() => stub.requests.length).toBe(1)
    const firstRequest = stub.requests[0]
    expect(firstRequest?.url).toBe('/v1/responses')
    expect(firstRequest?.headers.authorization).toBe('Bearer sk-e2e-openai-0001')
    expect(firstRequest?.body).toMatchObject({
      model: 'gpt-5',
      stream: true,
      store: false,
      reasoning: { effort: 'high', summary: 'auto' }
    })
    expect(firstRequest?.body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: '第一问' }] }
    ])

    // 一次真实成功之后自动转已验证。
    await openSettings(page)
    await expect(page.locator('[data-provider-key="openai"]')).toContainText('已验证')

    // 停止：保留已输出正文与思维链，不上报错误。
    await stub.setScript({ kind: 'hang', thinking: ['想一下。'], text: ['先写到这里'] })
    await openChat(page)
    await ask(page, '第二问')
    await expect(page.getByText('先写到这里').first()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText('已停止 · 未完成')).toBeVisible()
    await expect.poll(() => stub.abortedConnections).toBe(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(stub.requests[1]?.body.model).toBe('gpt-5')

    // 重启后 OpenAI / xAI 配置、默认模型与验证状态都还在。
    await handle.close()
    const reopened = await launch({
      userDataDirectory,
      env: noEnvironmentConfig
    })
    await openSettings(reopened.page)
    const reopenedOpenai = reopened.page.locator('[data-provider-key="openai"]')
    await expect(reopenedOpenai).toContainText('使用中')
    await expect(reopenedOpenai).toContainText('已验证')
    await expect(
      reopenedOpenai.locator('[data-model-row="gpt-5"]').getByRole('radio')
    ).toBeChecked()
    await expect(reopened.page.locator('[data-provider-key="xai"]')).toBeVisible()
  })

  test('自定义 API 选 OpenAI Responses：保存后 provider 与模型行都记成该协议', async ({
    launch,
    userDataDirectory
  }) => {
    const handle = await launch({ env: noEnvironmentConfig })
    const { page } = handle
    await openSettings(page)

    await page.getByRole('button', { name: '自定义 API', exact: true }).click()
    const form = page.locator('[data-custom-provider-form="true"]')
    const protocol = form.getByLabel('协议')
    await protocol.selectOption('openai-responses')
    await expect(protocol).toHaveValue('openai-responses')

    await form.getByLabel('Provider ID').fill('responses-relay')
    await form.getByLabel('显示名').fill('Responses 中转')
    await form.getByLabel('自定义接口地址').fill('https://relay.invalid/v1')
    await form.getByLabel('自定义 API 密钥').fill('sk-e2e-responses-0003')
    await form.getByLabel('首个模型 ID').fill('gpt-5')
    await form.getByRole('button', { name: '保存自定义提供商' }).click()
    await expect(page.getByRole('status')).toContainText('已保存自定义提供商')

    const card = page.locator('[data-provider-key="responses-relay"]')
    await expect(card).toContainText('Responses 中转')
    await expect(card).toContainText('OpenAI Responses')
    await expect(card.locator('[data-model-row="gpt-5"]')).toBeVisible()
    await expect(card).toContainText('未验证')
    await card.getByRole('button', { name: '使用这个' }).click()
    await expect(card).toContainText('使用中')

    // 外部行为落库：协议与模型行的 api 都是 openai-responses，密钥只有密文。
    const stored = new Database(databaseFile(userDataDirectory), {
      readonly: true,
      fileMustExist: true
    })
    try {
      expect(
        stored
          .prepare('SELECT protocol FROM model_provider WHERE provider_key = ?')
          .get('responses-relay')
      ).toEqual({ protocol: 'openai-responses' })
      expect(
        stored
          .prepare(
            `SELECT m.api FROM model_provider_model m
               JOIN model_provider p ON p.id = m.provider_id
              WHERE p.provider_key = ?`
          )
          .get('responses-relay')
      ).toEqual({ api: 'openai-responses' })
      expect(
        stored
          .prepare('SELECT secret_ciphertext FROM model_provider WHERE provider_key = ?')
          .get('responses-relay')
      ).toMatchObject({ secret_ciphertext: expect.stringMatching(/^dpapi:v1:/) })
    } finally {
      stored.close()
    }
    expect(await page.locator('body').innerText()).not.toContain('sk-e2e-responses-0003')
  })
})
