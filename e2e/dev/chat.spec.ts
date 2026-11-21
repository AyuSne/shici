import type { Page } from '@playwright/test'
import { expect, test, type AppHandle, type LaunchOptions } from '../fixtures/app'
import {
  startSseStub,
  unusedBaseUrl,
  type SseStub,
  type StubScript
} from '../../src/testing/sse-stub'

const stubs: SseStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: StubScript): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

function chatEnvironment(baseUrl: string): Record<string, string> {
  return {
    DEEPSEEK_BASE_URL: baseUrl,
    DEEPSEEK_API_KEY: 'e2e-test-key',
    DEEPSEEK_MODEL: 'deepseek-flash'
  }
}

async function openChat(
  launch: (options?: LaunchOptions) => Promise<AppHandle>,
  baseUrl: string
): Promise<Page> {
  const { page } = await launch({ env: chatEnvironment(baseUrl) })
  await expect(page.getByRole('heading', { name: '先读一篇' })).toBeVisible()
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '对话' })
    .click()
  await expect(page.getByRole('heading', { name: '新的学习' })).toBeVisible()
  return page
}

async function ask(page: Page, text = '给我两个例句'): Promise<void> {
  await page.getByRole('textbox', { name: '输入问题' }).fill(text)
  await page.getByRole('button', { name: '发送' }).click()
}

test.describe('空白线程的流式与思维链', () => {
  test('思维链先流出、正文后到并自动折起，请求显式带思考强度', async ({ launch }) => {
    const stub = await createStub({
      kind: 'stream',
      thinking: ['先想一下。'],
      text: ['答案来了。'],
      firstChunkDelayMs: 800,
      textDelayMs: 1200,
      chunkDelayMs: 10,
      fragmentChunks: true
    })
    const page = await openChat(launch, stub.baseUrl)

    await ask(page)

    await expect(page.locator('[aria-label="正在等待回答"]')).toBeVisible()
    await expect(page.getByText(/正在思考…/)).toBeVisible()
    await expect(page.getByText('答案来了。')).toBeVisible()

    const toggle = page.getByRole('button', { name: /已思考 [1-9]\d* 秒/ })
    await expect(toggle).toBeVisible()
    await expect(page.getByTestId('thinking-body')).toHaveCount(0)
    await expect(page.locator('[aria-label="正在等待回答"]')).toHaveCount(0)

    await expect.poll(() => stub.requests.length).toBe(1)
    const request = stub.requests[0]
    expect(request).toBeDefined()
    const body = request?.body ?? {}
    expect(body.model).toBe('deepseek-flash')
    expect(body.stream).toBe(true)
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
    expect(body.messages).toEqual([{ role: 'user', content: '给我两个例句' }])
  })

  test('Esc 停止后保留已输出内容并标「未完成」', async ({ launch }) => {
    const stub = await createStub({
      kind: 'hang',
      thinking: ['先想一下。'],
      text: ['先写到这里']
    })
    const page = await openChat(launch, stub.baseUrl)

    await ask(page)
    await expect(page.getByText('先写到这里')).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(page.getByText('已停止 · 未完成')).toBeVisible()
    await expect(page.getByText('先写到这里')).toBeVisible()
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
    await expect.poll(() => stub.abortedConnections).toBe(1)
  })

  const statusCases = [
    {
      status: 401,
      title: '密钥无效（401）',
      retryable: false,
      action: '下一步：到设置 → 模型服务里换一个有效的 API 密钥。',
      settings: true
    },
    {
      status: 402,
      title: '余额不足（402）',
      retryable: false,
      action: '下一步：换一个有余额的密钥后再来。',
      settings: true
    },
    {
      status: 413,
      title: '上下文过长（413）',
      retryable: false,
      action: '下一步：删减上下文后再发。',
      settings: false
    },
    { status: 429, title: '请求太频繁（429）', retryable: true },
    { status: 503, title: '服务繁忙（503）', retryable: true }
  ] as const

  for (const scenario of statusCases) {
    test(`HTTP ${scenario.status} 给出专属文案，只有可重试的显示重试`, async ({ launch }) => {
      const stub = await createStub({ kind: 'status', status: scenario.status })
      const page = await openChat(launch, stub.baseUrl)

      await ask(page)

      const alert = page.getByRole('alert')
      // 临时错误先自动重试 5 次（500ms→8s）才显示最终错误；不可重试的立刻出现。
      await expect(alert).toContainText(scenario.title, {
        timeout: scenario.retryable ? 30_000 : 10_000
      })
      if (scenario.retryable) {
        await expect(alert.getByRole('button', { name: '重试' })).toBeVisible()
        await expect.poll(() => stub.requests.length, { timeout: 30_000 }).toBe(6)
      } else {
        await expect(alert.getByRole('button', { name: '重试' })).toHaveCount(0)
        expect(stub.requests.length).toBe(1)
      }

      if ('action' in scenario) {
        await expect(alert).toContainText(scenario.action)
      }
      if ('settings' in scenario && scenario.settings) {
        await expect(alert.getByRole('button', { name: '去设置' })).toBeVisible()
      } else {
        await expect(alert.getByRole('button', { name: '去设置' })).toHaveCount(0)
      }

      if (scenario.status === 401) {
        await expect(alert).toContainText('请求 ID：stub-401')
      }

      if (scenario.status === 429) {
        stub.setScript({ kind: 'stream', thinking: ['想'], text: ['重试成功'] })
        await alert.getByRole('button', { name: '重试' }).click()
        await expect(page.getByText('重试成功')).toBeVisible()
        // 自动耗尽 6 次之后，用户手动重试是第 7 次请求。
        await expect.poll(() => stub.requests.length).toBe(7)
      }
    })
  }

  test('网络异常给出网络文案与重试', async ({ launch }) => {
    const page = await openChat(launch, await unusedBaseUrl())

    await ask(page)

    const alert = page.getByRole('alert')
    // TRANSPORT 也是临时错误：先自动重试 5 次，再显示最终的网络错误。
    await expect(alert).toContainText('网络异常', { timeout: 30_000 })
    await expect(alert).toContainText('没连上模型服务')
    await expect(alert.getByRole('button', { name: '重试' })).toBeVisible()
  })
})
