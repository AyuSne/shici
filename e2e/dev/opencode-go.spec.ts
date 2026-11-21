import Database from 'better-sqlite3'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/database'
import { startAnthropicStub, type AnthropicStub } from '../../src/testing/anthropic-sse-stub'
import { startGeminiSseStub, type GeminiSseStub } from '../../src/testing/gemini-sse-stub'
import { startResponsesStub, type ResponsesStub } from '../../src/testing/responses-sse-stub'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { ask, openChat, openSettings, seedAnsweredThread } from '../fixtures/chat'
import { databasePath } from '../fixtures/database'
import { seedOpenCodeGoProvider } from '../fixtures/opencode-go'

/**
 * #70 真实 Electron E2E：OpenCode GO 作为聚合入口走真实窗口、真实 pi 请求与
 * 本地四种协议 stub，不联网、不用真实密钥。覆盖 32 模型/各自协议/搜索/默认
 * 选取/只读/本地发现/流式思考正文停止/重启/删除不影响线程与钉住。
 */

type AnyStub = SseStub | AnthropicStub | GeminiSseStub | ResponsesStub

const stubs: AnyStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

/** 挡住开发态 .env；本用例的密钥只来自设置页或 E2E 启动环境。 */
const noProviderEnv = {
  DEEPSEEK_API_KEY: '',
  OPENCODE_GO_API_KEY: ''
}

test.describe('OpenCode GO 聚合入口', () => {
  test('从内置目录添加：32 个模型各自显示协议、可按 ID/显示名搜索、只读、选默认后重启保持', async ({
    launch,
    userDataDirectory
  }) => {
    const handle = await launch({ env: noProviderEnv })
    const { page } = handle
    await openSettings(page)

    // 1. 内置入口：聚合协议、无统一地址、32 个模型都来自生成目录。
    await page.getByLabel('内置提供商').selectOption('opencode-go')
    const preview = page.locator('.builtin-preview')
    await expect(preview).toContainText('各模型分别提供')
    await expect(preview).toContainText('多种协议')
    await expect(preview).toContainText('OPENCODE_GO_API_KEY')
    await expect(preview).toContainText('32 个模型')

    // 2. 填密钥保存：卡片出现，密钥只显示掩码，目录首版只读。
    await page.getByLabel('API 密钥').fill('sk-opencode-e2e-0001')
    await page.getByRole('button', { name: '保存提供商' }).click()
    await expect(page.getByRole('status')).toContainText('已保存 OpenCode GO')

    const card = page.locator('[data-provider-key="opencode-go"]')
    await expect(card).toContainText('OpenCode GO')
    await expect(card).toContainText('多种协议')
    await expect(card).toContainText('各模型分别提供')
    await expect(card).toContainText('32 个模型')
    await expect(card).toContainText('sk-·············0001')
    await expect(card).toContainText('OpenCode GO 的模型目录不可编辑')

    // 32 行模型都在，且各自显示自己的协议。
    await expect(card.locator('[data-model-row]')).toHaveCount(32)
    await expect(card.locator('[data-model-row] input[type="radio"]')).toHaveCount(32)
    await expect(card.locator('[data-model-row="beam-free"]')).toContainText(
      'OpenAI Chat Completions'
    )
    await expect(card.locator('[data-model-row="claude-haiku-5-5"]')).toContainText(
      'Anthropic Messages'
    )
    await expect(card.locator('[data-model-row="gpt-5.6-luna"]')).toContainText(
      'OpenAI Responses'
    )
    await expect(card.locator('[data-model-row="gemini-4-argon"]')).toContainText(
      'Gemini API'
    )

    // 3. 所有模型目录写控件都不可用：没有手加、编辑、删除、排序。
    await expect(card.getByLabel('添加模型 ID')).toHaveCount(0)
    await expect(card.getByRole('button', { name: /编辑模型/ })).toHaveCount(0)
    await expect(card.getByRole('button', { name: /移除模型/ })).toHaveCount(0)
    await expect(card.getByRole('button', { name: /上移模型/ })).toHaveCount(0)
    await expect(card.locator('.model-drag-handle')).toHaveCount(0)
    await expect(card.locator('[data-model-row="beam-free"]')).not.toHaveAttribute(
      'draggable',
      'true'
    )
    // 只读的是模型目录，不是 provider 本身：显示名与凭据仍可改。
    await expect(card.getByRole('button', { name: '编辑凭据' })).toBeEnabled()
    await expect(card.getByRole('button', { name: /^编辑提供商/ })).toBeEnabled()

    // 4. 搜索：按模型 ID 与显示名都能找到；清空后 32 行全回来。
    const search = card.getByLabel('搜索模型')
    await search.fill('qwen3.8-flash')
    await expect(card.locator('[data-model-row]')).toHaveCount(1)
    await expect(card.locator('[data-model-row="qwen3.8-flash"]')).toBeVisible()
    await search.fill('Claude Haiku 5.5')
    await expect(card.locator('[data-model-row]')).toHaveCount(1)
    await expect(card.locator('[data-model-row="claude-haiku-5-5"]')).toBeVisible()
    await search.fill('')
    await expect(card.locator('[data-model-row]')).toHaveCount(32)

    // 5. 选默认模型：单选立即保存，重启后仍是它。
    const geminiRadio = card.locator(
      '[data-model-row="gemini-4-argon"] input[type="radio"]'
    )
    await geminiRadio.click()
    await expect(geminiRadio).toBeChecked()

    // 6. 只改显示名也能保存：聚合入口不要求填一个假的统一地址。
    await card.getByRole('button', { name: '编辑提供商' }).click()
    await expect(card.getByLabel('编辑接口地址')).toHaveCount(0)
    await expect(card.locator('[data-aggregate-address="true"]')).toBeVisible()
    await card.getByLabel('编辑显示名').fill('团队 OpenCode GO')
    await card.getByRole('button', { name: '保存修改' }).click()
    await expect(page.getByRole('status')).toContainText('已保存「团队 OpenCode GO」')
    await expect(card).toContainText('团队 OpenCode GO')

    // 7. 重启：32 个模型、协议、显示名与默认模型都还在。
    await handle.close()
    const reopened = await launch({ userDataDirectory, env: noProviderEnv })
    await openSettings(reopened.page)
    const reopenedCard = reopened.page.locator('[data-provider-key="opencode-go"]')
    await expect(reopenedCard).toContainText('团队 OpenCode GO')
    await expect(reopenedCard).toContainText('多种协议')
    await expect(reopenedCard.locator('[data-model-row]')).toHaveCount(32)
    await expect(
      reopenedCard.locator('[data-model-row="gemini-4-argon"] input[type="radio"]')
    ).toBeChecked()
    await expect(reopenedCard.locator('[data-model-row="claude-haiku-5-5"]')).toContainText(
      'Anthropic Messages'
    )
  })

  test('真实流式（Gemini 模型）、本地发现零请求、停止保留已输出；删除 GO 不动历史线程与钉住', async ({
    launch,
    userDataDirectory
  }) => {
    const completions = await startSseStub({ kind: 'stream', text: ['不该走这里'] })
    const anthropic = await startAnthropicStub({ kind: 'stream', text: ['不该走这里'] })
    const responses = await startResponsesStub({ kind: 'stream', text: ['不该走这里'] })
    const gemini = await startGeminiSseStub({
      kind: 'stream',
      thinking: ['先想一下。'],
      text: ['答案来了。'],
      firstChunkDelayMs: 300,
      textDelayMs: 1200
    })
    stubs.push(completions, anthropic, responses, gemini)

    const file = databasePath(userDataDirectory)
    seedOpenCodeGoProvider(file, {
      envVar: 'E2E_GO_KEY',
      defaultModelName: 'gemini-4-argon',
      baseUrls: {
        'openai-completions': completions.baseUrl,
        'openai-responses': `${responses.baseUrl}/v1`,
        'anthropic-messages': anthropic.baseUrl,
        'google-generative-ai': `${gemini.baseUrl}/v1beta`
      }
    })

    // 历史线程与未归档钉住：删除 provider 之后必须原样保留。
    const database = openDatabase(file)
    try {
      const seeded = seedAnsweredThread(database, {
        question: '旧问题',
        answer: '旧回答',
        model: 'gemini-4-argon'
      })
      database
        .prepare(
          `INSERT INTO pin (
             id, thread_id, thread_title, answer_id, turn_index, model, captured_text,
             char_start, char_end, target_kind, created_at
           ) VALUES ('e2e-go-pin', ?, '新的学习', ?, 0, 'gemini-4-argon', '旧回答', 0, 3,
                     'unfiled', '2026-11-21T00:00:00.000Z')`
        )
        .run(seeded.threadId, seeded.answerId)
    } finally {
      database.close()
    }

    const handle = await launch({
      env: { ...noProviderEnv, E2E_GO_KEY: 'sk-go-e2e-0002' }
    })
    const { page } = handle
    await openSettings(page)
    const card = page.locator('[data-provider-key="opencode-go"]')
    await expect(card).toContainText('多种协议')
    await expect(card.locator('[data-model-row]')).toHaveCount(32)

    // 1. 获取可用模型只读本地目录：即使已配置 32 个模型也没有新候选，零 HTTP。
    await card.getByRole('button', { name: '编辑提供商' }).click()
    await card.getByRole('button', { name: '获取可用模型' }).click()
    await expect(card.locator('[data-discovery-empty="true"]')).toContainText(
      '没有可加入的新模型'
    )
    // 候选加入控件即使出现也不能用：只读目录没有可写的模型入口。
    await expect(card.getByRole('button', { name: '加入所选模型' })).toBeDisabled()
    expect(completions.requests).toHaveLength(0)
    expect(anthropic.requests).toHaveLength(0)
    expect(responses.requests).toHaveLength(0)
    expect(gemini.requests).toHaveLength(0)
    await card.getByRole('button', { name: '取消' }).click()

    // 2. 真实流式：默认模型是 Gemini 协议的 gemini-4-argon；思维链先、正文后。
    await openChat(page)
    await ask(page, '聚合入口怎么分派？')
    await expect(page.getByText(/正在思考…/)).toBeVisible()
    await expect(page.getByText('答案来了。').first()).toBeVisible()
    await expect(page.getByRole('button', { name: /已思考 [1-9]\d* 秒/ })).toBeVisible()

    await expect.poll(() => gemini.requests.length).toBe(1)
    expect(completions.requests).toHaveLength(0)
    expect(anthropic.requests).toHaveLength(0)
    expect(responses.requests).toHaveLength(0)
    const request = gemini.requests[0]!
    expect(request.url).toContain('/v1beta/models/gemini-4-argon:streamGenerateContent')
    expect(request.headers['x-goog-api-key']).toBe('sk-go-e2e-0002')

    // 3. 停止：保留已输出，标「已停止 · 未完成」，不再补 done / error。
    gemini.setScript({ kind: 'hang', thinking: ['想一下。'], text: ['先写到这里'] })
    await ask(page, '写一半停下')
    await expect(page.getByText('先写到这里')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByText('已停止 · 未完成')).toBeVisible()
    await expect(page.getByText('先写到这里')).toBeVisible()
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
    await expect.poll(() => gemini.abortedConnections).toBe(1)
    await expect(page.getByRole('alert')).toHaveCount(0)

    // 4. 成功一次后自动转已验证。
    await openSettings(page)
    await expect(card).toContainText('已验证')

    // 5. 删除使用中的 GO：选择清空，但历史线程与钉住快照都保留。
    await card.getByRole('button', { name: '删除' }).click()
    await expect(card).toContainText('删除当前提供商后，需要另选一套才能继续对话')
    await card.getByRole('button', { name: '确认删除' }).click()
    await expect(page.getByRole('status')).toContainText('已删除使用中的提供商')
    await expect(page.locator('.settings-empty')).toContainText('还没有模型提供商')

    await openChat(page)
    await expect(
      page
        .getByRole('complementary', { name: '对话列表' })
        .getByRole('button', { name: '未归档 1' })
    ).toBeVisible()
    await page.locator('.thread-row').filter({ hasText: '旧问题' }).click()
    await expect(page.getByText('旧回答')).toBeVisible()

    // 6. 资料库里 provider 与模型行已删，线程与钉住一条不少。
    await handle.close()
    const stored = new Database(join(userDataDirectory, 'english-learning.db'), {
      readonly: true,
      fileMustExist: true
    })
    try {
      expect(stored.prepare('SELECT COUNT(*) AS count FROM model_provider').get()).toEqual({
        count: 0
      })
      expect(
        stored.prepare('SELECT COUNT(*) AS count FROM model_provider_model').get()
      ).toEqual({ count: 0 })
      expect(stored.prepare('SELECT COUNT(*) AS count FROM pin').get()).toEqual({ count: 1 })
      expect(
        (stored.prepare('SELECT COUNT(*) AS count FROM thread').get() as { count: number })
          .count
      ).toBeGreaterThanOrEqual(2)
    } finally {
      stored.close()
    }

    // 7. 重启后仍没有配置，但旧线程照样能读。
    const reopened = await launch({ userDataDirectory, env: noProviderEnv })
    await openSettings(reopened.page)
    await expect(reopened.page.locator('.profile-card')).toHaveCount(0)
    await openChat(reopened.page)
    await reopened.page.locator('.thread-row').filter({ hasText: '旧问题' }).click()
    await expect(reopened.page.getByText('旧回答')).toBeVisible()
  })
})
