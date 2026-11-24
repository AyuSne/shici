import {
  startGeminiSseStub,
  type GeminiSseStub,
  type GeminiStubScript
} from '../../src/testing/gemini-sse-stub'
import { expect, test } from '../fixtures/app'
import { ask, openChat, openSettings } from '../fixtures/chat'
import {
  openAddConnectionDetails,
  openManageModels,
  openProviderDetails,
  openProviderEditor
} from '../fixtures/settings-panel'

const stubs: GeminiSseStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: GeminiStubScript): Promise<GeminiSseStub> {
  const stub = await startGeminiSseStub(script)
  stubs.push(stub)
  return stub
}

/** 挡住开发态 .env：本用例只验证界面里存下的合成密钥，不联网。 */
const noEnvironmentConfig = { DEEPSEEK_API_KEY: '', GEMINI_API_KEY: '' }
const syntheticKey = 'sk-e2e-gemini-1111'

test.describe('Google Gemini 内置入口与聊天', () => {
  test('从内置目录添加 Gemini、选默认模型、真流式思考与正文、停止、自定义协议可用', async ({
    launch
  }) => {
    const stub = await createStub({
      kind: 'stream',
      thinking: ['先想一下。', '再想一下。'],
      text: ['答案来了。'],
      firstChunkDelayMs: 400,
      textDelayMs: 1200,
      chunkDelayMs: 10
    })

    const { page } = await launch({ env: noEnvironmentConfig })
    await openSettings(page)

    // 内置目录已经出现 Google Gemini，并在折叠详情里带出官方端点与 Gemini 协议模型。
    await page.getByLabel('内置提供商').selectOption('gemini')
    await openAddConnectionDetails(page)
    const preview = page.locator('.builtin-preview')
    await expect(preview).toContainText('https://generativelanguage.googleapis.com/v1beta')
    await expect(preview).toContainText('gemini-2.5-flash')

    await page.getByLabel('API 密钥').fill(syntheticKey)
    await page.getByRole('button', { name: '保存提供商' }).click()
    await expect(page.getByRole('status')).toContainText('已保存')

    const card = page.locator('[data-provider-key="gemini"]')
    await expect(card).toContainText('Google Gemini')
    await expect(card).toContainText('未验证')
    await openProviderDetails(card)
    await expect(card).toContainText('Gemini API')
    await expect(card).toContainText('sk-·············1111')

    // 把地址指到本地 stub（保存地址不联网），并选 gemini-2.5-flash 为默认模型。
    await openProviderEditor(card)
    await card.getByLabel('编辑接口地址').fill(`${stub.baseUrl}/v1beta`)
    await card.getByRole('button', { name: '保存修改' }).click()
    await expect(page.getByRole('status')).toContainText('新地址')

    await openManageModels(card)
    const flash = card.locator('[data-model-row="gemini-2.5-flash"] input[type="radio"]')
    await flash.click()
    await expect(flash).toBeChecked()

    // 首套保存已自动使用中。
    await expect(card).toContainText('使用中')

    // 真实 Electron 里的真流式：思维链先到、正文后到，结束后折成「已思考 N 秒」。
    await openChat(page)
    await ask(page, '用 Gemini 解释这个词')
    await expect(page.getByText(/正在思考…/)).toBeVisible()
    await expect(page.getByText('答案来了。').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /已思考 [1-9]\d* 秒/ })).toBeVisible()

    await expect.poll(() => stub.requests.length).toBe(1)
    const request = stub.requests[0]!
    expect(request.method).toBe('POST')
    expect(request.url).toBe(
      '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse'
    )
    expect(request.headers['x-goog-api-key']).toBe(syntheticKey)
    expect(request.headers.authorization).toBeUndefined()
    expect(request.body).toMatchObject({
      generationConfig: {
        thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 }
      }
    })

    // 一次真实成功之后 provider 自动转已验证，界面仍只显示掩码。
    await openSettings(page)
    await expect(card).toContainText('已验证')
    await openProviderDetails(card)
    await expect(card).toContainText('sk-·············1111')
    await expect(page.locator('body')).not.toContainText(syntheticKey)

    // 自定义 API 的协议下拉里，四种协议在本批次都已启用。
    await page.getByRole('button', { name: '自定义 API' }).click()
    const form = page.locator('[data-custom-provider-form="true"]')
    const protocol = form.getByLabel('协议')
    await expect(protocol.locator('option')).toHaveCount(4)
    await expect(protocol.locator('option[value="google-generative-ai"]')).toBeEnabled()
    await expect(protocol.locator('option[value="google-generative-ai"]')).toHaveText(
      'Gemini API'
    )
    await expect(protocol.locator('option[value="openai-completions"]')).toBeEnabled()
    await expect(protocol.locator('option[value="anthropic-messages"]')).toBeEnabled()

    // Esc 停止：保留已输出内容、标「未完成」，不再补 error / done。
    stub.setScript({ kind: 'hang', thinking: ['再想。'], text: ['先写到这里'] })
    await openChat(page)
    await ask(page, '写一半停下')
    await expect(page.getByText('先写到这里')).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(page.getByText('已停止 · 未完成')).toBeVisible()
    await expect(page.getByText('先写到这里')).toBeVisible()
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
    await expect.poll(() => stub.abortedConnections).toBeGreaterThanOrEqual(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(stub.requests.length).toBe(2)

    // Gemini 的错误也走同一条稳定分类：Electron 里同样捕获到 429 与响应头 request id。
    // 429 是临时错误：默认 normal 会按 Retry-After（1s）重试 5 次才显示最终错误。
    stub.setScript({
      kind: 'status',
      status: 429,
      headers: { 'x-goog-request-id': 'req-e2e-gemini-429', 'retry-after': '1' }
    })
    await ask(page, '再问一次')
    await expect(page.getByText('请求太频繁（429）')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('请求 ID：req-e2e-gemini-429')).toBeVisible()
    // 前两次是成功/停止，429 共尝试 6 次。
    expect(stub.requests.length).toBe(8)
  })
})
