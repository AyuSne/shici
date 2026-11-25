import Database from 'better-sqlite3'
import { startSseStub, type SseStub, type StubScript } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { openSettings } from '../fixtures/chat'
import { databasePath, seedBuiltinProvider } from '../fixtures/database'
import {
  copiedText,
  deleteProvider,
  openAddConnectionDetails,
  openManageModels,
  openProviderDetails,
  openProviderEditor,
  stubClipboard
} from '../fixtures/settings-panel'

/**
 * #84 设置页极简添加流、首套自动使用中、保存后立即测试与就地修复。
 * 完全离线：密钥是合成的，模型请求只发到本机 SSE stub。
 */

const stubs: SseStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: StubScript): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

/** 挡住开发态 .env，避免任何真实密钥被带进测试。 */
const noEnvironmentConfig = {
  DEEPSEEK_API_KEY: '',
  MOONSHOT_API_KEY: '',
  E2E_KIMI_KEY: ''
}

function pointProviderAtStub(
  userDataDirectory: string,
  providerKey: string,
  baseUrl: string
): void {
  const database = new Database(databasePath(userDataDirectory))
  try {
    database
      .prepare('UPDATE model_provider SET base_url = ? WHERE provider_key = ?')
      .run(baseUrl, providerKey)
  } finally {
    database.close()
  }
}

function countProviders(userDataDirectory: string): number {
  const database = new Database(databasePath(userDataDirectory), {
    readonly: true,
    fileMustExist: true
  })
  try {
    return (
      database.prepare('SELECT COUNT(*) AS count FROM model_provider').get() as {
        count: number
      }
    ).count
  } finally {
    database.close()
  }
}

test.describe('内置提供商的极简添加流', () => {
  test('默认只露选提供商 / 密钥 / 保存：本机模式没有环境变量输入，连接详情默认折叠', async ({
    launch
  }) => {
    const { page } = await launch({ env: noEnvironmentConfig })
    await openSettings(page)

    const form = page.locator('[data-add-mode="builtin"]')
    await expect(form.getByLabel('内置提供商')).toBeVisible()
    await expect(form.getByLabel('API 密钥')).toBeVisible()
    await expect(form.getByRole('button', { name: '保存提供商' })).toBeVisible()
    // 保存在本机时，环境变量名输入与相关说明完全不出现。
    await expect(form.getByLabel('环境变量名')).toHaveCount(0)
    await expect(form.getByText('DEEPSEEK_API_KEY')).toBeHidden()

    // 接口地址、协议、模型目录预览与 Provider ID 分配规则收在默认折叠区。
    const details = form.locator('details.add-connection-details')
    await expect(details).not.toHaveAttribute('open', '')
    const preview = form.locator('.builtin-preview')
    await expect(preview).toBeHidden()

    await openAddConnectionDetails(page)
    await expect(preview).toBeVisible()
    await expect(preview).toContainText('https://api.deepseek.com')
    await expect(preview).toContainText('OpenAI Chat Completions')
    await expect(preview).toContainText('deepseek-flash')
    await expect(preview).toContainText('保存后分配')
    await expect(preview).toContainText('唯一且不可改')

    // 只有切到「使用环境变量」才出现变量名输入；切回来立即收起。
    await form.getByRole('radio', { name: '使用环境变量' }).check()
    await expect(form.getByLabel('环境变量名')).toBeVisible()
    await expect(form.getByLabel('环境变量名')).toHaveValue('DEEPSEEK_API_KEY')
    await expect(form.getByLabel('API 密钥')).toHaveCount(0)

    await form.getByRole('radio', { name: '保存在本机' }).check()
    await expect(form.getByLabel('环境变量名')).toHaveCount(0)
    await expect(form.getByLabel('API 密钥')).toBeVisible()
  })

  test('自定义提供商保存同样零 HTTP；Toast 立即测试连接才发请求', async ({ launch }) => {
    const stub = await createStub({ kind: 'stream', text: ['ok'] })
    const { page } = await launch({ env: noEnvironmentConfig })
    await openSettings(page)

    await page.getByRole('button', { name: '自定义 API', exact: true }).click()
    const form = page.locator('[data-custom-provider-form="true"]')
    await form.getByLabel('Provider ID').fill('quiet-relay')
    await form.getByLabel('显示名').fill('安静中转')
    await form.getByLabel('自定义接口地址').fill(stub.baseUrl)
    await form.getByLabel('自定义 API 密钥').fill('sk-e2e-custom-quiet-0006')
    await form.getByLabel('首个模型 ID').fill('quiet-model')
    await form.getByRole('button', { name: '保存自定义提供商' }).click()

    const toast = page.locator('.toast')
    await expect(toast).toContainText('已保存自定义提供商')
    await expect(page.locator('[data-provider-key="quiet-relay"]')).toContainText('使用中')
    // 保存只写本机：stub 一个请求都没收到。
    expect(stub.requests).toHaveLength(0)

    await toast.getByRole('button', { name: '立即测试连接' }).click()
    await expect.poll(() => stub.requests.length).toBe(1)
    expect(stub.requests[0]?.body.model).toBe('quiet-model')
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-e2e-custom-quiet-0006')
  })

  test('首套保存自动使用中、保存零 HTTP；Toast 立即测试连接只测刚保存的那套', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['ok'] })
    const handle = await launch({ env: noEnvironmentConfig })
    const { page, electronApp } = handle
    if (electronApp === null) throw new Error('本用例需要真实开发态窗口')
    await openSettings(page)

    // 主进程里记录真实的网络调用：保存只写本机，不应出现任何 fetch。
    await electronApp.evaluate(() => {
      const store = globalThis as unknown as {
        __fetchCalls?: string[]
        fetch: typeof fetch
      }
      store.__fetchCalls = []
      const original = store.fetch
      store.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        store.__fetchCalls?.push(String(input))
        return original(input, init)
      }) as typeof fetch
    })
    const fetchCalls = (): Promise<number> =>
      electronApp.evaluate(() => {
        const store = globalThis as unknown as { __fetchCalls?: string[] }
        return store.__fetchCalls?.length ?? 0
      })

    await page.getByLabel('内置提供商').selectOption('deepseek')
    await page.getByLabel('API 密钥').fill('sk-e2e-first-0001')
    await page.getByRole('button', { name: '保存提供商' }).click()

    const toast = page.locator('.toast')
    await expect(toast).toContainText('已保存')
    await expect(toast).toContainText('使用中')
    const card = page.locator('[data-provider-key="deepseek"]')
    await expect(card).toContainText('使用中')
    await expect(card.getByRole('button', { name: '设为使用中' })).toHaveCount(0)

    // 保存本身零网络；状态只是「未验证」。
    expect(await fetchCalls()).toBe(0)
    await expect(card).toContainText('未验证')
    expect(stub.requests).toHaveLength(0)

    // 把地址指到本机 stub 后点击 Toast 的立即测试：发一次真实请求。
    pointProviderAtStub(userDataDirectory, 'deepseek', stub.baseUrl)
    await expect(toast.getByRole('button', { name: '立即测试连接' })).toBeVisible()
    await toast.getByRole('button', { name: '立即测试连接' }).click()

    await expect.poll(() => stub.requests.length).toBe(1)
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-e2e-first-0001')
    expect(stub.requests[0]?.body.model).toBe('deepseek-flash')
    await expect(card).toContainText('已验证')
    expect(await fetchCalls()).toBeGreaterThanOrEqual(1)
  })

  test('保存后的立即测试绑定该提供商：展开另一张卡的凭据编辑也不会测错', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['ok'] })
    // 先有一套使用中的 Kimi，再从界面保存一套 DeepSeek（不抢当前使用中）。
    seedBuiltinProvider(databasePath(userDataDirectory), {
      catalogProviderId: 'kimi',
      baseUrl: stub.baseUrl,
      envVar: 'E2E_KIMI_KEY',
      active: true
    })
    const handle = await launch({
      env: { ...noEnvironmentConfig, E2E_KIMI_KEY: 'sk-env-kimi-0002' }
    })
    const { page } = handle
    await openSettings(page)

    await page.getByLabel('内置提供商').selectOption('deepseek')
    await page.getByLabel('API 密钥').fill('sk-e2e-binding-0003')
    await page.getByRole('button', { name: '保存提供商' }).click()
    const deepseek = page.locator('[data-provider-key="deepseek"]')
    await expect(deepseek).toContainText('未验证')

    // 打开另一张卡（Kimi）的凭据编辑，再点保存 DeepSeek 的 Toast 动作。
    const kimi = page.locator('[data-provider-key="kimi"]')
    await kimi.getByRole('button', { name: '编辑凭据' }).click()
    await expect(kimi.locator('[data-credential-editor-for="kimi"]')).toBeVisible()
    await expect(kimi.getByRole('radio', { name: '使用环境变量' })).toBeChecked()

    pointProviderAtStub(userDataDirectory, 'deepseek', stub.baseUrl)
    await page
      .locator('.toast')
      .getByRole('button', { name: '立即测试连接' })
      .click()

    await expect.poll(() => stub.requests.length).toBe(1)
    expect(stub.requests[0]?.body.model).toBe('deepseek-flash')
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-e2e-binding-0003')
    await expect(deepseek).toContainText('已验证')
  })

  test('立即测试迟到时提供商已被删除：结果不写回卡片', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({
      kind: 'stream',
      text: ['late'],
      firstChunkDelayMs: 1200
    })
    const handle = await launch({ env: noEnvironmentConfig })
    const { page } = handle
    await openSettings(page)

    await page.getByLabel('内置提供商').selectOption('deepseek')
    await page.getByLabel('API 密钥').fill('sk-e2e-late-0004')
    await page.getByRole('button', { name: '保存提供商' }).click()
    const card = page.locator('[data-provider-key="deepseek"]')
    await expect(card).toContainText('使用中')

    pointProviderAtStub(userDataDirectory, 'deepseek', stub.baseUrl)
    await page.locator('.toast').getByRole('button', { name: '立即测试连接' }).click()
    await expect.poll(() => stub.requests.length).toBe(1)

    // 请求还在路上就把这套删掉：迟到结果不得再写回任何卡片状态。
    await deleteProvider(card)
    await expect(page.locator('[data-provider-key="deepseek"]')).toHaveCount(0)
    await page.waitForTimeout(2200)

    await expect(page.locator('[data-provider-test-failure]')).toHaveCount(0)
    await expect(page.locator('.field-error')).toHaveCount(0)
    expect(countProviders(userDataDirectory)).toBe(0)
  })

  test('删掉使用中的提供商后再保存一套：按本票要求重新自动使用中并清掉提示', async ({
    launch,
    userDataDirectory
  }) => {
    seedBuiltinProvider(databasePath(userDataDirectory), {
      catalogProviderId: 'deepseek',
      baseUrl: 'https://unused.example.com/v1',
      envVar: 'DEEPSEEK_API_KEY',
      active: true
    })
    // 库里还有另一套未启用的 Kimi：删掉使用中那套后应明确提示「现在没有使用中的」。
    seedBuiltinProvider(databasePath(userDataDirectory), {
      catalogProviderId: 'kimi',
      baseUrl: 'https://unused.example.com/v1',
      envVar: 'MOONSHOT_API_KEY',
      active: false
    })
    const { page } = await launch({ env: noEnvironmentConfig })
    await openSettings(page)

    const deepseek = page.locator('[data-provider-key="deepseek"]')
    await deleteProvider(deepseek)
    await expect(page.locator('.settings-hint.is-warning')).toContainText(
      '现在没有使用中的提供商'
    )

    await page.getByLabel('内置提供商').selectOption('glm')
    await page.getByLabel('API 密钥').fill('sk-e2e-after-delete-0005')
    await page.getByRole('button', { name: '保存提供商' }).click()

    const glm = page.locator('[data-provider-key="glm"]')
    await expect(glm).toContainText('使用中')
    await expect(glm).toContainText('未验证')
    await expect(page.locator('.settings-hint.is-warning')).toHaveCount(0)
  })
})

test.describe('提供商卡片的精炼日常态', () => {
  test('默认模型下拉可直接切换且不展开完整目录；目录与连接详情默认折叠', async ({
    launch,
    userDataDirectory
  }) => {
    seedBuiltinProvider(databasePath(userDataDirectory), {
      catalogProviderId: 'deepseek',
      baseUrl: 'https://unused.example.com/v1',
      envVar: 'DEEPSEEK_API_KEY',
      active: true
    })
    const { page } = await launch({ env: noEnvironmentConfig })
    await openSettings(page)

    const card = page.locator('[data-provider-key="deepseek"]')
    await expect(card).toContainText('DeepSeek')
    await expect(card).toContainText('使用中')
    const defaultModel = card.getByLabel('默认模型 DeepSeek')
    await expect(defaultModel).toBeVisible()

    // 完整目录与连接详情都不在展开态；日常态不摊开技术参数。
    await expect(card.locator('.model-editor')).toHaveCount(0)
    await expect(card.locator('details.profile-details .profile-facts')).toBeHidden()
    await expect(card.locator('.profile-check')).toBeHidden()

    // 下拉换默认模型：立即保存，但绝不展开整个模型目录。
    const proValue = await defaultModel
      .locator('option', { hasText: 'deepseek-v4-pro' })
      .getAttribute('value')
    await defaultModel.selectOption({ label: 'deepseek-v4-pro' })
    await expect(page.locator('.toast')).toContainText('默认模型')
    await expect(card.locator('.model-editor')).toHaveCount(0)
    await expect(defaultModel).toHaveValue(proValue ?? '')

    // 点「管理模型」才展开完整目录，单选跟随刚才的快速选择。
    await expect(card.getByRole('button', { name: '管理模型', exact: true })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    await openManageModels(card)
    await expect(card.locator('[data-model-row]')).toHaveCount(2)
    await expect(
      card.getByRole('radio', { name: /deepseek-v4-pro/ })
    ).toBeChecked()

    // 连接详情同样按需展开，参数与验证记录都还在。
    await openProviderDetails(card)
    await expect(card.locator('details.profile-details .profile-facts')).toBeVisible()
    await expect(card).toContainText('内置目录 · deepseek')
    await expect(card).toContainText('还没校验过')
  })
})

test.describe('就地修复与诊断信息', () => {
  test('测试失败：自然中文原因、就地打开该卡凭据并预选本机；请求 ID 折叠可复制', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({
      kind: 'status',
      status: 401,
      headers: { 'x-request-id': 'req-e2e-401' }
    })
    seedBuiltinProvider(databasePath(userDataDirectory), {
      catalogProviderId: 'deepseek',
      baseUrl: stub.baseUrl,
      envVar: 'DEEPSEEK_API_KEY',
      active: true
    })
    const { page } = await launch({
      env: { ...noEnvironmentConfig, DEEPSEEK_API_KEY: 'sk-env-invalid' }
    })
    await openSettings(page)

    const card = page.locator('[data-provider-key="deepseek"]')
    await card.getByRole('button', { name: '测试连接 DeepSeek' }).click()

    const failure = card.locator('[data-provider-test-failure]')
    await expect(failure).toContainText('测试没通过：密钥无效')
    await expect(failure).not.toContainText('到设置')
    await expect(failure).not.toContainText('模型服务')
    // 主文案不含诊断字符：请求 ID 收在折叠诊断里。
    await expect(failure.locator('.profile-test-reason')).not.toContainText('请求 ID')

    const diagnostic = failure.locator('details.profile-diagnostic')
    await expect(diagnostic).not.toHaveAttribute('open', '')
    await expect(diagnostic.locator('.profile-diagnostic-id')).toBeHidden()
    await diagnostic.locator('summary').click()
    await expect(diagnostic).toContainText('req-e2e-401')

    await stubClipboard(page)
    await diagnostic.getByRole('button', { name: '复制请求 ID' }).click()
    await expect.poll(() => copiedText(page)).toBe('req-e2e-401')

    // 就地修复：直接打开这张卡的凭据编辑，且已预选「保存在本机」。
    await failure.getByRole('button', { name: '改用本机密钥' }).click()
    const editor = card.locator('[data-credential-editor-for="deepseek"]')
    await expect(editor).toBeVisible()
    await expect(editor.getByRole('radio', { name: '保存在本机' })).toBeChecked()
    await expect(editor.getByLabel('API 密钥')).toBeVisible()
  })

  test('凭据异常时卡片就地说明并给修复入口，不写路径指引', async ({
    launch,
    userDataDirectory
  }) => {
    seedBuiltinProvider(databasePath(userDataDirectory), {
      catalogProviderId: 'deepseek',
      baseUrl: 'https://unused.example.com/v1',
      envVar: 'E2E_MISSING_KEY',
      active: true
    })
    const { page } = await launch({ env: noEnvironmentConfig })
    await openSettings(page)

    const card = page.locator('[data-provider-key="deepseek"]')
    const issue = card.locator('[data-credential-issue="true"]')
    await expect(issue).toContainText('E2E_MISSING_KEY')
    await expect(issue).not.toContainText('到设置')
    await expect(issue).toContainText('改用本机密钥')

    await issue.getByRole('button', { name: '改用本机密钥' }).click()
    const editor = card.locator('[data-credential-editor-for="deepseek"]')
    await expect(editor.getByRole('radio', { name: '保存在本机' })).toBeChecked()
  })

  test('从卡片编辑连接仍走「更多」，不把低频维护动作摊在首页', async ({
    launch,
    userDataDirectory
  }) => {
    seedBuiltinProvider(databasePath(userDataDirectory), {
      catalogProviderId: 'deepseek',
      baseUrl: 'https://unused.example.com/v1',
      envVar: 'DEEPSEEK_API_KEY',
      active: true
    })
    const { page } = await launch({ env: noEnvironmentConfig })
    await openSettings(page)

    const card = page.locator('[data-provider-key="deepseek"]')
    await expect(card.getByLabel('编辑显示名')).toHaveCount(0)
    await openProviderEditor(card)
    await expect(card.getByLabel('编辑显示名')).toBeVisible()
    await expect(card.getByRole('group', { name: '重试策略' })).toBeVisible()
  })
})
