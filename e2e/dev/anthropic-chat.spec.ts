import {
  startAnthropicStub,
  type AnthropicStub,
  type AnthropicStubScript
} from '../../src/testing/anthropic-sse-stub'
import { expect, test } from '../fixtures/app'
import { ask, openChat, openSettings } from '../fixtures/chat'
import {
  openAddConnectionDetails,
  openManageModels,
  openProviderDetails,
  openProviderEditor
} from '../fixtures/settings-panel'

/**
 * #65 真实 Electron E2E：Anthropic Messages 走真实窗口、真实 pi 请求与本地
 * Anthropic SSE stub，不联网、不用真实密钥。
 */

const stubs: AnthropicStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: AnthropicStubScript): Promise<AnthropicStub> {
  const stub = await startAnthropicStub(script)
  stubs.push(stub)
  return stub
}

/** 挡住开发态 .env；本用例的密钥只从设置页保存进本机。 */
const noProviderEnv = {
  DEEPSEEK_API_KEY: '',
  ANTHROPIC_API_KEY: '',
  MINIMAX_API_KEY: ''
}

function requestPath(url: string): string {
  return url.split('?')[0] ?? url
}

test.describe('Anthropic Messages 内置入口', () => {
  test('保存 Anthropic、改端点、真流式思考/正文/停止、换默认模型后自动转已验证', async ({
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

    const handle = await launch({ env: noProviderEnv })
    const { page } = handle
    await openSettings(page)

    // 1. 从内置目录添加 Anthropic：端点与模型目录在折叠详情里带出。
    await page.getByLabel('内置提供商').selectOption('anthropic')
    await openAddConnectionDetails(page)
    const preview = page.locator('.builtin-preview')
    await expect(preview).toContainText('https://api.anthropic.com')
    await expect(preview).toContainText('claude-fable-5')

    await page.getByLabel('API 密钥').fill('sk-ant-e2e-0001')
    await page.getByRole('button', { name: '保存提供商' }).click()
    await expect(page.getByRole('status')).toContainText('已保存')
    await expect(page.getByLabel('API 密钥')).toHaveValue('')

    const card = page.locator('[data-provider-key="anthropic"]')
    await expect(card).toContainText('Anthropic')
    await expect(card).toContainText('未验证')
    await openProviderDetails(card)
    await expect(card).toContainText('Anthropic Messages')
    await expect(card).toContainText('sk-·············0001')
    await openManageModels(card)
    await expect(card).toContainText('上下文 1,000,000 · 输出 128,000 · 支持思考')
    await expect(
      card.locator('[data-model-row="claude-fable-5"] input[type="radio"]')
    ).toBeChecked()

    // 2. 用户可把内置入口的地址改成中转/本地；保存后状态回到未验证。
    await openProviderEditor(card)
    await card.getByLabel('编辑接口地址').fill(stub.baseUrl)
    await card.getByRole('button', { name: '保存修改' }).click()
    await expect(page.getByRole('status')).toContainText('新地址')
    await openProviderDetails(card)
    await expect(card).toContainText(stub.baseUrl)

    // 3. 首套保存已自动使用中；真实流式：思维链先到、正文后到，请求带 x-api-key。
    await expect(card).toContainText('使用中')

    await openChat(page)
    await ask(page, '第一问')
    await expect(page.getByText(/正在思考…/)).toBeVisible()
    await expect(page.getByText('答案来了。').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /已思考 [1-9]\d* 秒/ })).toBeVisible()

    await expect.poll(() => stub.requests.length).toBe(1)
    const firstRequest = stub.requests[0]
    expect(requestPath(firstRequest?.url ?? '')).toBe('/v1/messages')
    expect(firstRequest?.headers['x-api-key']).toBe('sk-ant-e2e-0001')
    expect(firstRequest?.headers.authorization).toBeUndefined()
    expect(firstRequest?.headers['anthropic-version']).toBe('2023-06-01')
    expect(firstRequest?.body).toMatchObject({
      model: 'claude-fable-5',
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' }
    })

    // 真实成功一次后自动转已验证。
    await openSettings(page)
    await expect(card).toContainText('已验证')

    // 4. 换默认模型：下一次才用新模型，旧回答保留。
    await openManageModels(card)
    const sonnetRadio = card.locator('[data-model-row="claude-sonnet-5"] input[type="radio"]')
    // 受控单选：点击后等异步保存再重渲染；不要用 check() 的即时状态假设。
    await sonnetRadio.click()
    await expect(sonnetRadio).toBeChecked()
    await openChat(page)
    await ask(page, '第二问')
    await expect.poll(() => stub.requests.length).toBe(2)
    expect(stub.requests[1]?.body.model).toBe('claude-sonnet-5')
    await expect(page.getByText('答案来了。')).toHaveCount(2)

    // 5. 停止：已输出内容保留，界面标「已停止 · 未完成」，不再补 error 或 done。
    stub.setScript({
      kind: 'hang',
      thinking: ['想一下。'],
      text: ['先写到这里']
    })
    await ask(page, '写一半停下')
    await expect(page.getByText('先写到这里')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText('已停止 · 未完成')).toBeVisible()
    await expect(page.getByText('先写到这里')).toBeVisible()
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
    await expect.poll(() => stub.abortedConnections).toBe(1)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(stub.requests[2]?.body.model).toBe('claude-sonnet-5')

    // 重启后 provider、默认模型与验证状态都在。
    await handle.close()
    const reopened = await launch({ userDataDirectory, env: noProviderEnv })
    await openSettings(reopened.page)
    const reopenedCard = reopened.page.locator('[data-provider-key="anthropic"]')
    await expect(reopenedCard).toContainText('已验证')
    await openProviderDetails(reopenedCard)
    await expect(reopenedCard).toContainText('Anthropic Messages')
    await openManageModels(reopenedCard)
    await expect(
      reopenedCard.locator('[data-model-row="claude-sonnet-5"] input[type="radio"]')
    ).toBeChecked()
  })
})

test.describe('自定义 Anthropic Messages 协议', () => {
  test('协议下拉开放 Anthropic Messages；模型行使用该协议，真实请求带 x-api-key 且不传 thinking', async ({
    launch
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['自定义中转可用。'] })
    const { page } = await launch({ env: noProviderEnv })
    await openSettings(page)

    await page.getByRole('button', { name: '自定义 API' }).click()
    const form = page.locator('[data-custom-provider-form="true"]')
    await expect(form).toBeVisible()

    // 协议选项来自共享协议表：Anthropic Messages 已开放，不带「后续版本」。
    const protocol = form.getByLabel('协议')
    await expect(protocol.locator('option[value="anthropic-messages"]')).toBeEnabled()
    await expect(protocol.locator('option[value="anthropic-messages"]')).not.toContainText(
      '后续版本'
    )

    await form.getByLabel('Provider ID').fill('my-anthropic')
    await form.getByLabel('显示名').fill('我的 Anthropic')
    await protocol.selectOption('anthropic-messages')
    await form.getByLabel('自定义接口地址').fill(stub.baseUrl)
    await form.getByLabel('自定义 API 密钥').fill('sk-custom-ant-0001')
    await form.getByLabel('首个模型 ID').fill('relay-anthropic-model')
    await form.getByRole('button', { name: '保存自定义提供商' }).click()
    await expect(page.getByRole('status')).toContainText('已保存自定义提供商')

    const card = page.locator('[data-provider-key="my-anthropic"]')
    await expect(card).toContainText('我的 Anthropic')
    await expect(card).toContainText('使用中')
    await openProviderDetails(card)
    await expect(card).toContainText('Anthropic Messages')
    await openManageModels(card)
    await expect(card.locator('[data-model-row="relay-anthropic-model"]')).toContainText(
      '不在目录'
    )

    // 使用中后真实发请求：模型行按 anthropic-messages 派发，鉴权走 x-api-key。
    await openChat(page)
    await ask(page, '用自定义协议回答')
    await expect(page.getByText('自定义中转可用。')).toBeVisible()

    await expect.poll(() => stub.requests.length).toBe(1)
    const request = stub.requests[0]
    expect(requestPath(request?.url ?? '')).toBe('/v1/messages')
    expect(request?.headers['x-api-key']).toBe('sk-custom-ant-0001')
    expect(request?.headers.authorization).toBeUndefined()
    expect(request?.body.model).toBe('relay-anthropic-model')
    // 目录里没有这个模型：按非思考模型发送，不塞 thinking / output_config。
    expect(request?.body.thinking).toBeUndefined()
    expect(request?.body.output_config).toBeUndefined()

    await openSettings(page)
    await expect(card).toContainText('已验证')
  })
})
