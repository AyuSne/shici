import type { Locator, Page } from '@playwright/test'
import { expect, test } from '../fixtures/app'
import { openSettings } from '../fixtures/chat'
import { databasePath, seedBuiltinProvider } from '../fixtures/database'
import { seedOpenCodeGoProvider } from '../fixtures/opencode-go'
import { openManageModels, openProviderEditor } from '../fixtures/settings-panel'

/** #59 收口：有实际目录与编辑控件时检查布局，不只测空设置页。 */
async function expectContained(page: Page, locator: Locator): Promise<void> {
  const viewport = await page.evaluate(() => window.innerWidth)
  for (const element of await locator.all()) {
    const metrics = await element.evaluate((node) => {
      const box = node.getBoundingClientRect()
      return {
        left: box.left,
        right: box.right,
        client: node.clientWidth,
        scroll: node.scrollWidth
      }
    })
    expect(metrics.left).toBeGreaterThanOrEqual(-1)
    expect(metrics.right).toBeLessThanOrEqual(viewport + 1)
    expect(metrics.scroll, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.client + 1)
  }
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(documentWidth).toBeLessThanOrEqual(viewport + 1)
}

for (const width of [1100, 1280, 1440]) {
  test(`${width}px 设置页、可编辑目录与 OpenCode GO 只读目录无横向溢出`, async ({
    launch,
    userDataDirectory
  }) => {
    const file = databasePath(userDataDirectory)
    seedBuiltinProvider(file, {
      catalogProviderId: 'deepseek',
      baseUrl: `http://127.0.0.1:1/${'long-provider-endpoint-'.repeat(6)}`,
      displayName: '用于布局验收的内置提供商',
      active: true
    })
    seedOpenCodeGoProvider(file, { active: false })
    const { page, electronApp } = await launch({
      env: { DEEPSEEK_API_KEY: '', E2E_PROVIDER_KEY: '', E2E_GO_KEY: '' }
    })
    if (electronApp === null) throw new Error('布局验收需要真实开发态窗口')
    await electronApp.evaluate(({ BrowserWindow }, targetWidth) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (window === undefined) throw new Error('主窗口不存在')
      window.setContentSize(targetWidth, 900)
    }, width)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(width - 1)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width + 2)
    await openSettings(page)
    const deepseek = page.locator('[data-provider-key="deepseek"]')
    const go = page.locator('[data-provider-key="opencode-go"]')
    await openManageModels(go)
    await expect(go.locator('[data-model-row]')).toHaveCount(32)
    await openManageModels(deepseek)
    await expectContained(page, page.locator('.settings, .settings-main, .profile-card, .model-editor, .model-row-main'))

    // 长 ID、编辑容量与操作按钮均在目录里；不靠 overflow:hidden 掩盖整个目录溢出。
    const longModel = `layout-${'long-model-name-'.repeat(8)}`
    await deepseek.getByLabel('添加模型 ID').fill(longModel)
    await deepseek.getByRole('button', { name: '加入目录' }).click()
    const row = deepseek.locator(`[data-model-row="${longModel}"]`)
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: `编辑模型 ${longModel}`, exact: true }).click()
    await expect(deepseek.getByLabel('编辑模型 ID')).toBeVisible()
    await expectContained(page, deepseek.locator('.model-editor, .model-row, .model-row-main, .model-edit-form, .model-edit-capacities'))
    await row.getByRole('button', { name: '取消', exact: true }).click()

    // 提供商编辑器与聚合搜索状态同样检查；新增按钮会在第4批出现。
    await openProviderEditor(deepseek)
    await expect(deepseek.getByLabel('编辑显示名')).toBeVisible()
    await expectContained(page, deepseek.locator('.profile-edit-form, .settings-actions'))
    await openManageModels(go)
    await go.getByLabel('搜索模型').fill('Claude')
    await expect(go.locator('[data-model-row]')).not.toHaveCount(0)
    await expectContained(page, page.locator('.settings, .profile-card, .model-row-main, .profile-actions'))
  })
}
