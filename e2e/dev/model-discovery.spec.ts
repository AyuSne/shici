import type { ElectronApplication, Page } from '@playwright/test'
import Database from 'better-sqlite3'
import {
  startModelListStub,
  type ModelListStub
} from '../../src/testing/model-list-stub'
import { expect, test } from '../fixtures/app'
import {
  databasePath,
  seedBuiltinProvider,
  seedModelProvider
} from '../fixtures/database'
import { openManageModels, openMoreMenu } from '../fixtures/settings-panel'

/**
 * #64 获取可用模型：全部请求打到本机 stub，不联网、不读真实 .env。
 *
 * 覆盖：新建未保存 custom 表单用当前地址/密钥获取；勾选只进草稿、显式保存才
 * 一次事务入库；已有 provider 复用/替换密钥、取消不保存、失败保留目录；环境
 * 变量当前未保存名字；内置目录零 HTTP；4 MiB 与超时边界在单测里覆盖。
 */

const stubs: ModelListStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(
  script: Parameters<typeof startModelListStub>[0]
): Promise<ModelListStub> {
  const stub = await startModelListStub(script)
  stubs.push(stub)
  return stub
}

/** 挡住开发态 .env 的真实密钥；测试密钥全是合成值。 */
const noEnvironmentConfig = { DEEPSEEK_API_KEY: '' }

function openAiModels(ids: readonly string[]): string {
  return JSON.stringify({
    data: ids.map((id) => ({ id, object: 'model' }))
  })
}

function queryProvider(
  userDataDirectory: string,
  providerKey: string
): {
  id: string
  auth_mode: string
  env_var: string | null
  secret_ciphertext: string | null
  base_url: string | null
  default_model_id: string | null
} | undefined {
  const database = new Database(databasePath(userDataDirectory))
  try {
    return database
      .prepare(
        `SELECT id, auth_mode, env_var, secret_ciphertext, base_url, default_model_id
           FROM model_provider WHERE provider_key = ?`
      )
      .get(providerKey) as
      | {
          id: string
          auth_mode: string
          env_var: string | null
          secret_ciphertext: string | null
          base_url: string | null
          default_model_id: string | null
        }
      | undefined
  } finally {
    database.close()
  }
}

function queryModels(
  userDataDirectory: string,
  providerKey: string
): Array<{ model_id: string; source: string; sort: number; display_name: string }> {
  const database = new Database(databasePath(userDataDirectory))
  try {
    return database
      .prepare(
        `SELECT m.model_id, m.source, m.sort, m.display_name
           FROM model_provider_model m
           JOIN model_provider p ON p.id = m.provider_id
          WHERE p.provider_key = ?
          ORDER BY m.sort, m.rowid`
      )
      .all(providerKey) as Array<{
      model_id: string
      source: string
      sort: number
      display_name: string
    }>
  } finally {
    database.close()
  }
}

async function openSettings(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '设置' })
    .click()
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
}

async function openEditPanel(page: Page, providerKey: string): Promise<void> {
  const card = page.locator(`[data-provider-key="${providerKey}"]`)
  await openMoreMenu(card)
  await card.getByRole('button', { name: /^编辑提供商/ }).click()
  await expect(card.locator('.profile-edit-form')).toBeVisible()
}

async function resizeTo(
  page: Page,
  electronApp: ElectronApplication | null,
  width: number
): Promise<void> {
  if (electronApp !== null) {
    await electronApp.evaluate(
      ({ BrowserWindow }, size) => {
        const window = BrowserWindow.getAllWindows()[0]
        if (window === undefined) throw new Error('没有主窗口')
        window.setContentSize(size.width, size.height)
      },
      { width, height: 820 }
    )
  } else {
    await page.setViewportSize({ width, height: 820 })
  }
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 5_000 })
    .toBeLessThanOrEqual(width + 2)
  await page.waitForTimeout(150)
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    reference: document.documentElement.clientWidth
  }))
  expect(overflow.document).toBeLessThanOrEqual(overflow.reference + 1)
  expect(overflow.body).toBeLessThanOrEqual(overflow.reference + 1)
}

test.describe('获取可用模型', () => {
  test('新建未保存 custom：用当前地址与密钥获取，勾选只进草稿，显式保存后一次入库并在重启后保留', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({
      // 故意不给 Content-Length：走 chunked，仍应正常解析。
      contentLength: null,
      body: openAiModels(['relay-alpha', 'relay-beta', 'relay-beta', 'relay-gamma'])
    })
    const handle = await launch({
      env: { ...noEnvironmentConfig, E2E_DISCOVERY_KEY: 'sk-e2e-discovery-7101' }
    })
    const { page } = handle
    await openSettings(page)

    await page.getByRole('button', { name: '自定义 API', exact: true }).click()
    const form = page.locator('[data-custom-provider-form="true"]')
    await form.getByLabel('Provider ID').fill('my-relay')
    await form.getByLabel('显示名').fill('我的中转')
    await form.getByLabel('自定义接口地址').fill(`${stub.baseUrl}/v1`)
    await form.getByLabel('自定义 API 密钥').fill('sk-e2e-discovery-7101')
    // 手填首个模型留空：只靠获取到的候选也要能保存。
    await expect(form.getByLabel('首个模型 ID')).toHaveValue('')

    await form.getByRole('button', { name: '获取可用模型' }).click()
    await expect(form.locator('[data-discovery-candidate="relay-alpha"]')).toBeVisible()
    await expect(form.locator('[data-discovery-candidate="relay-beta"]')).toBeVisible()
    await expect(form.locator('[data-discovery-candidate="relay-gamma"]')).toBeVisible()

    // 请求用的是表单里尚未保存的地址与合成密钥；重复 id 在服务端已去重。
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0]?.method).toBe('GET')
    expect(stub.requests[0]?.url).toBe('/v1/models')
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-e2e-discovery-7101')

    // 获取本身不建 provider、不写模型。
    expect(queryProvider(userDataDirectory, 'my-relay')).toBeUndefined()
    expect(queryModels(userDataDirectory, 'my-relay')).toEqual([])

    // 键盘勾选第一个候选，再点选 beta；gamma 勾了又取消，最终只保存 alpha + beta。
    const alphaCheckbox = form.getByRole('checkbox', { name: '选择模型 relay-alpha' })
    // 候选复选框的键盘焦点必须是 2px 琥珀描边（token §7），不是浏览器默认焦点框。
    await form.getByRole('button', { name: '获取可用模型' }).focus()
    await page.keyboard.press('Tab')
    await expect(alphaCheckbox).toBeFocused()
    // 125% 缩放下 Chromium 把 2px 描边折算成 1.6 CSS px；断言的是规则本身：
    // 键盘焦点可匹配 :focus-visible、实线琥珀描边、约 2px 宽与偏移。
    const focusStyle = await alphaCheckbox.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        focusVisible: element.matches(':focus-visible'),
        style: style.outlineStyle,
        color: style.outlineColor,
        width: Number.parseFloat(style.outlineWidth),
        offset: Number.parseFloat(style.outlineOffset)
      }
    })
    expect(focusStyle.focusVisible).toBe(true)
    expect(focusStyle.style).toBe('solid')
    expect(focusStyle.color).toBe('rgb(143, 90, 26)')
    expect(focusStyle.width).toBeGreaterThanOrEqual(1.5)
    expect(focusStyle.width).toBeLessThanOrEqual(2)
    expect(focusStyle.offset).toBeGreaterThanOrEqual(1.5)
    await page.keyboard.press('Space')
    await expect(alphaCheckbox).toBeChecked()
    await form.getByRole('checkbox', { name: '选择模型 relay-beta' }).check()
    const gammaCheckbox = form.getByRole('checkbox', { name: '选择模型 relay-gamma' })
    await gammaCheckbox.check()
    await expect(form.locator('[data-discovery-draft-hint="true"]')).toContainText('已选 3 个')
    await gammaCheckbox.uncheck()
    await expect(form.locator('[data-discovery-draft-hint="true"]')).toContainText('已选 2 个')

    // 勾选/取消仍然没有入库。
    expect(queryProvider(userDataDirectory, 'my-relay')).toBeUndefined()
    expect(queryModels(userDataDirectory, 'my-relay')).toEqual([])

    // 期间把窗口拉到三个宽度：候选区的长 ID 也不能撑出横向滚动。
    for (const width of [1100, 1280, 1440]) {
      await resizeTo(page, handle.electronApp, width)
      await expectNoHorizontalOverflow(page)
    }

    await form.getByRole('button', { name: '保存自定义提供商' }).click()
    await expect(page.getByRole('status')).toContainText('已保存自定义提供商')

    const card = page.locator('[data-provider-key="my-relay"]')
    await openManageModels(card)
    await expect(card.locator('[data-model-row="relay-alpha"]')).toBeVisible()
    await expect(card.locator('[data-model-row="relay-beta"]')).toBeVisible()
    await expect(card.locator('[data-model-row="relay-gamma"]')).toHaveCount(0)
    await expect(card.locator('[data-model-row]')).toHaveCount(2)
    await expect(card).toContainText('获取')

    const provider = queryProvider(userDataDirectory, 'my-relay')
    const models = queryModels(userDataDirectory, 'my-relay')
    expect(provider).toMatchObject({
      auth_mode: 'stored',
      base_url: `${stub.baseUrl}/v1`,
      secret_ciphertext: expect.stringMatching(/^dpapi:v1:/)
    })
    expect(models).toEqual([
      {
        model_id: 'relay-alpha',
        display_name: 'relay-alpha',
        source: 'fetched',
        sort: 0
      },
      {
        model_id: 'relay-beta',
        display_name: 'relay-beta',
        source: 'fetched',
        sort: 1
      }
    ])
    expect(provider?.default_model_id).toBeTruthy()

    // 页面上没有明文密钥。
    expect(await page.locator('body').innerText()).not.toContain(
      'sk-e2e-discovery-7101'
    )

    // 重启后勾选的两条仍在、未勾选的不出现，来源与默认模型都保持。
    await handle.close()
    const reopened = await launch({ userDataDirectory, env: noEnvironmentConfig })
    await openSettings(reopened.page)
    const reopenedCard = reopened.page.locator('[data-provider-key="my-relay"]')
    await openManageModels(reopenedCard)
    await expect(reopenedCard.locator('[data-model-row]')).toHaveCount(2)
    await expect(reopenedCard.locator('[data-model-row="relay-alpha"]')).toContainText('获取')
    await expect(
      reopenedCard.getByRole('radio', { name: /relay-alpha/ })
    ).toBeChecked()
    expect(queryModels(userDataDirectory, 'my-relay').map((model) => model.model_id)).toEqual([
      'relay-alpha',
      'relay-beta'
    ])
    expect(queryModels(userDataDirectory, 'my-relay').map((model) => model.source)).toEqual([
      'fetched',
      'fetched'
    ])
  })

  test('已有 custom：未保存新地址 + 替换密钥优先；取消不保存；显式加入只追加不改默认；失败保留目录', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ contentLength: null, body: openAiModels(['relay-alpha']) })
    const handle = await launch({ env: noEnvironmentConfig })
    const { page } = handle
    await openSettings(page)

    // 先用本机保存的合成密钥建一套 provider；baseUrl 先指向不会被请求的地址。
    await page.getByRole('button', { name: '自定义 API', exact: true }).click()
    const form = page.locator('[data-custom-provider-form="true"]')
    await form.getByLabel('Provider ID').fill('existing-relay')
    await form.getByLabel('显示名').fill('已有中转')
    await form.getByLabel('自定义接口地址').fill('https://unused.example.com/v1')
    await form.getByLabel('自定义 API 密钥').fill('sk-e2e-saved-7201')
    await form.getByLabel('首个模型 ID').fill('saved-model')
    await form.getByRole('button', { name: '保存自定义提供商' }).click()
    await expect(page.getByRole('status')).toContainText('已保存自定义提供商')
    const savedProvider = queryProvider(userDataDirectory, 'existing-relay')

    // 打开编辑面板：把地址改成尚未保存的 stub 地址，密钥留空先复用已存密钥。
    const card = page.locator('[data-provider-key="existing-relay"]')
    await openEditPanel(page, 'existing-relay')
    await card.getByLabel('编辑接口地址').fill(`${stub.baseUrl}/v1`)
    await expect(card.getByLabel('API 密钥')).toHaveValue('')

    await card.getByRole('button', { name: '获取可用模型' }).click()
    await expect(
      card.locator('[data-discovery-candidate="relay-alpha"]')
    ).toBeVisible()
    expect(stub.requests.at(-1)?.url).toBe('/v1/models')
    expect(stub.requests.at(-1)?.headers.authorization).toBe('Bearer sk-e2e-saved-7201')

    // 填一把替换密钥后再次获取：本机模式新密钥优先，且不会把已存密钥带出来。
    await card.getByLabel('API 密钥').fill('sk-e2e-replacement-7202')
    await card.getByRole('button', { name: '获取可用模型' }).click()
    await expect.poll(() => stub.requests.length).toBe(2)
    expect(stub.requests.at(-1)?.headers.authorization).toBe('Bearer sk-e2e-replacement-7202')

    // 两次获取都只读：地址、密钥来源与密文原封不动。
    expect(queryProvider(userDataDirectory, 'existing-relay')).toEqual(savedProvider)

    // 只勾选、不点加入就取消：目录、默认模型与顺序都不变。
    await card.getByRole('checkbox', { name: '选择模型 relay-alpha' }).check()
    const beforeModels = queryModels(userDataDirectory, 'existing-relay')
    const beforeProvider = queryProvider(userDataDirectory, 'existing-relay')
    await card.getByRole('button', { name: '取消' }).click()
    await expect(card.locator('.profile-edit-form')).toHaveCount(0)
    expect(queryModels(userDataDirectory, 'existing-relay')).toEqual(beforeModels)
    expect(queryProvider(userDataDirectory, 'existing-relay')).toEqual(beforeProvider)

    // 重新打开并显式加入：一次事务追加 fetched 行，已有行与默认模型不动。
    await openEditPanel(page, 'existing-relay')
    await card.getByLabel('编辑接口地址').fill(`${stub.baseUrl}/v1`)
    await card.getByRole('button', { name: '获取可用模型' }).click()
    await expect(
      card.locator('[data-discovery-candidate="relay-alpha"]')
    ).toBeVisible()
    await card.getByRole('checkbox', { name: '选择模型 relay-alpha' }).check()
    await card.getByRole('button', { name: '加入所选模型' }).click()
    await expect(page.getByRole('status')).toContainText('已加入 1 个获取到的模型')
    await openManageModels(card)
    await expect(card.locator('[data-model-row="relay-alpha"]')).toContainText('获取')

    const afterModels = queryModels(userDataDirectory, 'existing-relay')
    const afterProvider = queryProvider(userDataDirectory, 'existing-relay')
    expect(afterModels).toEqual([
      {
        model_id: 'saved-model',
        display_name: 'saved-model',
        source: 'manual',
        sort: 0
      },
      {
        model_id: 'relay-alpha',
        display_name: 'relay-alpha',
        source: 'fetched',
        sort: 1
      }
    ])
    expect(afterProvider?.default_model_id).toBe(beforeProvider?.default_model_id)
    // 加入模型没有顺手保存上面改过的地址。
    expect(afterProvider?.base_url).toBe('https://unused.example.com/v1')

    // 失败保留已有目录：重新打开编辑面板并填回 stub 地址，stub 改成 500，
    // 错误可见且行数不变。
    stub.setScript({ status: 500, body: '{"error":"must-not-echo-SECRET"}' })
    await openEditPanel(page, 'existing-relay')
    await card.getByLabel('编辑接口地址').fill(`${stub.baseUrl}/v1`)
    await card.getByRole('button', { name: '获取可用模型' }).click()
    await expect(card.locator('[data-discovery-error="true"]')).toContainText('HTTP 500')
    expect(queryModels(userDataDirectory, 'existing-relay')).toEqual(afterModels)
    expect(await page.locator('body').innerText()).not.toContain('must-not-echo-SECRET')
    expect(await page.locator('body').innerText()).not.toContain('sk-e2e-saved-7201')
    expect(await page.locator('body').innerText()).not.toContain('sk-e2e-replacement-7202')

    // 重启后新模型还在，默认仍是原来那条。
    await handle.close()
    const reopened = await launch({ userDataDirectory, env: noEnvironmentConfig })
    await openSettings(reopened.page)
    const reopenedCard = reopened.page.locator('[data-provider-key="existing-relay"]')
    await openManageModels(reopenedCard)
    await expect(reopenedCard.locator('[data-model-row="relay-alpha"]')).toBeVisible()
    await expect(reopenedCard.getByRole('radio', { name: /saved-model/ })).toBeChecked()
  })

  test('环境变量模式：用当前未保存的变量名解析，不改库里的旧变量名或密文', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({
      contentLength: null,
      body: openAiModels(['env-discovered'])
    })
    seedModelProvider(databasePath(userDataDirectory), {
      id: 'provider-env',
      providerKey: 'env-relay',
      displayName: '环境中转',
      baseUrl: 'https://unused.example.com/v1',
      modelId: 'env-model',
      authMode: 'env',
      envVar: 'E2E_OLD_NAME',
      verification: 'unverified'
    })
    const handle = await launch({
      env: {
        ...noEnvironmentConfig,
        E2E_OLD_NAME: 'sk-env-old-7301',
        E2E_NEW_NAME: 'sk-env-new-7302'
      }
    })
    const { page } = handle
    await openSettings(page)

    const card = page.locator('[data-provider-key="env-relay"]')
    await openEditPanel(page, 'env-relay')
    await card.getByLabel('编辑接口地址').fill(`${stub.baseUrl}/v1`)
    const envInput = card.getByLabel('环境变量名')
    await expect(envInput).toHaveValue('E2E_OLD_NAME')
    await envInput.fill('E2E_NEW_NAME')

    await card.getByRole('button', { name: '获取可用模型' }).click()
    await expect(
      card.locator('[data-discovery-candidate="env-discovered"]')
    ).toBeVisible()
    expect(stub.requests.at(-1)?.headers.authorization).toBe('Bearer sk-env-new-7302')

    // 获取只是读取：库里仍是旧变量名、仍没有密文。
    const provider = queryProvider(userDataDirectory, 'env-relay')
    expect(provider).toMatchObject({
      auth_mode: 'env',
      env_var: 'E2E_OLD_NAME',
      secret_ciphertext: null,
      base_url: 'https://unused.example.com/v1'
    })
    expect(queryModels(userDataDirectory, 'env-relay')).toHaveLength(1)
  })

  test('内置 provider：即使改了地址也只返回本地目录、零 HTTP；加入后不改默认模型与已有顺序', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ body: '{"data":[{"id":"wrong-network-model"}]}' })
    seedBuiltinProvider(databasePath(userDataDirectory), {
      catalogProviderId: 'deepseek',
      baseUrl: 'https://unused.example.com',
      envVar: 'E2E_PROVIDER_KEY',
      active: false
    })
    // 删掉一条本地目录模型，让「获取可用模型」有可加入的候选。
    const database = new Database(databasePath(userDataDirectory))
    try {
      database
        .prepare(
          `DELETE FROM model_provider_model
            WHERE model_id = 'deepseek-v4-pro'
              AND provider_id = (SELECT id FROM model_provider WHERE provider_key = 'deepseek')`
        )
        .run()
    } finally {
      database.close()
    }

    const handle = await launch({
      env: { ...noEnvironmentConfig, E2E_PROVIDER_KEY: 'sk-e2e-builtin-7401' }
    })
    const { page } = handle
    await openSettings(page)
    const card = page.locator('[data-provider-key="deepseek"]')
    await openEditPanel(page, 'deepseek')
    await card.getByLabel('编辑接口地址').fill(stub.baseUrl)

    await card.getByRole('button', { name: '获取可用模型' }).click()
    const candidate = card.locator('[data-discovery-candidate="deepseek-v4-pro"]')
    await expect(candidate).toBeVisible()
    await expect(candidate).toContainText('本地目录')
    expect(stub.requests).toHaveLength(0)

    await card.getByRole('checkbox', { name: '选择模型 deepseek-v4-pro' }).check()
    await card.getByRole('button', { name: '加入所选模型' }).click()
    await expect(page.getByRole('status')).toContainText('已加入 1 个获取到的模型')
    await openManageModels(card)
    await expect(
      card.locator('[data-model-row="deepseek-v4-pro"]')
    ).toContainText('获取')

    const models = queryModels(userDataDirectory, 'deepseek')
    expect(models.map((model) => model.model_id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro'
    ])
    expect(models[1]?.source).toBe('fetched')
    // 默认模型仍是 deepseek-flash；地址也仍是没保存过的旧值。
    expect(
      queryProvider(userDataDirectory, 'deepseek')?.default_model_id
    ).toBeTruthy()
    expect(
      await card.getByRole('radio', { name: /deepseek-flash/ }).isChecked()
    ).toBe(true)
    expect(queryProvider(userDataDirectory, 'deepseek')?.base_url).toBe(
      'https://unused.example.com'
    )
  })
})
