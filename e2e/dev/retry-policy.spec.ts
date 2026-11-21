import Database from 'better-sqlite3'
import { expect, test } from '../fixtures/app'
import { databasePath, seedBuiltinProvider } from '../fixtures/database'

/**
 * #69 的设置页入口：重试策略选择器在 provider 编辑表单里，保存后写入
 * `model_provider.retry_policy`，重启后仍保持选择。用例不联网。
 */

test.describe('provider 重试策略设置', () => {
  test('编辑表单可选 normal / always，保存后持久化并在重启后保持', async ({
    launch,
    userDataDirectory
  }) => {
    seedBuiltinProvider(databasePath(userDataDirectory), {
      catalogProviderId: 'deepseek',
      baseUrl: 'https://unused.example.com/v1',
      active: true
    })

    const handle = await launch({ env: { DEEPSEEK_API_KEY: '' } })
    const { page } = handle
    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '设置' })
      .click()
    await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()

    const card = page.locator('[data-provider-key="deepseek"]')
    await card.getByRole('button', { name: '编辑提供商' }).click()
    const form = card.locator('.profile-edit-form')
    await expect(form.getByRole('radio', { name: '只重试临时错误' })).toBeChecked()
    await expect(form).toContainText('只重试临时错误（默认，最多 5 次）')

    await form.getByRole('radio', { name: '所有失败都重试' }).check()
    await expect(form.locator('[data-retry-policy]')).toHaveAttribute(
      'data-retry-policy',
      'always'
    )
    await expect(form).toContainText('所有失败都重试（最多 5 次）')
    await form.getByRole('button', { name: '保存修改' }).click()
    await expect(page.getByRole('status')).toContainText('已保存')

    await handle.close()

    const database = new Database(databasePath(userDataDirectory), {
      readonly: true,
      fileMustExist: true
    })
    try {
      expect(
        database
          .prepare("SELECT retry_policy FROM model_provider WHERE provider_key = 'deepseek'")
          .get()
      ).toEqual({ retry_policy: '{"mode":"always"}' })
    } finally {
      database.close()
    }

    const reopened = await launch({ userDataDirectory, env: { DEEPSEEK_API_KEY: '' } })
    await reopened.page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '设置' })
      .click()
    const reopenedCard = reopened.page.locator('[data-provider-key="deepseek"]')
    await reopenedCard.getByRole('button', { name: '编辑提供商' }).click()
    await expect(
      reopenedCard
        .locator('.profile-edit-form')
        .getByRole('radio', { name: '所有失败都重试' })
    ).toBeChecked()
    await reopened.close()
  })
})
