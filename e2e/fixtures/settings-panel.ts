import { expect, type Locator, type Page } from '@playwright/test'

/**
 * 设置页 #84 收口后的语义操作助手。
 *
 * 卡片日常态只露出精炼信息，模型目录、连接详情与低频动作分别收在
 * 「管理模型」「连接详情」与「更多」里。E2E 只按用户真实会点的那几处操作，
 * 不直接改 display / 不加测试旁路；定位仍以可见名称与 aria 状态为准。
 */

/** 打开一个原生 details（已经展开时不重复点，避免反而收起）。 */
export async function openDetails(details: Locator): Promise<void> {
  if ((await details.getAttribute('open')) === null) {
    // 卡片详情里还可能嵌套「诊断信息」的 summary：只点外层这个。
    await details.locator('summary').first().click()
  }
  await expect(details).toHaveAttribute('open', '')
}

/** 新增内置提供商表单里的「查看连接详情」。 */
export async function openAddConnectionDetails(page: Page): Promise<Locator> {
  const details = page.locator('details.add-connection-details')
  await openDetails(details)
  return details
}

/** 某张提供商卡片里的「连接详情」。 */
export async function openProviderDetails(card: Locator): Promise<Locator> {
  const details = card.locator('details.profile-details')
  await openDetails(details)
  return details
}

/** 展开某张卡片的完整模型目录编辑器。 */
export async function openManageModels(card: Locator): Promise<void> {
  const button = card.getByRole('button', { name: '管理模型', exact: true })
  if ((await button.getAttribute('aria-expanded')) !== 'true') {
    await button.click()
  }
  await expect(button).toHaveAttribute('aria-expanded', 'true')
}

/** 打开卡片右上角的「更多」。 */
export async function openMoreMenu(card: Locator): Promise<void> {
  const button = card.getByRole('button', { name: /^更多/ })
  if ((await button.getAttribute('aria-expanded')) !== 'true') {
    await button.click()
  }
  await expect(button).toHaveAttribute('aria-expanded', 'true')
}

/** 更多菜单里的「编辑提供商」。 */
export async function openProviderEditor(card: Locator): Promise<void> {
  await openMoreMenu(card)
  await card.getByRole('button', { name: /^编辑提供商/ }).click()
}

/** 更多菜单里的「设为使用中」。 */
export async function setProviderActive(card: Locator): Promise<void> {
  await openMoreMenu(card)
  await card.getByRole('button', { name: '设为使用中', exact: true }).click()
}

/** 更多菜单里的删除与确认。 */
export async function deleteProvider(card: Locator): Promise<void> {
  await openMoreMenu(card)
  await card.getByRole('button', { name: /^删除提供商/ }).click()
  await card.getByRole('button', { name: '确认删除' }).click()
}

/** 记录一次复制请求 ID 的调用；只替换系统边界 navigator.clipboard。 */
export async function stubClipboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window as unknown as { __copiedText?: string | null }
    store.__copiedText = null
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          store.__copiedText = text
        }
      }
    })
  })
}

export async function copiedText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const store = window as unknown as { __copiedText?: string | null }
    return store.__copiedText ?? null
  })
}
