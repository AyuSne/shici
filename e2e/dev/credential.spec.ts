import type { Page } from '@playwright/test'
import Database from 'better-sqlite3'
import { startSseStub, type SseStub, type StubScript } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import {
  databasePath,
  seedLegacyModelProfiles,
  seedModelProvider
} from '../fixtures/database'

/**
 * #68 密钥来源三态：本机 / 环境变量 / 缺失。
 *
 * 不碰真实 .env、不联网：stub 是本机 SSE 服务，密钥都是合成的。
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

/** 空的 DEEPSEEK_API_KEY 挡住开发态 .env：这些用例从「没有环境变量退路」开始。 */
const noEnvironmentFallback = { DEEPSEEK_API_KEY: '' }

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

async function sendMessage(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: '输入问题' }).fill(text)
  await page.getByRole('button', { name: '发送' }).click()
}

/** 直接读本机库观察落库结果；只断言结构与有无密文，不打印任何密钥。 */
function readProviderRow(
  userDataDirectory: string,
  providerKey: string
): { auth_mode: string; env_var: string | null; secret_ciphertext: string | null } {
  const database = new Database(databasePath(userDataDirectory))
  try {
    const row = database
      .prepare(
        'SELECT auth_mode, env_var, secret_ciphertext FROM model_provider WHERE provider_key = ?'
      )
      .get(providerKey) as
      | { auth_mode: string; env_var: string | null; secret_ciphertext: string | null }
      | undefined
    if (row === undefined) throw new Error(`库里没有 provider ${providerKey}`)
    return row
  } finally {
    database.close()
  }
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

test.describe('密钥来源三态与凭据编辑', () => {
  test('内置提供商可以只引用环境变量：不落密文；环境变量缺失时发送明确点名变量', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['环境密钥可用。'] })
    const handle = await launch({
      env: { ...noEnvironmentFallback, E2E_ENV_KEY: 'sk-e2e-env-7777' }
    })
    const { page } = handle
    await openSettings(page)

    // 可选「使用环境变量」：不需要填密钥，变量名从目录默认值带出、可改。
    await page.getByLabel('内置提供商').selectOption('deepseek')
    await page.getByRole('radio', { name: '使用环境变量' }).check()
    await expect(page.getByLabel('API 密钥')).toHaveCount(0)
    const envVarInput = page.getByLabel('环境变量名')
    await expect(envVarInput).toHaveValue('DEEPSEEK_API_KEY')
    await envVarInput.fill('E2E_ENV_KEY')
    await page.getByRole('button', { name: '保存提供商' }).click()
    await expect(page.getByRole('status')).toContainText('未验证（保存时不联网）')

    const card = page.locator('[data-provider-key="deepseek"]')
    await expect(card).toContainText('环境 · E2E_ENV_KEY')
    await expect(card).toContainText('内置目录 · deepseek')

    // 环境模式不写密文，只保存变量引用。
    expect(readProviderRow(userDataDirectory, 'deepseek')).toEqual({
      auth_mode: 'env',
      env_var: 'E2E_ENV_KEY',
      secret_ciphertext: null
    })

    // 指向本地 stub 后，真的用环境变量里的合成密钥发一次。
    await card.getByRole('button', { name: '使用这个' }).click()
    await expect(card).toContainText('使用中')
    pointProviderAtStub(userDataDirectory, 'deepseek', stub.baseUrl)
    await openChat(page)
    await sendMessage(page, '用环境变量回答')
    await expect(page.getByText('环境密钥可用。')).toBeVisible()
    await expect.poll(() => stub.requests.length).toBe(1)
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-e2e-env-7777')

    // 重启时这个变量没有值：卡片显示缺失并带变量名，发送点名变量、不发请求。
    await handle.close()
    const reopened = await launch({ userDataDirectory, env: noEnvironmentFallback })
    await openSettings(reopened.page)
    const reopenedCard = reopened.page.locator('[data-provider-key="deepseek"]')
    await expect(reopenedCard).toContainText('缺失 · E2E_ENV_KEY')

    await openChat(reopened.page)
    await sendMessage(reopened.page, '这次应该失败')
    const error = reopened.page.locator('.message-error')
    await expect(error).toContainText('环境变量没有设置')
    await expect(error).toContainText('E2E_ENV_KEY')
    await expect(reopened.page.getByRole('button', { name: '去设置' })).toBeVisible()
    expect(stub.requests).toHaveLength(1)
  })

  test('本机密文解不开：设置照常打开并给动作提示；发送明确报错，修好后立刻可用', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['新密钥可用。'] })
    seedModelProvider(databasePath(userDataDirectory), {
      id: 'provider-broken',
      providerKey: 'broken-provider',
      displayName: 'Broken Provider',
      baseUrl: stub.baseUrl,
      modelId: 'deepseek-flash',
      authMode: 'stored',
      verification: 'verified'
    })
    // 造一份解不开的密文（真实 safeStorage 会把它当成坏值）。
    const database = new Database(databasePath(userDataDirectory))
    try {
      database
        .prepare(`UPDATE model_provider SET secret_ciphertext = 'not-a-dpapi-value' WHERE id = ?`)
        .run('provider-broken')
    } finally {
      database.close()
    }

    // 环境里另有可用的 DEEPSEEK_API_KEY：证明发送不会静默换源。
    const handle = await launch({
      env: {
        DEEPSEEK_API_KEY: 'sk-env-must-not-be-used',
        DEEPSEEK_BASE_URL: stub.baseUrl
      }
    })
    const { page } = handle
    await openSettings(page)
    const card = page.locator('[data-provider-key="broken-provider"]')
    await expect(card).toContainText('本机 · 解不开')
    await expect(card).toContainText('发送不会自动改用环境变量')
    await expect(card.getByRole('button', { name: '编辑凭据' })).toBeVisible()

    await openChat(page)
    await sendMessage(page, '坏密文')
    const error = page.locator('.message-error')
    await expect(error).toContainText('本机密钥解不开')
    await expect(error).toContainText('不会改用环境变量')
    expect(stub.requests).toHaveLength(0)

    // 编辑凭据重填一个新密钥；历史线程保留，随后能正常发送。
    await openSettings(page)
    await card.getByRole('button', { name: '编辑凭据' }).click()
    await expect(card.getByLabel('API 密钥')).toHaveAttribute(
      'placeholder',
      '本机密钥解不开，请重新填写'
    )
    await card.getByLabel('API 密钥').fill('sk-fixed-key-9999')
    await card.getByRole('button', { name: '保存凭据' }).click()
    await expect(card).toContainText('本机 · sk-·············9999')
    await expect(card).toContainText('未验证')
    expect(readProviderRow(userDataDirectory, 'broken-provider').secret_ciphertext).toMatch(
      /^dpapi:v1:/
    )

    await openChat(page)
    await sendMessage(page, '修好后再发')
    await expect(page.getByText('新密钥可用。')).toBeVisible()
    await expect.poll(() => stub.requests.length).toBe(1)
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-fixed-key-9999')

    // 线程历史没有被凭据编辑清掉。
    await expect(page.getByRole('heading', { name: '坏密文' })).toBeVisible()
  })

  test('本机切到环境变量：先确认；取消保持原配置，确认后清空密文并改用变量', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['切换后的回答。'] })
    const handle = await launch({
      env: { ...noEnvironmentFallback, E2E_SWITCH_KEY: 'sk-e2e-env-switch' }
    })
    const { page } = handle
    await openSettings(page)

    // 先用「保存在本机」存一把合成密钥。
    await page.getByLabel('内置提供商').selectOption('deepseek')
    await page.getByLabel('API 密钥').fill('sk-e2e-stored-1234')
    await page.getByRole('button', { name: '保存提供商' }).click()
    await expect(page.getByRole('status')).toContainText('未验证（保存时不联网）')
    const card = page.locator('[data-provider-key="deepseek"]')
    await expect(card).toContainText('本机 · sk-·············1234')
    await card.getByRole('button', { name: '使用这个' }).click()
    pointProviderAtStub(userDataDirectory, 'deepseek', stub.baseUrl)
    expect(readProviderRow(userDataDirectory, 'deepseek')).toMatchObject({
      auth_mode: 'stored',
      secret_ciphertext: expect.stringMatching(/^dpapi:v1:/)
    })

    // 切到环境变量：保存先弹确认；取消就保持原配置。
    await card.getByRole('button', { name: '编辑凭据' }).click()
    await card.getByRole('radio', { name: '使用环境变量' }).check()
    await card.getByLabel('环境变量名').fill('E2E_SWITCH_KEY')
    await card.getByRole('button', { name: '保存凭据' }).click()
    const confirm = card.locator('.profile-confirm')
    await expect(confirm).toContainText('清除这套本机已存的密钥')
    await expect(confirm).toContainText('取消则保持原配置')
    await confirm.getByRole('button', { name: '取消' }).click()

    await expect(card).toContainText('本机 · sk-·············1234')
    expect(readProviderRow(userDataDirectory, 'deepseek')).toMatchObject({
      auth_mode: 'stored',
      env_var: 'DEEPSEEK_API_KEY',
      secret_ciphertext: expect.stringMatching(/^dpapi:v1:/)
    })

    // 再切一次并确认：密文被清空，改成读环境变量。
    await card.getByRole('button', { name: '编辑凭据' }).click()
    await card.getByRole('radio', { name: '使用环境变量' }).check()
    await card.getByLabel('环境变量名').fill('E2E_SWITCH_KEY')
    await card.getByRole('button', { name: '保存凭据' }).click()
    await card
      .locator('.profile-confirm')
      .getByRole('button', { name: '确认清除并切换' })
      .click()

    await expect(card).toContainText('环境 · E2E_SWITCH_KEY')
    expect(readProviderRow(userDataDirectory, 'deepseek')).toEqual({
      auth_mode: 'env',
      env_var: 'E2E_SWITCH_KEY',
      secret_ciphertext: null
    })

    // 之后真的用环境变量里的那把密钥发请求。
    await openChat(page)
    await sendMessage(page, '切换后回答')
    await expect(page.getByText('切换后的回答。')).toBeVisible()
    await expect.poll(() => stub.requests.length).toBe(1)
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-e2e-env-switch')
  })

  test('迁移来的 custom provider 也能编辑凭据：坏密文可确认后改用环境变量', async ({
    launch,
    userDataDirectory
  }) => {
    seedLegacyModelProfiles(
      databasePath(userDataDirectory),
      [
        {
          id: 'profile-old',
          name: 'Old Backup',
          baseUrl: 'https://old.example.com/v1',
          model: 'old-model',
          apiKeySecret: 'dpapi:v1:not-decryptable'
        }
      ],
      'profile-old'
    )
    const handle = await launch({
      env: { ...noEnvironmentFallback, E2E_MIGRATED_KEY: 'sk-env-migrated' }
    })
    const { page } = handle
    await openSettings(page)

    const card = page.locator('.profile-card').filter({ hasText: 'Old Backup' })
    await expect(card).toContainText('自定义')
    await expect(card).toContainText('本机 · 解不开')
    await expect(card).toContainText('发送不会自动改用环境变量')

    // 迁移来的 custom 与内置走同一个凭据编辑器：先确认清除坏密文，再改用环境变量。
    await card.getByRole('button', { name: '编辑凭据' }).click()
    await card.getByRole('radio', { name: '使用环境变量' }).check()
    await card.getByLabel('环境变量名').fill('E2E_MIGRATED_KEY')
    await card.getByRole('button', { name: '保存凭据' }).click()
    await card
      .locator('.profile-confirm')
      .getByRole('button', { name: '确认清除并切换' })
      .click()

    await expect(card).toContainText('环境 · E2E_MIGRATED_KEY')
    expect(readProviderRow(userDataDirectory, 'old-backup')).toEqual({
      auth_mode: 'env',
      env_var: 'E2E_MIGRATED_KEY',
      secret_ciphertext: null
    })
  })

  test('自定义 API 可直接用环境变量创建（无需先存本机密钥），也能改回本机', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['自定义环境变量回答。'] })
    const handle = await launch({
      env: { ...noEnvironmentFallback, E2E_CUSTOM_ENV: 'sk-e2e-custom-env' }
    })
    const { page } = handle
    await openSettings(page)

    await page.getByRole('button', { name: '自定义 API', exact: true }).click()
    const form = page.locator('[data-custom-provider-form="true"]')
    await expect(form).toBeVisible()
    await form.getByLabel('Provider ID').fill('my-relay')
    await form.getByLabel('显示名').fill('我的中转')
    await form.getByLabel('自定义接口地址').fill(stub.baseUrl)
    await form.getByRole('radio', { name: '使用环境变量' }).check()
    await expect(form.getByLabel('自定义 API 密钥')).toHaveCount(0)
    await form.getByLabel('环境变量名').fill('E2E_CUSTOM_ENV')
    await form.getByLabel('首个模型 ID').fill('custom-env-model')
    await form.getByRole('button', { name: '保存自定义提供商' }).click()
    await expect(page.getByRole('status')).toContainText('未验证（保存时不联网）')

    const card = page.locator('[data-provider-key="my-relay"]')
    await expect(card).toContainText('环境 · E2E_CUSTOM_ENV')
    expect(readProviderRow(userDataDirectory, 'my-relay')).toEqual({
      auth_mode: 'env',
      env_var: 'E2E_CUSTOM_ENV',
      secret_ciphertext: null
    })

    // 自定义 provider 直接用环境变量发请求。
    await card.getByRole('button', { name: '使用这个' }).click()
    await openChat(page)
    await sendMessage(page, '自定义环境变量')
    await expect(page.getByText('自定义环境变量回答。')).toBeVisible()
    await expect.poll(() => stub.requests.length).toBe(1)
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-e2e-custom-env')

    // 再从环境变量改回本机：写一把新密钥，密文重新落库。
    await openSettings(page)
    await card.getByRole('button', { name: '编辑凭据' }).click()
    await card.getByRole('radio', { name: '保存在本机' }).check()
    await card.getByLabel('API 密钥').fill('sk-custom-stored-5555')
    await card.getByRole('button', { name: '保存凭据' }).click()
    await expect(card).toContainText('本机 · sk-·············5555')
    expect(readProviderRow(userDataDirectory, 'my-relay')).toMatchObject({
      auth_mode: 'stored',
      secret_ciphertext: expect.stringMatching(/^dpapi:v1:/)
    })
  })
})
