import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askQuestion, createThread, saveAnswer } from '../../src/main/chat/threads'
import { openDatabase } from '../../src/main/db/database'
import { createPin } from '../../src/main/pins/pins'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub, type SseStub, type StubScript } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { databasePath } from '../fixtures/database'
import { seedWordEntries, type SeedNote, type SeedPick } from '../fixtures/entries'
import { openArticle } from '../fixtures/reading'

/**
 * T14 全局搜索：外壳覆盖层、词条 / 文章两组、命中类型与真实片段高亮，
 * 词条原句与学习内容定位、文章普通未收集句定位、生成文章正文参与搜索，
 * 以及 Esc / 点外部关闭不丢底页状态、不误触阅读退出与对话停止。
 */

const article = fixtureArticle({
  id: 'fixture-global-search-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['Context keeps the skill alive.', 'A zebra never appears in the corpus.'],
    ['The counter stays open late.', 'Repeated words stick.']
  ]
})

const picks: SeedPick[] = [
  { entry: article, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
  { entry: article, paragraphIndex: 0, needle: 'Approaching', at: '2026-11-18T08:02:00.000Z' },
  { entry: article, paragraphIndex: 1, needle: 'Context', at: '2026-11-18T08:05:00.000Z' }
]

const notes: SeedNote[] = [
  { entryMainForm: 'approach', body: '记：approach 是「做法、途径」。' }
]

const AI_BODY =
  'Approach shapes how we read. Context keeps the meaning alive.\n\n' +
  'A second paragraph follows here. The luminous lantern marks this line.'

let corpusDirectory: string
const stubs: SseStub[] = []

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-global-search-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(script: StubScript): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

function launchEnv(stub: SseStub | null = null): Record<string, string> {
  return {
    CORPUS_DIRECTORY: corpusDirectory,
    ...(stub === null
      ? {}
      : {
          DEEPSEEK_BASE_URL: stub.baseUrl,
          DEEPSEEK_API_KEY: 'e2e-test-key',
          DEEPSEEK_MODEL: 'deepseek-flash'
        })
  }
}

function seed(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks, notes })
}

const SOURCE_ANSWER = '第一段：approach 是接近。\n\n第二段：complain 只是抱怨。'

/** 钉一条到 approach，给对话页留下「看原对话」的来源回跳高亮。 */
function seedSourcePin(userDataDirectory: string): void {
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    const entry = database
      .prepare("SELECT id FROM word_entry WHERE main_form = 'approach'")
      .get() as { id: string }
    const created = createThread(database, { main: { kind: 'entry', entryId: entry.id } }, {
      now: '2026-11-18T09:00:00.000Z'
    })
    if (created.status !== 'created') throw new Error('线程没建起来')
    const asked = askQuestion(
      database,
      { threadId: created.thread.id, text: 'approach 怎么用？' },
      { now: '2026-11-18T09:01:00.000Z' }
    )
    if (asked.status !== 'asked') throw new Error('问题没写进去')
    const saved = saveAnswer(
      database,
      {
        threadId: created.thread.id,
        questionId: asked.questionId,
        text: SOURCE_ANSWER,
        thinking: '',
        phase: 'done'
      },
      { now: '2026-11-18T09:02:00.000Z' }
    )
    if (saved.status !== 'saved') throw new Error('回答没写进去')
    const answerId = saved.thread.turns[0]?.answer?.id
    if (!answerId) throw new Error('没有回答')
    const start = SOURCE_ANSWER.indexOf('approach 是接近')
    const pinned = createPin(
      database,
      {
        threadId: created.thread.id,
        answerId,
        start,
        end: start + 'approach 是接近'.length,
        target: { kind: 'entry', entryId: entry.id }
      },
      { now: '2026-11-18T09:03:00.000Z', model: 'deepseek-flash' }
    )
    if (pinned.status !== 'pinned') throw new Error('没钉上')
  } finally {
    database.close()
  }
}

function nav(page: Page) {
  return page.getByRole('navigation', { name: '全局导航' })
}

function searchDialog(page: Page) {
  return page.getByRole('dialog', { name: '全局搜索' })
}

function searchInput(page: Page) {
  return page.getByRole('searchbox', { name: '搜索词条与文章' })
}

async function openSearch(page: Page): Promise<void> {
  await page.getByRole('button', { name: '全局搜索' }).click()
  await expect(searchDialog(page)).toBeVisible()
  await expect(searchInput(page)).toBeFocused()
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
  await page.waitForTimeout(200)
}

async function openEntries(page: Page): Promise<void> {
  await nav(page).getByRole('button', { name: '词条' }).click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
}

async function openChat(page: Page): Promise<void> {
  await nav(page).getByRole('button', { name: '对话' }).click()
}

test('外壳搜索：按词条 / 文章分组，命中类型与真实片段高亮', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })

  await openSearch(page)
  await searchInput(page).fill('hiring')

  const entryGroup = page.getByRole('region', { name: '词条' })
  await expect(entryGroup.locator('.global-search-entry')).toHaveCount(1)
  const entryRow = entryGroup.locator('.global-search-entry')
  await expect(entryRow).toHaveAttribute('data-match', 'sentence')
  await expect(entryRow.locator('.global-search-hit-kind')).toHaveText('原句')
  await expect(entryRow.locator('.global-search-snippet')).toContainText(
    'Employers approach hiring differently.'
  )
  await expect(entryRow.locator('.global-search-snippet mark')).toHaveText('hiring')

  const articleGroup = page.getByRole('region', { name: '文章' })
  await expect(articleGroup.locator('.global-search-article')).toHaveCount(1)
  await expect(articleGroup.locator('.global-search-hit-kind')).toHaveText('正文')
  await expect(articleGroup.locator('.global-search-snippet mark')).toHaveText('hiring')

  // 主词形命中。
  await searchInput(page).fill('Context')
  await expect(page.getByRole('region', { name: '词条' }).locator('.global-search-entry')).toHaveAttribute(
    'data-match',
    'main-form'
  )
  await expect(
    page.getByRole('region', { name: '词条' }).locator('.global-search-hit-kind')
  ).toHaveText('主词形')

  // 学习内容命中：类型与片段都来自真实笔记；文章组明确为空。
  await searchInput(page).fill('途径')
  const noteRow = page.getByRole('region', { name: '词条' }).locator('.global-search-entry')
  await expect(noteRow).toHaveAttribute('data-match', 'learning-note')
  await expect(noteRow.locator('.global-search-hit-kind')).toHaveText('学习内容')
  await expect(noteRow.locator('.global-search-snippet mark')).toHaveText('途径')
  await expect(page.getByRole('region', { name: '文章' })).toContainText('没有命中的文章。')

  // 清空回到提示态；无结果给明确文案。
  await searchInput(page).fill('')
  await expect(searchDialog(page)).toContainText('输入关键词')
  await searchInput(page).fill('zzzz-not-there')
  await expect(searchDialog(page)).toContainText('没有搜到「zzzz-not-there」。换个词试试。')

  // Esc 关闭后重开：输入框是空的，不残留上一次的查询与结果。
  await page.keyboard.press('Escape')
  await expect(searchDialog(page)).toHaveCount(0)
  await openSearch(page)
  await expect(searchInput(page)).toHaveValue('')
  await expect(searchDialog(page)).toContainText('输入关键词')
})

test('词条原句命中：进入词条页并定位高亮那一句', async ({ launch, userDataDirectory }) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })

  await openSearch(page)
  await searchInput(page).fill('hiring')
  await page.getByRole('region', { name: '词条' }).locator('.global-search-entry').click()

  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  const focused = page.locator('.entry-sentence[data-focused="true"]')
  await expect(focused).toContainText('Employers approach hiring differently.')
  await expect(focused).toBeInViewport()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('sentence=')
})

test('已挂载词条页内搜另一个词条：主词形/原句/学习内容都落到目标，hash 稳定且左栏选择仍不加历史', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })

  await openEntries(page)
  const row = (name: string) => page.locator('.entries-row').filter({ hasText: name })
  const mainHeading = () =>
    page.getByRole('region', { name: '词条内容' }).getByRole('heading', { level: 2 })
  const entryResults = () =>
    page.getByRole('region', { name: '词条' }).locator('.global-search-entry')
  const hash = () => page.evaluate(() => window.location.hash)

  // 先挂载 A=approach，再搜 B=Context 的主词形。
  await row('approach').click()
  await expect(mainHeading()).toHaveText('approach')
  const historyBeforeSearch = await page.evaluate(() => window.history.length)
  await openSearch(page)
  await searchInput(page).fill('Context')
  await entryResults().click()
  await expect(mainHeading()).toHaveText('Context')
  // 页面级搜索跳转保留自己的历史，浏览器后退能回到搜索前的位置。
  expect(await page.evaluate(() => window.history.length)).toBe(historyBeforeSearch + 1)
  const contextHash = await hash()
  expect(contextHash).toContain('#/entries/')
  expect(contextHash).not.toContain('note=')
  // 旧代码会在两个 effect 之间把 hash 写回 A：等一会儿仍必须是 B。
  await page.waitForTimeout(600)
  expect(await hash()).toBe(contextHash)
  await expect(mainHeading()).toHaveText('Context')

  // 从 B 搜 A 的原句命中：落到 A，并高亮那条原句。
  await openSearch(page)
  await searchInput(page).fill('hiring')
  await entryResults().click()
  await expect(mainHeading()).toHaveText('approach')
  await expect(page.locator('.entry-sentence[data-focused="true"]')).toContainText(
    'Employers approach hiring differently.'
  )
  await expect.poll(hash).toContain('sentence=')

  // 同一个 A 再搜它的学习内容命中：落到同一条词条的学习内容，hash 带 note。
  await openSearch(page)
  await searchInput(page).fill('途径')
  await entryResults().click()
  await expect(mainHeading()).toHaveText('approach')
  await expect(page.locator('.entry-note[data-focused="true"]')).toContainText('做法、途径')
  await expect.poll(hash).toContain('note=')

  // 同一个 A 换成另一条原句命中：仍定位到新的一句，而不是停在刚才那条。
  await openSearch(page)
  await searchInput(page).fill('Approaching')
  await entryResults().click()
  await expect(
    page.locator('.entry-sentence[data-focused="true"]')
  ).toContainText('Approaching a new desk takes patience.')
  const secondSentenceHash = await hash()
  expect(secondSentenceHash).toContain('sentence=')
  expect(secondSentenceHash).not.toContain('note=')

  // 搜索词与筛选还停在上一次内容时，也不能挡住选中的 B 打开。
  await page.getByRole('searchbox', { name: '搜词条名、原句或学习内容' }).fill('zzzz-no-entry')
  await page.getByRole('combobox', { name: '按学习内容筛选' }).selectOption('no-notes')
  await openSearch(page)
  await searchInput(page).fill('hiring')
  await entryResults().click()
  await expect(mainHeading()).toHaveText('approach')
  await expect.poll(hash).toContain('sentence=')

  // 重复搜索到同一目标：仍停在 B，hash 不再抖动。
  await openSearch(page)
  await searchInput(page).fill('Context')
  await entryResults().click()
  await expect(mainHeading()).toHaveText('Context')
  const repeatedHash = await hash()
  await page.waitForTimeout(600)
  expect(await hash()).toBe(repeatedHash)

  // 正常左栏 A→B 仍然工作，而且只替换地址、不新增历史。
  const collapseRail = page.getByRole('button', { name: '收起词典与学习内容' })
  if ((await collapseRail.count()) > 0) await collapseRail.click()
  await page.getByRole('button', { name: '清空搜索' }).click()
  await page.getByRole('combobox', { name: '按学习内容筛选' }).selectOption('all')
  const historyBefore = await page.evaluate(() => window.history.length)
  await row('approach').click()
  await expect(mainHeading()).toHaveText('approach')
  expect(await page.evaluate(() => window.history.length)).toBe(historyBefore)
})

test('同一条学习内容结果：手动收起右栏后再次点同一结果仍重新展开并定位', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })
  const entryResults = () =>
    page.getByRole('region', { name: '词条' }).locator('.global-search-entry')
  const rail = page.locator('.entries-rail-open')

  await openSearch(page)
  await searchInput(page).fill('途径')
  await entryResults().click()
  await expect(rail).toBeVisible()
  await expect(page.locator('.entry-note[data-focused="true"]')).toContainText('做法、途径')
  const targetHash = await page.evaluate(() => window.location.hash)

  // 用户自己收起右栏：URL 仍停在这条学习内容上。
  await page.getByRole('button', { name: '收起词典与学习内容' }).click()
  await expect(rail).toHaveCount(0)

  // 再点同一条结果：地址不变，但目标定位必须重新活一次。
  await openSearch(page)
  await searchInput(page).fill('途径')
  await entryResults().click()
  await expect(rail).toBeVisible()
  await expect(page.locator('.entry-note[data-focused="true"]')).toBeVisible()
  await expect(page.locator('.entry-note[data-focused="true"]')).toContainText('做法、途径')
  expect(await page.evaluate(() => window.location.hash)).toBe(targetHash)
})

test('词条学习内容命中：自动展开学习内容并定位高亮（窄屏抽屉也可见）', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page, electronApp } = await launch({ env: launchEnv() })
  await resizeTo(page, electronApp, 1000)

  // 底页先打开一个词条：关闭搜索后它仍是被选中的那一个。
  await openEntries(page)
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
  await expect(page.locator('.entries-page')).toHaveAttribute('data-layout', 'drawer')

  await openSearch(page)
  await searchInput(page).fill('途径')
  await page.getByRole('region', { name: '词条' }).locator('.global-search-entry').click()

  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await expect(page.locator('.entries-rail-open')).toBeVisible()
  const focusedNote = page.locator('.entry-note[data-focused="true"]')
  await expect(focusedNote).toContainText('做法、途径')
  await expect(focusedNote).toBeInViewport()
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('note=')
  // 窄屏是覆盖抽屉：有遮罩、是 modal dialog，内容仍看得见。
  await expect(page.locator('.entries-rail-open')).toHaveAttribute('role', 'dialog')
  await expect(
    page.getByRole('region', { name: '词条内容' }).getByRole('heading', { name: 'approach', level: 2 })
  ).toBeVisible()
})

test('文章正文命中：普通未收集句也能进入真实阅读、滚到并高亮，返回真的回到搜索结果', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })

  const originHash = await page.evaluate(() => window.location.hash || '#/home')
  await openSearch(page)
  await searchInput(page).fill('zebra')

  const articleGroup = page.getByRole('region', { name: '文章' })
  await expect(articleGroup.locator('.global-search-article')).toHaveCount(1)
  await expect(articleGroup.locator('.global-search-hit-kind')).toHaveText('正文')
  await expect(articleGroup.locator('.global-search-snippet mark')).toHaveText('zebra')
  await articleGroup.locator('.global-search-article').click()

  // 真实阅读页：标题、正文、命中句高亮都在；这一句从未被收集过。
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: '2026年6月 · 第1套 · 仔细阅读 Passage One', level: 1 })
  ).toBeVisible()
  const focused = page.locator('.reading-sentence-focused')
  await expect(focused).toHaveText('A zebra never appears in the corpus.')
  await expect(focused).toBeInViewport()
  await expect(page.locator('.reading-context')).toContainText('来自搜索「zebra」')
  await expect(page.getByRole('button', { name: '返回搜索结果' })).toBeVisible()
  expect(await page.evaluate(() => window.location.hash)).toContain('from=search')

  // 返回「搜索结果」不是假标签：回到搜索前的页面，并重新打开同一批结果。
  await page.getByRole('button', { name: '返回搜索结果' }).click()
  await expect(searchDialog(page)).toBeVisible()
  await expect(searchInput(page)).toHaveValue('zebra')
  await expect(page.getByRole('region', { name: '文章' }).locator('.global-search-article')).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(originHash)
  await page.keyboard.press('Escape')
  await expect(searchDialog(page)).toHaveCount(0)
})

test('跨句正文命中：落到真实段落并整段可视高亮，刷新后仍定位', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })

  // 查询跨过同一段里的两句：任何单独一句都不含整条查询，但段落正文含。
  const crossSentence = 'differently. Approaching'
  await openSearch(page)
  await searchInput(page).fill(crossSentence)
  const articleGroup = page.getByRole('region', { name: '文章' })
  await expect(articleGroup.locator('.global-search-article')).toHaveCount(1)
  const row = articleGroup.locator('.global-search-article')
  await expect(row).toHaveAttribute('data-match', 'body')
  await expect(row.locator('.global-search-snippet mark')).toHaveText(crossSentence)

  await row.click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  const focusedParagraph = page.locator('.reading-paragraph-focused')
  await expect(focusedParagraph).toBeVisible()
  await expect(focusedParagraph).toHaveAttribute('data-paragraph-id', '1')
  await expect(focusedParagraph).toContainText(
    'Employers approach hiring differently. Approaching a new desk takes patience.'
  )
  await expect(focusedParagraph).toBeInViewport()
  // 跨句命中不伪造原句焦点：段落整段标出，句子级高亮仍是 0。
  await expect(page.locator('.reading-sentence-focused')).toHaveCount(0)
  await expect(page.locator('.reading-context')).toContainText('命中正文这一段')
  expect(await page.evaluate(() => window.location.hash)).toContain('search=1')

  // 刷新后 hash 仍带这次搜索定位，段落高亮与滚动目标都还在。
  await page.reload()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  const refreshedParagraph = page.locator('.reading-paragraph-focused')
  await expect(refreshedParagraph).toBeVisible()
  await expect(refreshedParagraph).toBeInViewport()
  await expect(page.locator('.reading-sentence-focused')).toHaveCount(0)
  await expect(page.locator('.reading-context')).toContainText('来自搜索')
})

test('文章篇名命中：进入文章本身，不伪造正文句定位', async ({ launch, userDataDirectory }) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })

  await openSearch(page)
  await searchInput(page).fill('Passage')
  const articleGroup = page.getByRole('region', { name: '文章' })
  await expect(articleGroup.locator('.global-search-article')).toHaveCount(1)
  await expect(articleGroup.locator('.global-search-hit-kind')).toHaveText('篇名')
  await expect(articleGroup.locator('.global-search-snippet mark')).toHaveText('Passage')

  await articleGroup.locator('.global-search-article').click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(
    page.getByRole('heading', { name: '2026年6月 · 第1套 · 仔细阅读 Passage One', level: 1 })
  ).toBeVisible()
  await expect(page.locator('.reading-sentence-focused')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '返回搜索结果' })).toBeVisible()
})

test('AI 生成文章端到端：本地生成 → 存为文章 → 搜正文独有词 → 文章组 → 阅读高亮正确句', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const stub = await createStub({ kind: 'stream', text: [AI_BODY], firstChunkDelayMs: 200 })
  const { page } = await launch({ env: launchEnv(stub) })

  // 真实用户路径：词条页多选 → 生成文章指令 → 发送 → 等回答完成 → 存为文章。
  await openEntries(page)
  await page.getByRole('checkbox', { name: '选择词条：approach' }).check()
  await page.getByRole('checkbox', { name: '选择词条：Context' }).check()
  await page.getByRole('button', { name: '用这些词学习' }).click()
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
  const instructions = page.getByRole('region', { name: '学习指令' })
  await instructions.getByRole('button', { name: '选用指令' }).click()
  await instructions.getByRole('button', { name: '示例：生成文章' }).click()
  await page.getByRole('textbox', { name: '输入问题' }).fill('用这两个词写一篇短文。')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('The luminous lantern marks this line.')).toBeVisible()
  await page.locator('.assistant-actions').getByRole('button', { name: '存为文章' }).click()
  await expect(page.getByText(/已存为文章「/)).toBeVisible()

  const originHash = await page.evaluate(() => window.location.hash)
  await openSearch(page)
  await searchInput(page).fill('luminous')

  const articleGroup = page.getByRole('region', { name: '文章' })
  await expect(articleGroup.locator('.global-search-article')).toHaveCount(1)
  const aiRow = articleGroup.locator('.global-search-article')
  await expect(aiRow).toHaveAttribute('data-source', 'ai')
  await expect(aiRow).toContainText('AI 生成')
  await expect(aiRow.locator('.global-search-hit-kind')).toHaveText('正文')
  await expect(aiRow.locator('.global-search-snippet mark')).toHaveText('luminous')
  // 正文独有词不属于任何词条。
  await expect(page.getByRole('region', { name: '词条' })).toContainText('没有命中的词条。')

  await aiRow.click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.locator('.reading-paragraph')).toHaveCount(2)
  const focused = page.locator('.reading-sentence-focused')
  await expect(focused).toHaveText('The luminous lantern marks this line.')
  await expect(focused).toBeInViewport()
  await expect(page.locator('.reading-context')).toContainText('来自搜索「luminous」')

  // 回到搜索结果：同一查询、同一批结果，底页回到生成文章时所在的线程。
  await page.getByRole('button', { name: '返回搜索结果' }).click()
  await expect(searchDialog(page)).toBeVisible()
  await expect(searchInput(page)).toHaveValue('luminous')
  await expect(articleGroup.locator('.global-search-article')).toHaveCount(1)
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe(originHash)
  await page.keyboard.press('Escape')
  await expect(searchDialog(page)).toHaveCount(0)
  await expect(page.getByText('The luminous lantern marks this line.')).toBeVisible()
})

test('Esc 与点外部关闭：词条的选中、草稿、搜索与排序、滚动都不丢，焦点还回入口', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })

  await openEntries(page)
  await page.getByRole('button', { name: '字母', exact: true }).click()
  await page.getByRole('searchbox', { name: '搜词条名、原句或学习内容' }).fill('approach')
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await expect(
    page.getByRole('region', { name: '词条内容' }).getByRole('heading', { name: 'approach', level: 2 })
  ).toBeVisible()
  await page.getByRole('button', { name: /^词典与学习内容/ }).click()
  const rail = page.locator('.entries-rail-open')
  await expect(rail).toBeVisible()
  await rail.getByRole('textbox', { name: '写学习内容' }).fill('草稿：还没保存的笔记')
  await expect(page.getByRole('button', { name: '字母', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  const hashBefore = await page.evaluate(() => window.location.hash)
  const scrollBefore = await page.evaluate(() => document.querySelector('main')?.scrollTop ?? 0)

  // 点外部关闭：点在遮罩上，不动底页。
  await openSearch(page)
  await searchInput(page).fill('hiring')
  await expect(page.getByRole('region', { name: '词条' }).locator('.global-search-entry')).toHaveCount(1)
  await page.mouse.click(8, 400)
  await expect(searchDialog(page)).toHaveCount(0)

  expect(await page.evaluate(() => window.location.hash)).toBe(hashBefore)
  await expect(
    page.getByRole('region', { name: '词条内容' }).getByRole('heading', { name: 'approach', level: 2 })
  ).toBeVisible()
  await expect(rail.getByRole('textbox', { name: '写学习内容' })).toHaveValue('草稿：还没保存的笔记')
  await expect(page.getByRole('searchbox', { name: '搜词条名、原句或学习内容' })).toHaveValue('approach')
  await expect(page.getByRole('button', { name: '字母', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  expect(await page.evaluate(() => document.querySelector('main')?.scrollTop ?? 0)).toBe(scrollBefore)
  // 焦点回到打开搜索的按钮，而不是把页面滚回顶部。
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''))
    .toBe('全局搜索')

  // Esc 关闭同样不动底页，也不触发任何导航。
  await openSearch(page)
  await searchInput(page).fill('hiring')
  await page.keyboard.press('Escape')
  await expect(searchDialog(page)).toHaveCount(0)
  expect(await page.evaluate(() => window.location.hash)).toBe(hashBefore)
  await expect(
    page.getByRole('region', { name: '词条内容' }).getByRole('heading', { name: 'approach', level: 2 })
  ).toBeVisible()
  await expect(rail.getByRole('textbox', { name: '写学习内容' })).toHaveValue('草稿：还没保存的笔记')
  expect(await page.evaluate(() => document.querySelector('main')?.scrollTop ?? 0)).toBe(scrollBefore)
})

test('阅读页顶栏开搜索：词条卡、设置与定位高亮在 Esc/点外部后原样保留', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })
  await openArticle(page, '2026年6月 · 第1套 · 仔细阅读 Passage One')

  const searchTrigger = page.getByRole('button', { name: '全局搜索' })

  // 阅读设置开着时打开搜索：入口本身的 pointerdown 不能先关掉设置。
  await page.getByRole('button', { name: '阅读设置' }).click()
  await expect(page.locator('.reading-settings')).toBeVisible()
  await searchTrigger.click()
  await expect(searchDialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(searchDialog(page)).toHaveCount(0)
  await expect(page.locator('.reading-settings')).toBeVisible()
  await page.getByRole('button', { name: '阅读设置' }).click()

  // 已收词卡片开着时打开搜索：Esc 与点外部都只关搜索。
  await page.locator('.reading-collected').filter({ hasText: 'approach' }).first().click()
  const panel = page.getByRole('complementary', { name: '词条' })
  await expect(panel).toBeVisible()
  await searchTrigger.click()
  await expect(searchDialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(searchDialog(page)).toHaveCount(0)
  await expect(panel).toBeVisible()

  await searchTrigger.click()
  await expect(searchDialog(page)).toBeVisible()
  await page.mouse.click(6, 300)
  await expect(searchDialog(page)).toHaveCount(0)
  await expect(panel).toBeVisible()

  // 从学习内容回跳的定位高亮同理：开关搜索不撤这句。
  await page.getByRole('button', { name: '关闭' }).click()
  await page.getByRole('button', { name: '返回文章库' }).click()
  await page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await page
    .getByRole('region', { name: '词条内容' })
    .getByRole('button', { name: '回到原文' })
    .first()
    .click()
  await expect(page.locator('.reading-sentence-focused')).toBeVisible()
  await expect(page.locator('.reading-context')).toContainText('来自词条')
  await searchTrigger.click()
  await expect(searchDialog(page)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.reading-sentence-focused')).toBeVisible()
  await expect(page.locator('.reading-context')).toContainText('来自词条')

  // 搜索仍然可以正常点结果导航。
  await searchTrigger.click()
  await searchInput(page).fill('hiring')
  await page.getByRole('region', { name: '词条' }).locator('.global-search-entry').click()
  await expect(
    page.getByRole('region', { name: '词条内容' }).getByRole('heading', { name: 'approach', level: 2 })
  ).toBeVisible()
})

test('对话页从来源回跳后打开搜索：来源横条与被高亮段落都不丢', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  seedSourcePin(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })

  await openEntries(page)
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await page.getByRole('button', { name: /^词典与学习内容/ }).click()
  await page
    .locator('.entry-note')
    .filter({ hasText: 'approach 是接近' })
    .getByRole('button', { name: '看原对话' })
    .click()
  await expect(page.locator('.pin-source-banner')).toBeVisible()
  await expect(page.locator('.assistant-text [data-md-block].is-source-hit')).toHaveCount(1)

  // 从全局栏入口开搜索：入口的 mousedown 不能先清掉来源高亮。
  await openSearch(page)
  await page.keyboard.press('Escape')
  await expect(searchDialog(page)).toHaveCount(0)
  await expect(page.locator('.pin-source-banner')).toBeVisible()
  await expect(page.locator('.assistant-text [data-md-block].is-source-hit')).toHaveCount(1)
})

test('阅读页 Esc：只关搜索，不退出阅读、不改变滚动位置', async ({ launch, userDataDirectory }) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })
  await openArticle(page, '2026年6月 · 第1套 · 仔细阅读 Passage One')
  await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>('.reading-scroll')
    if (scroll) scroll.scrollTop = 260
  })
  const scrollBefore = await page.evaluate(
    () => document.querySelector<HTMLElement>('.reading-scroll')?.scrollTop ?? 0
  )
  const hashBefore = await page.evaluate(() => window.location.hash)

  await openSearch(page)
  await searchInput(page).fill('hiring')
  await page.keyboard.press('Escape')

  await expect(searchDialog(page)).toHaveCount(0)
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  expect(await page.evaluate(() => window.location.hash)).toBe(hashBefore)
  expect(
    await page.evaluate(() => document.querySelector<HTMLElement>('.reading-scroll')?.scrollTop ?? 0)
  ).toBe(scrollBefore)

  // 点外部关闭同样留在阅读页。
  await openSearch(page)
  await searchInput(page).fill('hiring')
  await page.mouse.click(6, 300)
  await expect(searchDialog(page)).toHaveCount(0)
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  expect(await page.evaluate(() => window.location.hash)).toBe(hashBefore)
  expect(
    await page.evaluate(() => document.querySelector<HTMLElement>('.reading-scroll')?.scrollTop ?? 0)
  ).toBe(scrollBefore)
})

test('对话页 Esc：只关搜索，不停止生成、不丢未发送草稿', async ({ launch }) => {
  const stub = await createStub({ kind: 'hang', text: ['Half an answer starts here.'] })
  const { page } = await launch({ env: launchEnv(stub) })
  await openChat(page)
  await page.getByRole('textbox', { name: '输入问题' }).fill('写一段话。')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('Half an answer starts here.')).toBeVisible()
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible()

  await openSearch(page)
  await searchInput(page).fill('anything')
  await page.keyboard.press('Escape')
  await expect(searchDialog(page)).toHaveCount(0)
  // Esc 没有冒泡到对话页：生成仍在继续。
  await expect(page.getByRole('button', { name: '停止生成' })).toBeVisible()
  await expect(page.getByText('Half an answer starts here.')).toBeVisible()

  await page.getByRole('button', { name: '停止生成' }).click()
  await expect(page.getByText('已停止 · 未完成')).toBeVisible()

  // 未发送草稿：开关搜索不影响输入框内容。
  const input = page.getByRole('textbox', { name: '输入问题' })
  await input.fill('还没发出去的草稿')
  await openSearch(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('textbox', { name: '输入问题' })).toHaveValue('还没发出去的草稿')
})

test('加载中、无结果、出错都有明确文案，重试可用', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page, electronApp: app } = await launch({ env: launchEnv() })
  if (app === null) throw new Error('需要开发版 Electron 进程')

  // 慢一点的实现：先看到加载文案，再看到无结果文案。
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('search:global')
    ipcMain.handle('search:global', async (_event, payload: { query: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      return { query: payload.query, entries: [], articles: [] }
    })
  })
  await openSearch(page)
  await searchInput(page).fill('slow')
  await expect(searchDialog(page)).toContainText('正在搜索…')
  await expect(searchDialog(page)).toContainText('没有搜到「slow」。换个词试试。')

  // 实现报错：给一句人话 + 重试。
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('search:global')
    ipcMain.handle('search:global', () => {
      throw new Error('stub search failure')
    })
  })
  await searchInput(page).fill('boom')
  await expect(searchDialog(page).getByRole('alert')).toContainText('搜索没有完成，再试一次。')
  await expect(searchDialog(page).getByRole('button', { name: '重试' })).toBeVisible()

  // 重试发的是同一个查询。
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('search:global')
    ipcMain.handle('search:global', (_event, payload: { query: string }) => ({
      query: payload.query,
      entries: [],
      articles: []
    }))
  })
  await searchDialog(page).getByRole('button', { name: '重试' }).click()
  await expect(searchDialog(page)).toContainText('没有搜到「boom」。换个词试试。')
})

test('同一篇文章的同一句：滚离后再次点同结果重新滚回命中句', async ({
  launch,
  userDataDirectory
}) => {
  const corpus = await mkdtemp(join(tmpdir(), 'english-learning-global-search-repeat-reading-'))
  try {
    const sentences = Array.from({ length: 16 }, (_, index) => [
      `Paragraph number ${index + 1} keeps the reading column tall enough to scroll.`
    ])
    sentences[15] = ['The zebraquill marker appears only in the final paragraph.']
    const longArticle = fixtureArticle({
      id: 'fixture-global-search-repeat-reading',
      year: 2024,
      month: 6,
      set: 1,
      sentences
    })
    writeCorpusDirectory(corpus, [longArticle])
    seedWordEntries(userDataDirectory, corpus, { picks: [] })
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpus } })

    await openSearch(page)
    await searchInput(page).fill('zebraquill')
    await page.getByRole('region', { name: '文章' }).locator('.global-search-article').click()
    const focused = page.locator('.reading-sentence-focused')
    await expect(focused).toHaveText('The zebraquill marker appears only in the final paragraph.')
    await expect(focused).toBeInViewport()
    const targetHash = await page.evaluate(() => window.location.hash)

    // 用户往下读走，让命中句离开视口。
    await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>('.reading-scroll')
      if (scroll) scroll.scrollTop = 0
    })
    await expect(focused).not.toBeInViewport()

    // 同一条结果、同一个 hash：定位仍要重新滚回那一句。
    await openSearch(page)
    await searchInput(page).fill('zebraquill')
    await page.getByRole('region', { name: '文章' }).locator('.global-search-article').click()
    await expect(focused).toBeInViewport()
    expect(await page.evaluate(() => window.location.hash)).toBe(targetHash)
  } finally {
    await rm(corpus, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('同一条词条原句：滚离后再次点同结果重新定位到那一句', async ({
  launch,
  userDataDirectory
}) => {
  const corpus = await mkdtemp(join(tmpdir(), 'english-learning-global-search-repeat-entry-'))
  try {
    const sentences = Array.from({ length: 16 }, (_, index) => [
      `Approach number ${index + 1} gives the entry page a long list to scroll through.`
    ])
    sentences[15] = ['Approach in the final paragraph carries the zebralast marker.']
    const longArticle = fixtureArticle({
      id: 'fixture-global-search-repeat-entry',
      year: 2024,
      month: 6,
      set: 1,
      sentences
    })
    writeCorpusDirectory(corpus, [longArticle])
    seedWordEntries(userDataDirectory, corpus, {
      picks: sentences.map((_, paragraphIndex) => ({
        entry: longArticle,
        paragraphIndex,
        needle: 'Approach'
      }))
    })
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpus } })

    await openEntries(page)
    await page.locator('.entries-row').first().click()
    await expect(
      page.getByRole('region', { name: '词条内容' }).getByRole('heading', { level: 2 })
    ).toBeVisible()

    await openSearch(page)
    await searchInput(page).fill('zebralast')
    await page.getByRole('region', { name: '词条' }).locator('.global-search-entry').click()
    const focused = page.locator('.entry-sentence[data-focused="true"]')
    await expect(focused).toContainText('zebralast')
    await expect(focused).toBeInViewport()
    const targetHash = await page.evaluate(() => window.location.hash)

    await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('main')
      if (main) main.scrollTop = 0
    })
    await expect(focused).not.toBeInViewport()

    await openSearch(page)
    await searchInput(page).fill('zebralast')
    await page.getByRole('region', { name: '词条' }).locator('.global-search-entry').click()
    await expect(focused).toBeInViewport()
    expect(await page.evaluate(() => window.location.hash)).toBe(targetHash)
  } finally {
    await rm(corpus, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('焦点与输入法：Tab 不跑出覆盖层，组合态的 Esc 不关闭搜索', async ({
  launch,
  userDataDirectory
}) => {
  seed(userDataDirectory)
  const { page } = await launch({ env: launchEnv() })

  await openSearch(page)
  // 打开后自动聚焦的输入框必须有可见焦点框：2px 琥珀、外扩 2px，不是默认蓝框也不是没有。
  const focusedInput = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null
    if (active === null) return null
    const style = getComputedStyle(active)
    const probe = document.createElement('span')
    probe.style.color = 'var(--amber)'
    document.body.append(probe)
    const amber = getComputedStyle(probe).color
    probe.remove()
    // 用一条内联的 2px/2px 焦点样式做基准：不同显示缩放下浏览器会把
    // 计算值统一缩放，但作者声明的值仍应与 ui-tokens 的 2px 一致。
    const reference = document.createElement('span')
    reference.style.cssText =
      'position:absolute;visibility:hidden;outline:2px solid transparent;outline-offset:2px'
    document.body.append(reference)
    const referenceStyle = getComputedStyle(reference)
    const referenceWidth = referenceStyle.outlineWidth
    const referenceOffset = referenceStyle.outlineOffset
    reference.remove()
    return {
      className: active.className,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      outlineOffset: style.outlineOffset,
      outlineColor: style.outlineColor,
      amber,
      referenceWidth,
      referenceOffset
    }
  })
  expect(focusedInput?.className).toContain('global-search-input')
  expect(focusedInput?.outlineStyle).toBe('solid')
  expect(focusedInput?.outlineColor).toBe(focusedInput?.amber)
  expect(focusedInput?.outlineWidth).toBe(focusedInput?.referenceWidth)
  expect(focusedInput?.outlineOffset).toBe(focusedInput?.referenceOffset)
  expect(Number.parseFloat(focusedInput?.outlineWidth ?? '0')).toBeGreaterThan(0)

  await searchInput(page).fill('hiring')
  await expect(page.getByRole('region', { name: '词条' }).locator('.global-search-entry')).toHaveCount(1)

  // 从输入框往前 Tab 到关闭按钮与结果行，再 Tab 一圈仍留在覆盖层里。
  let sawResultFocus = false
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press('Tab')
    const active = await page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null
      if (element === null) return null
      const style = getComputedStyle(element)
      return {
        inside: Boolean(document.querySelector('.global-search')?.contains(element)),
        className: element.className,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        outlineOffset: style.outlineOffset
      }
    })
    expect(active?.inside).toBe(true)
    if (active?.className.includes('global-search-entry')) {
      sawResultFocus = true
      expect(active.outlineStyle).toBe('solid')
      expect(active.outlineWidth).toBe(focusedInput?.referenceWidth)
      expect(active.outlineOffset).toBe(focusedInput?.referenceOffset)
    }
  }
  expect(sawResultFocus).toBe(true)

  // 输入法组合态里的 Esc 交给输入法，不关闭搜索。
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('.global-search-input')
    input?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        isComposing: true,
        bubbles: true,
        cancelable: true
      })
    )
  })
  await expect(searchDialog(page)).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(searchDialog(page)).toHaveCount(0)
})
