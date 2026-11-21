import { expect, test } from '../fixtures/app'
import { LATEST_SCHEMA_VERSION } from '../../src/main/db/migrations'
import { readBootstrap } from '../fixtures/bridge'
import { databasePath, readSchemaVersion } from '../fixtures/database'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'

const NAV_LABELS = ['首页', '阅读', '词条', '对话', '文章库', '设置']

test('打包产物能启动并显示首页', async ({ launch }) => {
  const { page, userDataDirectory, close } = await launch({ packaged: true })

  await expect(page).toHaveTitle('拾词')
  await expect(page.locator('.brand')).toHaveText('拾词')
  await expect(page.locator('svg.brand-mark')).toBeVisible()

  const navigation = page.getByRole('navigation', { name: '全局导航' })
  await expect(navigation).toBeVisible()
  // 六个导航按钮的可访问名称保持原标签；数字是按钮里的独立计数元素。
  await expect(navigation.getByRole('button')).toHaveCount(NAV_LABELS.length)
  await expect(navigation.locator('.nav-label')).toHaveText(NAV_LABELS)
  // 打包产物自带 63 篇语料；干净库里还没有词条与未归档。
  await expect(navigation.locator('[data-nav-count="articles"]')).toHaveText('63')
  await expect(navigation.locator('[data-nav-count="entries"]')).toHaveText('0')
  await expect(navigation.locator('[data-nav-count="unfiled"]')).toHaveText('0')
  await expect(page.getByRole('heading', { name: '先读一篇' })).toBeVisible()

  const bootstrap = await readBootstrap(page)
  expect(bootstrap.isPackaged).toBe(true)
  expect(bootstrap.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
  expect(bootstrap.corpusImport).toMatchObject({ total: 63, imported: 63, failed: [] })

  // 语料随包分发：打包产物里也能看到全部 63 篇。
  await navigation.getByRole('button', { name: '文章库' }).click()
  await expect(page.getByText('63 篇 · 7 个场次')).toBeVisible()
  await expect(page.locator('.library-session')).toHaveCount(7)

  // 词典也随包分发：打包后从 resources 里读得到，不走 asar。
  const lookup = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        api: { invoke(channel: string, payload: unknown): Promise<unknown> }
      }
    ).api
    return api.invoke('dictionary:lookup', { word: 'approach' })
  })
  expect(lookup).toMatchObject({ status: 'found', via: 'exact' })

  const contentSecurityPolicy = await page
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
  expect(contentSecurityPolicy ?? '').toContain("script-src 'self';")

  await close()
  expect(readSchemaVersion(databasePath(userDataDirectory))).toBe(LATEST_SCHEMA_VERSION)
})

test('打包产物能经 pi-ai 走通一次流式对话', async ({ launch }) => {
  let stub: SseStub | null = null
  try {
    stub = await startSseStub({
      kind: 'stream',
      thinking: ['先想一下。'],
      text: ['打包产物里的回答。'],
      textDelayMs: 20,
      chunkDelayMs: 1
    })
    const { page } = await launch({
      packaged: true,
      env: {
        DEEPSEEK_BASE_URL: stub.baseUrl,
        DEEPSEEK_API_KEY: 'e2e-test-key',
        DEEPSEEK_MODEL: 'deepseek-flash'
      }
    })

    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '对话' })
      .click()
    await page.getByRole('textbox', { name: '输入问题' }).fill('你好')
    await page.getByRole('button', { name: '发送' }).click()

    await expect(page.getByText('打包产物里的回答。')).toBeVisible()
    await expect(page.getByRole('button', { name: /已思考/ })).toBeVisible()

    const request = stub.requests[0]
    expect(request).toBeDefined()
    expect(request?.body.reasoning_effort).toBe('high')
    expect(request?.body.thinking).toEqual({ type: 'enabled' })
  } finally {
    await stub?.close()
  }
})
