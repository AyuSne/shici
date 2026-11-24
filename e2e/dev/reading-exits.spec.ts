import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'
import { clickAway, selectText } from '../fixtures/reading'

const article = fixtureArticle({
  id: 'fixture-reading-exits',
  sentences: [
    ['Employers approach hiring differently.'],
    ['Approaching a new desk takes patience.']
  ],
  annotations: [{ surface: 'approach', gloss: '接近', paragraph: 0, sentence: 0 }]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-reading-exits-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('阅读页返回按钮标明来源，缺省时仍可返回', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const nav = page.getByRole('navigation', { name: '全局导航' })
  await nav.getByRole('button', { name: '文章库' }).click()
  await page.locator('.library-row').first().click()
  await page.getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' }).click()
  await expect(page.getByRole('button', { name: '返回文章库' })).toContainText('文章库')
  await page.getByRole('button', { name: '返回文章库' }).click()

  await nav.getByRole('button', { name: '首页' }).click()
  await page.getByRole('button', { name: '继续阅读' }).click()
  await expect(page.getByRole('button', { name: '返回首页' })).toContainText('首页')
  await page.getByRole('button', { name: '返回首页' }).click()

  await nav.getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await page.getByRole('button', { name: '回到原文' }).first().click()
  await expect(page.getByRole('button', { name: '返回词条' })).toContainText('词条')
  await page.getByRole('button', { name: '返回词条' }).click()

  // 全局搜索：直接带 from=search 打开时返回按钮写「搜索结果」；没有搜索记录时
  // 点它打开搜索覆盖层，仍然停在阅读页，而不是假装跳首页。
  await page.evaluate((id) => { window.location.hash = `#/reading/${id}?from=search` }, article.id)
  await expect(page.getByRole('button', { name: '返回搜索结果' })).toContainText('搜索结果')
  await page.getByRole('button', { name: '返回搜索结果' }).click()
  const searchDialog = page.getByRole('dialog', { name: '全局搜索' })
  await expect(searchDialog).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(
    `#/reading/${article.id}?from=search`
  )
  await page.keyboard.press('Escape')
  await expect(searchDialog).toHaveCount(0)
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await page.evaluate((id) => { window.location.hash = `#/reading/${id}` }, article.id)
  await expect(page.getByRole('button', { name: '返回', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page.getByRole('button', { name: '返回搜索结果' })).toBeVisible()
})

test('重启后从阅读回到原词条并定位所选原句', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const first = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await first.page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' }).click()
  await first.page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  const sentence = first.page.locator('.entry-sentence')
    .filter({ hasText: 'Employers approach hiring differently.' })
  await sentence.getByRole('button', { name: '回到原文' }).click()
  await expect(first.page.getByRole('button', { name: '返回词条' })).toBeVisible()
  await first.close()

  const second = await launch({ userDataDirectory, env: { CORPUS_DIRECTORY: corpusDirectory } })
  await second.page.getByRole('button', { name: '返回词条' }).click()
  await expect(second.page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  const restored = second.page.locator('.entry-sentence')
    .filter({ hasText: 'Employers approach hiring differently.' })
  await expect(restored).toHaveAttribute('data-focused', 'true')
  await expect(restored).toBeInViewport()
})

test('没有读过文章时从首页进入空阅读页，仍标明首页来源', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '阅读' }).click()
  await expect(page.getByRole('button', { name: '返回首页' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/reading?from=home')
  await page.getByRole('button', { name: '返回首页' }).click()
  await expect(page.getByRole('heading', { name: '先读一篇' })).toBeVisible()
})

test('重启后没有来源的阅读页仍可返回首页', async ({ launch, userDataDirectory }) => {
  const first = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await first.page.evaluate((id) => { window.location.hash = `#/reading/${id}` }, article.id)
  await expect(first.page.getByRole('button', { name: '返回', exact: true })).toBeVisible()
  await first.close()
  const second = await launch({ userDataDirectory, env: { CORPUS_DIRECTORY: corpusDirectory } })
  await second.page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(second.page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '首页' })).toHaveAttribute('aria-current', 'page')
  await expect(second.page.getByRole('region', { name: '继续阅读' })).toBeVisible()
})

test('刚收下与已收集的词都能直接打开选中的词条', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' }).click()
  await page.locator('.library-row').first().click()
  await page.getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' }).click()

  await selectText(page, 0, 'approach')
  await page.getByRole('complementary', { name: '选词结果' })
    .getByRole('button', { name: '查看词条' }).click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()

  await page.goBack()
  await expect(page.locator('.reading-collected')).toHaveCount(1)
  await clickAway(page)
  await page.locator('.reading-collected').first().click()
  await page.getByRole('complementary', { name: '词条' })
    .getByRole('button', { name: '打开词条' }).click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
})

test('就正文里点中的词提问时带上该词与那条原句', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach' },
      { entry: article, paragraphIndex: 1, needle: 'Approaching' }
    ]
  })
  const stub = await startSseStub({ kind: 'stream', text: ['好的。'] })
  try {
    const { page } = await launch({ env: {
      CORPUS_DIRECTORY: corpusDirectory,
      DEEPSEEK_BASE_URL: stub.baseUrl,
      DEEPSEEK_API_KEY: 'e2e-test-key',
      DEEPSEEK_MODEL: 'deepseek-flash'
    } })
    await page.getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '文章库' }).click()
    await page.locator('.library-row').first().click()
    await page.getByRole('complementary', { name: '文章详情' })
      .getByRole('button', { name: '继续阅读' }).click()
    await page.locator('.reading-collected').filter({ hasText: 'approach' }).first().click()
    await page.getByRole('complementary', { name: '词条' })
      .getByRole('button', { name: '问模型' }).click()

    await expect(page.getByRole('heading', { name: 'approach · 原句', level: 1 })).toBeVisible()
    await expect(page.locator('.context-chip-label')).toHaveText(['approach', 'Employers approach hiring differently.'])
    await page.getByRole('textbox', { name: '输入问题' }).fill('这句怎么理解？')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.getByText('好的。')).toBeVisible()
    await expect(page.getByRole('button', { name: '重新生成' })).toBeVisible()
    const messages = (stub.requests[0]?.body.messages ?? []) as { role: string; content: string }[]
    expect(messages[0]?.content).toContain('[原句] Employers approach hiring differently.')
    expect(messages[0]?.content).not.toContain('Approaching a new desk takes patience.')

    const firstThread = await page.evaluate(() => window.location.hash)
    await page.getByRole('button', { name: '添加上下文' }).click()
    await page.getByRole('group', { name: '可加入的上下文' })
      .locator('.context-candidate[data-context-kind="sentence"]')
      .filter({ hasText: 'Approaching a new desk takes patience.' }).click()
    await page.getByRole('button', { name: '添加上下文' }).click()
    await page.getByRole('button', { name: '移除上下文：approach', exact: true }).click()
    await page.getByRole('button', { name: '移除上下文：Employers approach hiring differently.', exact: true }).click()
    await expect(page.locator('.context-chip-label')).toHaveText(['Approaching a new desk takes patience.'])
    await page.reload()
    await expect(page.locator('.context-chip-label')).toHaveText(['Approaching a new desk takes patience.'])

    await page.goBack()
    await page.locator('.reading-collected').filter({ hasText: 'approach' }).first().click()
    await page.getByRole('complementary', { name: '词条' })
      .getByRole('button', { name: '问模型' }).click()
    await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(firstThread)
    await expect(page.locator('.context-chip-label')).toHaveText(['Approaching a new desk takes patience.', 'approach', 'Employers approach hiring differently.'])
    await page.reload()
    await expect(page.locator('.context-chip-label')).toHaveText(['Approaching a new desk takes patience.', 'approach', 'Employers approach hiring differently.'])
    await page.goBack()
    await page.locator('.reading-collected').filter({ hasText: 'approach' }).first().click()
    await page.getByRole('complementary', { name: '词条' })
      .getByRole('button', { name: '问模型' }).click()
    await expect(page.locator('.context-chip-label')).toHaveText(['Approaching a new desk takes patience.', 'approach', 'Employers approach hiring differently.'])

    await page.goBack()
    await page.locator('.reading-collected').filter({ hasText: 'approach' }).first().click()
    const panel = page.getByRole('complementary', { name: '词条' })
    await expect(panel.getByRole('button', { name: '新建对话' })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: '为这句新建对话' })).toHaveCount(0)
    await expect(panel.getByRole('button', { name: '问模型' })).toBeVisible()
  } finally {
    await stub.close()
  }
})

test('文章对话把完整正文和准确摘要带给模型', async ({ launch }) => {
  const stub = await startSseStub({ kind: 'stream', text: ['好的。'] })
  try {
    const { page } = await launch({ env: {
      CORPUS_DIRECTORY: corpusDirectory,
      DEEPSEEK_BASE_URL: stub.baseUrl,
      DEEPSEEK_API_KEY: 'e2e-test-key',
      DEEPSEEK_MODEL: 'deepseek-flash'
    } })
    await page.getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '文章库' }).click()
    await page.locator('.library-row').first().click()
    await page.getByRole('complementary', { name: '文章详情' })
      .getByRole('button', { name: '继续阅读' }).click()
    const title = await page.locator('.reading-bar-title').innerText()
    await page.getByRole('button', { name: '问模型' }).click()
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible()
    const fullText = '1. Employers approach hiring differently.\n\n2. Approaching a new desk takes patience.'
    await expect(page.getByTestId('context-summary')).toHaveText(`1 篇全文 · 约 ${Array.from(fullText).length} 字`)
    await page.getByRole('textbox', { name: '输入问题' }).fill('概括全文')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.getByText('好的。')).toBeVisible()
    const messages = (stub.requests[0]?.body.messages ?? []) as { role: string; content: string }[]
    expect(messages[0]?.content).toContain(fullText)
  } finally {
    await stub.close()
  }
})

test('已有较多上下文时保留原内容并加入所选词句，也可以新建对话', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' }).click()
  await page.getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' }).click()
  await page.locator('.reading-collected').first().click()
  await page.getByRole('complementary', { name: '词条' })
    .getByRole('button', { name: '问模型' }).click()
  const firstHash = await page.evaluate(() => window.location.hash)
  const threadId = decodeURIComponent(firstHash.slice('#/chat/'.length))
  await page.evaluate(async (id) => {
    const api = (window as unknown as { api: { invoke(channel: string, payload: unknown): Promise<unknown> } }).api
    const items = Array.from({ length: 100 }, (_, index) => ({
      id: `note:${index}`, kind: 'note', label: `内容 ${index}`, text: `内容 ${index}`, source: ''
    }))
    await api.invoke('chat:context', { threadId: id, items })
  }, threadId)
  await page.goBack()
  await page.locator('.reading-collected').first().click()
  const panel = page.getByRole('complementary', { name: '词条' })
  await panel.getByRole('button', { name: '问模型' }).click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(firstHash)
  await expect(page.locator('.context-chip-label').getByText('approach', { exact: true })).toBeVisible()
  const remaining = await page.evaluate(async (id) => {
    const api = (window as unknown as { api: { invoke(channel: string, payload: unknown): Promise<unknown> } }).api
    return api.invoke('chat:thread', { threadId: id }) as Promise<{ context: { id: string }[] }>
  }, threadId)
  expect(remaining.context).toHaveLength(102)
  expect(remaining.context.slice(0, 100).map((item) => item.id)).toEqual(
    Array.from({ length: 100 }, (_, index) => `note:${index}`)
  )
  await page.goBack()
  await page.locator('.reading-collected').first().click()
  const reopenedPanel = page.getByRole('complementary', { name: '词条' })
  await expect(reopenedPanel.getByRole('button', { name: '为这句新建对话' })).toHaveCount(0)
  await expect(reopenedPanel.getByRole('button', { name: '问模型' })).toBeVisible()
})

test('注释开关显示当前状态，并与正文的注释一致', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' }).click()
  await page.locator('.library-row').first().click()
  await page.getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' }).click()
  const hide = page.getByRole('button', { name: '隐藏原文注释' })
  await expect(hide).toHaveText('注释：开')
  await expect(hide).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.reading-notes')).toBeVisible()
  await hide.click()
  const show = page.getByRole('button', { name: '显示原文注释' })
  await expect(show).toHaveText('注释：关')
  await expect(show).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.reading-notes')).toBeHidden()
  await show.click()
  await expect(hide).toHaveText('注释：开')
  await expect(page.locator('.reading-notes')).toBeVisible()
})

test('阅读页复用文章最近线程，不再并排新开入口', async ({ launch }) => {
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' }).click()
  await page.locator('.library-row').first().click()
  await page.getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' }).click()
  await page.getByRole('button', { name: '问模型' }).click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toMatch(/^#\/chat\//)
  const firstThread = await page.evaluate(() => window.location.hash)
  await page.goBack()
  await page.getByRole('button', { name: '问模型' }).click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(firstThread)
  await page.goBack()
  await expect(page.getByRole('button', { name: '新开一条文章对话' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '新开一条' })).toHaveCount(0)
  await page.getByRole('button', { name: '问模型' }).click()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(firstThread)
})

test('打开文章线程失败时留在阅读页并提示', async ({ launch }) => {
  const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  if (electronApp === null) throw new Error('需要开发版 Electron 进程')
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' }).click()
  await page.locator('.library-row').first().click()
  await page.getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' }).click()
  await electronApp.evaluate(({ ipcMain }) => ipcMain.removeHandler('chat:open-for-main'))
  const action = page.getByRole('button', { name: '问模型' })
  await action.click()
  await expect(page.getByRole('alert')).toContainText('没能开对话')
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(action).toBeEnabled()
})

test('阅读顶栏在窄窗口仍可见且不横向溢出', async ({ launch }) => {
  const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  if (electronApp === null) throw new Error('需要开发版 Electron 进程')
  await page.getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' }).click()
  await page.locator('.library-row').first().click()
  await page.getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' }).click()
  for (const requested of [900, 1000, 1100]) {
    await electronApp.evaluate(({ BrowserWindow }, width) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('没有主窗口')
      // 融合标题栏在部分 DPI 下留 1px 非客户区：多要 1px 才是目标内容宽。
      window.setContentSize(width + 1, 820)
    }, requested)
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(requested)
    const measurements = await page.evaluate(() => {
      const reading = document.querySelector<HTMLElement>('.reading')!
      const buttons = Array.from(document.querySelectorAll<HTMLElement>('.reading-bar button'))
      return {
        width: window.innerWidth,
        scrollWidth: reading.scrollWidth,
        clientWidth: reading.clientWidth,
        buttons: buttons.map((button) => {
          const box = button.getBoundingClientRect()
          return { left: box.left, right: box.right, width: box.width }
        })
      }
    })
    expect(measurements.scrollWidth).toBeLessThanOrEqual(measurements.clientWidth + 1)
    for (const button of measurements.buttons) {
      expect(button.width).toBeGreaterThan(0)
      expect(button.left).toBeGreaterThanOrEqual(0)
      expect(button.right).toBeLessThanOrEqual(measurements.width + 1)
    }
  }
})
