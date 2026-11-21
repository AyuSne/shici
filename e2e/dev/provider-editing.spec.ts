import type { Page } from '@playwright/test'
import { join } from 'node:path'
import { startSseStub, type SseStub, type StubScript } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { seedBuiltinProvider } from '../fixtures/database'

const stubs: SseStub[] = []

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: StubScript): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

/** 挡住开发态 .env，让用例从「没有环境变量配置」开始。 */
const noEnvironmentConfig = { DEEPSEEK_API_KEY: '' }

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

test.describe('自定义 provider 与模型目录', () => {
  test('自定义 API：字段校验、ID 唯一不可改、未知模型可发送，重启后仍在', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['自定义中转可用。'] })
    seedBuiltinProvider(databaseFile(userDataDirectory), {
      catalogProviderId: 'deepseek',
      baseUrl: stub.baseUrl,
      active: false
    })

    const handle = await launch({ env: noEnvironmentConfig })
    const { page } = handle
    await openSettings(page)

    // 新增入口在「内置提供商 / 自定义 API」之间切换；协议选项来自共享协议表。
    await page.getByRole('button', { name: '自定义 API' }).click()
    const form = page.locator('[data-custom-provider-form="true"]')
    await expect(form).toBeVisible()
    const protocol = form.getByLabel('协议')
    await expect(protocol.locator('option')).toHaveCount(4)
    await expect(protocol.locator('option[value="openai-completions"]')).toBeEnabled()
    await expect(protocol.locator('option[value="anthropic-messages"]')).toBeEnabled()
    await expect(protocol.locator('option[value="anthropic-messages"]')).toContainText(
      'Anthropic Messages'
    )
    await expect(protocol.locator('option[value="openai-responses"]')).toBeDisabled()
    await expect(protocol.locator('option[value="openai-responses"]')).toContainText(
      '后续版本'
    )

    // 非法 Provider ID 与重复 ID 都给出字段错误，且不写半条配置。
    await form.getByLabel('Provider ID').fill('Bad_Relay')
    await form.getByLabel('显示名').fill('我的中转')
    await form.getByLabel('自定义接口地址').fill(stub.baseUrl)
    await form.getByLabel('首个模型 ID').fill('relay-mystery-model')
    await form.getByRole('button', { name: '保存自定义提供商' }).click()
    await expect(form.locator('[data-field-error="provider-id"]')).toContainText(
      '小写字母开头'
    )
    await expect(page.locator('[data-provider-key="Bad_Relay"]')).toHaveCount(0)

    await form.getByLabel('Provider ID').fill('deepseek')
    await form.getByRole('button', { name: '保存自定义提供商' }).click()
    await expect(form.locator('[data-field-error="provider-id"]')).toContainText(
      '已经有了'
    )

    // 目录外模型先给「不在目录」提示，仍允许保存；至少一个模型不能少。
    await form.getByLabel('Provider ID').fill('my-relay')
    await form.getByLabel('首个模型 ID').fill('')
    await form.getByRole('button', { name: '保存自定义提供商' }).click()
    await expect(form.locator('[data-field-error="first-model"]')).toContainText(
      '先填模型 ID'
    )
    await form.getByLabel('首个模型 ID').fill('relay-mystery-model')
    await expect(form.locator('[data-model-hint="custom"]')).toContainText('不在目录')
    await form.getByLabel('自定义 API 密钥').fill('sk-custom-0001')
    await form.getByRole('button', { name: '保存自定义提供商' }).click()
    await expect(page.getByRole('status')).toContainText('已保存自定义提供商')

    const relay = page.locator('[data-provider-key="my-relay"]')
    await expect(relay).toContainText('我的中转')
    await expect(relay).toContainText('自定义')
    await expect(relay.locator('[data-model-row="relay-mystery-model"]')).toContainText(
      '不在目录'
    )

    // Provider ID 与协议只读；能改显示名，修改后立即生效。
    await relay.getByRole('button', { name: '编辑提供商' }).click()
    const editForm = relay.locator('.profile-edit-form')
    await expect(editForm).toContainText('my-relay')
    await expect(editForm).toContainText('OpenAI Chat Completions')
    await expect(editForm.getByLabel('Provider ID')).toHaveCount(0)
    await editForm.getByLabel('编辑显示名').fill('我的中转 2')
    await editForm.getByRole('button', { name: '保存修改' }).click()
    await expect(relay).toContainText('我的中转 2')

    // 自定义 provider 的目录至少留一条模型。
    await relay
      .getByRole('button', { name: '移除模型 relay-mystery-model' })
      .click()
    await expect(relay.locator('.field-error')).toContainText('至少要留一个模型')
    await expect(relay.locator('[data-model-row="relay-mystery-model"]')).toBeVisible()

    // 切为使用中后，未知模型 ID 照常发送；缺容量由主进程兜底。
    await relay.getByRole('button', { name: '使用这个' }).click()
    await expect(relay).toContainText('使用中')
    await openChat(page)
    await ask(page, '用自定义中转回答')
    await expect(page.getByText('自定义中转可用。')).toBeVisible()
    await expect.poll(() => stub.requests.length).toBe(1)
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-custom-0001')
    expect(stub.requests[0]?.body.model).toBe('relay-mystery-model')

    // 重启后 provider、显示名、模型与使用中状态都还在，聊天仍走它。
    await handle.close()
    const reopened = await launch({ userDataDirectory, env: noEnvironmentConfig })
    await openSettings(reopened.page)
    const reopenedRelay = reopened.page.locator('[data-provider-key="my-relay"]')
    await expect(reopenedRelay).toContainText('我的中转 2')
    await expect(reopenedRelay).toContainText('使用中')
    await expect(
      reopenedRelay.locator('[data-model-row="relay-mystery-model"]')
    ).toBeVisible()

    await openChat(reopened.page)
    await ask(reopened.page, '重启后再回答')
    await expect.poll(() => stub.requests.length).toBe(2)
    expect(stub.requests[1]?.body.model).toBe('relay-mystery-model')
  })

  test('内置 provider：改地址、手加未知模型、行内编辑、默认删除保护、上下移动与拖拽排序，重启保持', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: ['内置模型回答。'] })
    seedBuiltinProvider(databaseFile(userDataDirectory), {
      catalogProviderId: 'deepseek',
      baseUrl: 'https://unused.example.com/v1',
      active: true
    })

    const handle = await launch({
      env: { ...noEnvironmentConfig, E2E_PROVIDER_KEY: 'sk-seeded-0001' }
    })
    const { page } = handle
    await openSettings(page)

    const card = page.locator('[data-provider-key="deepseek"]')
    await expect(card).toContainText('未验证')

    // 内置 provider 的地址可改成中转/镜像地址。
    await card.getByRole('button', { name: '编辑提供商' }).click()
    await card.getByLabel('编辑接口地址').fill(stub.baseUrl)
    await card.getByRole('button', { name: '保存修改' }).click()
    await expect(page.getByRole('status')).toContainText('新地址')
    await expect(card).toContainText(stub.baseUrl)

    // 手加目录外模型：先提示不在目录，再加入并保留标记。
    await card.getByLabel('添加模型 ID').fill('outside-catalog-model')
    await expect(card.locator('.model-add-hint')).toContainText('不在目录')
    await card.getByRole('button', { name: '加入目录' }).click()
    await expect(
      card.locator('[data-model-row="outside-catalog-model"]')
    ).toContainText('不在目录')

    await card.getByLabel('添加模型 ID').fill('second-model')
    await card.getByRole('button', { name: '加入目录' }).click()
    await expect(card.locator('[data-model-row="second-model"]')).toBeVisible()

    // 行内编辑模型 ID 与显示名。
    await card
      .getByRole('button', { name: '编辑模型 outside-catalog-model' })
      .click()
    await card.getByLabel('编辑模型 ID').fill('outside-catalog-model-2')
    await card.getByLabel('编辑模型显示名').fill('外部模型')
    await card.getByRole('button', { name: '保存模型' }).click()
    const edited = card.locator('[data-model-row="outside-catalog-model-2"]')
    await expect(edited).toContainText('外部模型')

    // 默认模型不能直接删：先另选，再删旧的。
    await card.getByRole('button', { name: '移除模型 deepseek-flash' }).click()
    await expect(card.locator('.field-error')).toContainText('先另选一个默认模型')
    await expect(card.locator('[data-model-row="deepseek-flash"]')).toBeVisible()

    await card.getByRole('radio', { name: /outside-catalog-model-2/ }).check()
    await expect(
      card.getByRole('radio', { name: /outside-catalog-model-2/ })
    ).toBeChecked()
    await card.getByRole('button', { name: '移除模型 deepseek-flash' }).click()
    await expect(card.locator('[data-model-row="deepseek-flash"]')).toHaveCount(0)

    // 键盘可操作的上移按钮改变顺序；随后拖拽把最后一行移到最前。
    await card.getByRole('button', { name: '上移模型 second-model' }).click()
    await expect(card.locator('[data-model-row]').nth(1)).toHaveAttribute(
      'data-model-row',
      'second-model'
    )

    await card
      .locator('[data-model-row="outside-catalog-model-2"]')
      .dragTo(card.locator('[data-model-row="deepseek-v4-pro"]'))
    await expect(card.locator('[data-model-row]').first()).toHaveAttribute(
      'data-model-row',
      'outside-catalog-model-2'
    )

    // 未知模型作为默认模型真正发送；地址是刚改过的本地 stub。
    await openChat(page)
    await ask(page, '用目录外的模型回答')
    await expect(page.getByText('内置模型回答。')).toBeVisible()
    await expect.poll(() => stub.requests.length).toBe(1)
    expect(stub.requests[0]?.body.model).toBe('outside-catalog-model-2')
    expect(stub.requests[0]?.headers.authorization).toBe('Bearer sk-seeded-0001')

    // 重启后顺序、显示名与新地址都还在。
    await handle.close()
    const reopened = await launch({
      userDataDirectory,
      env: { ...noEnvironmentConfig, E2E_PROVIDER_KEY: 'sk-seeded-0001' }
    })
    await openSettings(reopened.page)
    const reopenedCard = reopened.page.locator('[data-provider-key="deepseek"]')
    await expect(reopenedCard).toContainText(stub.baseUrl)
    await expect(reopenedCard.locator('[data-model-row]').first()).toHaveAttribute(
      'data-model-row',
      'outside-catalog-model-2'
    )
    await expect(
      reopenedCard.locator('[data-model-row="outside-catalog-model-2"]')
    ).toContainText('外部模型')
    await expect(
      reopenedCard.getByRole('radio', { name: /outside-catalog-model-2/ })
    ).toBeChecked()
  })
})
