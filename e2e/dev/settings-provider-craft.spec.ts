import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from '../fixtures/app'
import { openSettings } from '../fixtures/chat'
import { expectReadableText } from '../fixtures/contrast'
import { databasePath, seedBuiltinProvider, writeSetting } from '../fixtures/database'
import {
  openAddConnectionDetails,
  openManageModels,
  openMoreMenu,
  openProviderDetails
} from '../fixtures/settings-panel'

/**
 * #84 验收宽度：900 / 1100 / 1280 × 浅色 / 深色，全部在真实 Electron 窗口里
 * 改实际内容尺寸后采样。检查的是展开后的模型目录、就地修复区、折叠摘要与
 * 更多菜单的实际渲染，而不只是 token 常量。
 */

const WIDTHS = [900, 1100, 1280] as const

async function expectNoHorizontalOverflow(page: Page, selectors: readonly string[]): Promise<void> {
  const viewport = await page.evaluate(() => window.innerWidth)
  for (const selector of selectors) {
    for (const element of await page.locator(selector).all()) {
      const metrics = await element.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return {
          left: box.left,
          right: box.right,
          client: node.clientWidth,
          scroll: node.scrollWidth
        }
      })
      expect(metrics.left, `${selector} 左边超出`).toBeGreaterThanOrEqual(-1)
      expect(metrics.right, `${selector} 右边超出`).toBeLessThanOrEqual(viewport + 1)
      expect(metrics.scroll, `${selector} 横向滚动`).toBeLessThanOrEqual(metrics.client + 1)
    }
  }
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth)
  expect(documentWidth).toBeLessThanOrEqual(viewport + 1)
}

function seedCraftProvider(userDataDirectory: string, theme: 'light' | 'dark'): void {
  seedBuiltinProvider(databasePath(userDataDirectory), {
    catalogProviderId: 'deepseek',
    baseUrl: 'https://unused.example.com/v1',
    envVar: 'E2E_CRAFT_KEY',
    active: true
  })
  // 环境变量故意不提供：凭据异常与测试失败都以真实路径出现，方便采样修复区。
  writeSetting(databasePath(userDataDirectory), 'theme', theme)
}

async function resizeWidth(
  app: ElectronApplication,
  page: Page,
  width: number
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, targetWidth) => {
    const window = BrowserWindow.getAllWindows()[0]
    if (window === undefined) throw new Error('主窗口不存在')
    window.setContentSize(targetWidth, 900)
  }, width)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(width - 1)
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(width + 2)
}

for (const theme of ['light', 'dark'] as const) {
  test(`${theme === 'light' ? '浅色' : '深色'}下 900 / 1100 / 1280 三档：设置页无遮挡且关键文字 ≥4.5:1`, async ({
    launch,
    userDataDirectory
  }) => {
    test.setTimeout(180_000)
    seedCraftProvider(userDataDirectory, theme)
    const handle = await launch({ env: { DEEPSEEK_API_KEY: '' } })
    const { page, electronApp } = handle
    if (electronApp === null) throw new Error('验收宽度需要真实开发态窗口')
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await openSettings(page)

    const card = page.locator('[data-provider-key="deepseek"]')
    await expect(card).toContainText('使用中')

    // 真实测试一次（本地少密钥，不会联网）：让失败原因与修复按钮出现在卡片上。
    await card.getByRole('button', { name: '测试连接 DeepSeek' }).click()
    await expect(card.locator('[data-provider-test-failure]')).toContainText(
      '系统里还没有设置环境变量 E2E_CRAFT_KEY'
    )
    // 凭据异常同样就地显示。
    await expect(card.locator('[data-credential-issue="true"]')).toBeVisible()

    // 连接详情与新增表单的连接详情都展开，检查折叠摘要与展开内容。
    await openProviderDetails(card)
    await openAddConnectionDetails(page)
    const builtinPreview = page.locator('.builtin-preview')
    await expect(builtinPreview).toBeVisible()

    const nowrapSelectors = [
      '.settings',
      '.settings-main',
      '.profile-card',
      '.profile-head',
      '.profile-controls',
      '.profile-default-model',
      '.profile-default-model select',
      '.profile-actions',
      '.profile-issue',
      '.profile-test-failure',
      '.profile-repair-actions',
      '.profile-details',
      '.profile-details summary',
      '.profile-details .profile-facts',
      '.model-editor',
      '.model-picker',
      '.model-row',
      '.model-row-main',
      '.model-add-form',
      '.builtin-provider-form',
      '.add-connection-details',
      '.builtin-preview'
    ] as const

    for (const width of WIDTHS) {
      await resizeWidth(electronApp, page, width)

      // 展开完整模型目录，真实采样目录行与元数据。
      await openManageModels(card)
      await expect(card.locator('[data-model-row]').first()).toBeVisible()

      await expectNoHorizontalOverflow(page, nowrapSelectors)
      await expectReadableText(page, [
        { label: '卡片名称', selector: '.profile-card .profile-name' },
        { label: '验证状态', selector: '.profile-card .profile-chip' },
        { label: '默认模型标签', selector: '.profile-default-model > span' },
        { label: '默认模型下拉', selector: '.profile-default-model select' },
        { label: '卡片主要动作', selector: '.profile-card .profile-actions .link-button' },
        { label: '凭据异常原因', selector: '[data-credential-issue] .profile-issue-reason' },
        { label: '就地修复按钮', selector: '[data-credential-issue] .button' },
        {
          label: '测试失败原因',
          selector: '[data-provider-test-failure] .profile-test-reason'
        },
        { label: '测试失败修复按钮', selector: '[data-provider-test-failure] .button' },
        { label: '模型目录说明', selector: '.model-picker .settings-field-label' },
        { label: '模型 ID', selector: '.model-row .model-id' },
        { label: '模型元数据', selector: '.model-row .model-meta' },
        {
          label: '模型目录操作',
          selector: '.model-row-actions .link-button:not(:disabled)'
        },
        { label: '添加模型说明', selector: '.model-add-form .field-hint' },
        { label: '连接详情摘要', selector: '.profile-details summary' },
        { label: '连接详情字段名', selector: '.profile-details .profile-facts dt' },
        { label: '连接详情字段值', selector: '.profile-details .profile-facts dd' },
        { label: '新增表单连接详情摘要', selector: '.add-connection-details summary' },
        { label: '新增表单连接详情值', selector: '.builtin-preview dd' }
      ])

      // 更多菜单也是日常可达区域：收起模型目录后展开并采样。
      await openMoreMenu(card)
      await expect(card.locator('.profile-more')).toBeVisible()
      await expectNoHorizontalOverflow(page, [
        '.profile-card',
        '.profile-head',
        '.profile-more',
        '.profile-actions'
      ])
      await expectReadableText(page, [
        { label: '更多菜单动作', selector: '.profile-more .link-button' },
        { label: '更多菜单删除', selector: '.profile-more .link-button.is-danger' }
      ])
    }
  })
}
