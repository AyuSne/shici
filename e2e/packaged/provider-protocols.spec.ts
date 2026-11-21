import { startAnthropicStub } from '../../src/testing/anthropic-sse-stub'
import { startGeminiSseStub } from '../../src/testing/gemini-sse-stub'
import { startResponsesStub } from '../../src/testing/responses-sse-stub'
import { startSseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { ask, openChat, openSettings } from '../fixtures/chat'
import { databasePath, seedModelProvider } from '../fixtures/database'
import type { ModelProtocol } from '../../src/shared/model-protocols'

/** 真正运行随包 ESM lazy 工厂，不能只用开发产物证明 dynamic import() 可用。 */
const protocols: ModelProtocol[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
]

for (const protocol of protocols) {
  test(`打包产物动态加载 ${protocol} 并完成本地流式请求`, async ({
    launch,
    userDataDirectory
  }) => {
    const script = { kind: 'stream' as const, text: [`随包 ${protocol} 回答成功。`] }
    const stub = protocol === 'anthropic-messages'
      ? await startAnthropicStub(script)
      : protocol === 'google-generative-ai'
        ? await startGeminiSseStub(script)
        : protocol === 'openai-responses'
          ? await startResponsesStub(script)
          : await startSseStub(script)
    try {
      const baseUrl = protocol === 'google-generative-ai'
        ? `${stub.baseUrl}/v1beta`
        : protocol === 'openai-responses'
          ? `${stub.baseUrl}/v1`
          : stub.baseUrl
      seedModelProvider(databasePath(userDataDirectory), {
        id: 'packaged-provider',
        providerKey: 'packaged-provider',
        displayName: '打包协议验收',
        protocol,
        baseUrl,
        modelId: 'fixture-model',
        authMode: 'env',
        envVar: 'E2E_PACKAGED_PROVIDER_KEY'
      })
      const { page } = await launch({
        packaged: true,
        env: { DEEPSEEK_API_KEY: '', E2E_PACKAGED_PROVIDER_KEY: 'synthetic-packaged-key' }
      })
      await openChat(page)
      await ask(page, '确认随包协议可以调用')
      await expect(page.getByText(`随包 ${protocol} 回答成功。`)).toBeVisible()
      await expect(page.getByRole('button', { name: '发送', exact: true })).toBeVisible()
      expect(stub.requests).toHaveLength(1)
      const headers = stub.requests[0]?.headers
      if (protocol === 'anthropic-messages') {
        expect(headers?.['x-api-key']).toBe('synthetic-packaged-key')
      } else if (protocol === 'google-generative-ai') {
        expect(headers?.['x-goog-api-key']).toBe('synthetic-packaged-key')
      } else {
        expect(headers?.authorization).toBe('Bearer synthetic-packaged-key')
      }
      await openSettings(page)
      await expect(page.locator('[data-provider-key="packaged-provider"]')).toContainText('已验证')
    } finally {
      await stub.close()
    }
  })
}
