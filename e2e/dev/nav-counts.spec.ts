import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { openDatabase } from '../../src/main/db/database'
import { createPin } from '../../src/main/pins/pins'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { databasePath } from '../fixtures/database'
import { seedAnsweredThread } from '../fixtures/chat'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'
import { clickAway, selectText } from '../fixtures/reading'

/**
 * T20 全局栏计数：词条数、文章数与未归档数。
 *
 * 这里只走真实 Electron：真实 SQLite、真实 IPC 与真实界面操作，不用 bridge mock
 * 替代关键写路径。计数必须与各页面自己的列表口径一致；读回来之前界面不显示 0。
 */

const articleA = fixtureArticle({
  id: 'fixture-counts-nav-a',
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['Context keeps the skill alive.', 'Repeated words stick.']
  ]
})

const articleB = fixtureArticle({
  id: 'fixture-counts-nav-b',
  label: '2024年12月 · 第2套 · 仔细阅读 Passage Two',
  year: 2024,
  month: 12,
  set: 2,
  sentences: [['Another article offers a different perspective.']]
})

let corpusDirectory: string
const stubs: SseStub[] = []

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-nav-counts-'))
  writeCorpusDirectory(corpusDirectory, [articleA, articleB])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

function nav(page: Page) {
  return page.getByRole('navigation', { name: '全局导航' })
}

function navCount(page: Page, key: 'entries' | 'articles' | 'unfiled') {
  return nav(page).locator(`[data-nav-count="${key}"]`)
}

async function expectCounts(
  page: Page,
  counts: { entries: number; articles: number; unfiled: number }
): Promise<void> {
  await expect(navCount(page, 'entries')).toHaveText(String(counts.entries))
  await expect(navCount(page, 'articles')).toHaveText(String(counts.articles))
  await expect(navCount(page, 'unfiled')).toHaveText(String(counts.unfiled))
}

test('全局栏显示词条/文章/未归档计数；0 显示 0，读回来之前不显示假 0', async ({
  launch
}) => {
  const handle = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const page = handle.page

  // 空库：2 篇语料文章，0 个词条、0 条未归档。
  await expectCounts(page, { entries: 0, articles: 2, unfiled: 0 })

  // 六个导航按钮的可访问名称保持原标签，数字是独立元素，不改名。
  await expect(nav(page).getByRole('button', { name: '词条', exact: true })).toBeVisible()
  await expect(nav(page).getByRole('button', { name: '文章库', exact: true })).toBeVisible()

  // 对话的数字是「未归档」的钉住，不是线程数：读屏描述与可见悬停说明都不能写成「对话 N 个」。
  const chatButton = nav(page).getByRole('button', { name: '对话', exact: true })
  await expect(chatButton).toHaveAttribute('aria-describedby', 'nav-count-unfiled')
  await expect(chatButton).toHaveAttribute('title', '未归档 0 条')
  await expect(page.locator('#nav-count-unfiled')).toHaveText('未归档 0 条')
  await expect(page.locator('#nav-count-entries')).toHaveText('词条 0 个')
  await expect(page.locator('#nav-count-articles')).toHaveText('文章 2 篇')

  // 把计数查询换成一个慢回复：数字到齐之前不能先摆一个 0。
  if (handle.electronApp === null) throw new Error('开发态用例拿不到主进程句柄')
  await handle.electronApp.evaluate(({ ipcMain }, counts) => {
    ipcMain.removeHandler('counts:summary')
    ipcMain.handle('counts:summary', async () => {
      await new Promise((resolve) => setTimeout(resolve, 4000))
      return counts
    })
    return true
  }, { entries: 5, articles: 2, unfiled: 3 })

  await page.reload()
  await expect(nav(page)).toBeVisible()
  await expect(nav(page).locator('.nav-count')).toHaveCount(0)
  await expect(nav(page).getByRole('button', { name: '词条', exact: true })).toHaveText('词条')

  // 计数还在等：导航照常响应，不被这条异步查询挡住。
  await nav(page).getByRole('button', { name: '文章库' }).click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await nav(page).getByRole('button', { name: '首页' }).click()
  await expect(page.getByRole('heading', { name: '先读一篇' })).toBeVisible()

  // 慢回复到齐后才出现数字，且就是这次读到的数。
  await expectCounts(page, { entries: 5, articles: 2, unfiled: 3 })
})

async function selectLibraryArticle(page: Page, label: string): Promise<void> {
  const [session, set, kind] = label.split(' · ')
  const sessionSection = page.locator('.library-session').filter({ has: page.getByRole('button', { name: new RegExp(`^${session} `) }) })
  const sessionToggle = sessionSection.locator('.library-session-head button')
  if (await sessionToggle.getAttribute('aria-expanded') === 'false') await sessionToggle.click()
  const setToggle = sessionSection.getByRole('button', { name: new RegExp(`^${set} `) })
  if (await setToggle.getAttribute('aria-expanded') === 'false') await setToggle.click()
  await sessionSection.locator('.library-row').filter({ hasText: kind }).click()
}

/** 从文章库按篇名打开一篇；阅读页收起全局栏，所以先走文章库再进正文。 */
async function openArticleByLabel(page: Page, label: string): Promise<void> {
  await nav(page).getByRole('button', { name: '文章库' }).click()
  await selectLibraryArticle(page, label)
  await page
    .getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' })
    .click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
}

test('初次计数失败后换页恢复：不显示假 0，也不阻塞导航', async ({ launch }) => {
  const handle = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const { page, electronApp } = handle
  if (electronApp === null) throw new Error('开发态用例拿不到主进程句柄')
  await expectCounts(page, { entries: 0, articles: 2, unfiled: 0 })

  // 只在刷新后的第一次查询失败，之后正常返回；从这一刻起计数只能靠换页重查恢复。
  await electronApp.evaluate(({ ipcMain }, counts) => {
    let calls = 0
    ipcMain.removeHandler('counts:summary')
    ipcMain.handle('counts:summary', () => {
      calls += 1
      if (calls === 1) throw new Error('temporary count failure')
      return counts
    })
  }, { entries: 5, articles: 2, unfiled: 3 })

  await page.reload()
  await expect(nav(page)).toBeVisible()
  // 失败之后是「还没有数字」，不能把 0 当结果。
  await expect(nav(page).locator('.nav-count')).toHaveCount(0)

  // 失败的异步查询不挡导航：页面照常打开。
  await nav(page).getByRole('button', { name: '文章库' }).click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()

  // 进入新页面时非阻塞重查，读到真实数字后恢复。
  await expectCounts(page, { entries: 5, articles: 2, unfiled: 3 })
})

test('已有旧数字时重查失败保留旧数，再次换页后按新数恢复', async ({ launch }) => {
  const handle = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const { page, electronApp } = handle
  if (electronApp === null) throw new Error('开发态用例拿不到主进程句柄')
  await expectCounts(page, { entries: 0, articles: 2, unfiled: 0 })

  // 下次重查失败：旧数字必须留着，不退回 0、也不变成空白。
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('counts:summary')
    ipcMain.handle('counts:summary', () => {
      throw new Error('temporary count failure')
    })
  })
  await nav(page).getByRole('button', { name: '文章库' }).click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await expectCounts(page, { entries: 0, articles: 2, unfiled: 0 })

  // 查询恢复后，再换一次页就读到新数字。
  await electronApp.evaluate(({ ipcMain }, counts) => {
    ipcMain.removeHandler('counts:summary')
    ipcMain.handle('counts:summary', () => counts)
  }, { entries: 7, articles: 2, unfiled: 1 })
  await nav(page).getByRole('button', { name: '首页' }).click()
  await expect(page.getByRole('heading', { name: '先读一篇' })).toBeVisible()
  await expectCounts(page, { entries: 7, articles: 2, unfiled: 1 })
})

test('收词后词条数即时更新；稍后看不计数；删最后一句连词条删、钉住退回未归档', async ({
  launch
}) => {
  const stub = await startSseStub({
    kind: 'stream',
    text: ['第一段：approach 在这里表示接近，也可以指处理问题的方法。']
  })
  stubs.push(stub)
  const { page } = await launch({
    env: {
      CORPUS_DIRECTORY: corpusDirectory,
      DEEPSEEK_BASE_URL: stub.baseUrl,
      DEEPSEEK_API_KEY: 'e2e-test-key',
      DEEPSEEK_MODEL: 'deepseek-flash'
    }
  })

  // 在真实阅读页圈词：收下之后切回有全局栏的页面，词条数已经是 1。
  await openArticleByLabel(page, '2024年6月 · 第1套 · 仔细阅读 Passage One')
  await selectText(page, 0, 'approach')
  await expect(page.locator('.reading-selected').filter({ hasText: 'approach' })).toBeVisible()
  await clickAway(page)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 0 })

  // 稍后看只写独立标记，三个计数都不变。
  await nav(page).getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  const entryContent = page.getByRole('region', { name: '词条内容' })
  await entryContent.getByRole('button', { name: '稍后看', exact: true }).click()
  await expect(
    entryContent.getByRole('button', { name: '取消稍后看', exact: true })
  ).toBeVisible()
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 0 })

  // 从词条开对话，把整条回答钉到这个词条：未归档仍是 0。
  await page.getByRole('button', { name: '开始对话' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  await page.getByRole('textbox', { name: '输入问题' }).fill('approach 怎么用？')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.locator('.assistant-text')).toContainText('approach 在这里表示接近')
  await page.locator('.assistant-actions').getByRole('button', { name: '钉住' }).click()
  const pinDialog = page.getByRole('dialog', { name: '钉到哪儿' })
  await expect(pinDialog.getByRole('button', { name: /词条 · approach/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await pinDialog.getByRole('button', { name: '钉住', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已钉到词条 approach')
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 0 })

  // 删掉这个词条唯一一条原句：词条消失，钉在这条词条上的钉住退回未归档。
  await nav(page).getByRole('button', { name: '词条' }).click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  const sentence = page.locator('.entry-sentence').first()
  await sentence.getByRole('button', { name: '删除' }).click()
  const removeDialog = page.getByRole('alertdialog', { name: '删除最后一条原句' })
  await removeDialog.getByRole('button', { name: '删除词条与原句' }).click()
  await expect(page.getByText('原句与「approach」已删除。')).toBeVisible()

  await expectCounts(page, { entries: 0, articles: 2, unfiled: 1 })
})

const PIN_ANSWER = '第一段：approach 是接近。\n\n第二段：complain 只是抱怨。'

const picks: SeedPick[] = [
  { entry: articleA, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' }
]

/** 种一个 approach 词条与一条线程，线程里两条未归档钉住。 */
function seedUnfiledPins(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    const entry = database
      .prepare("SELECT id FROM word_entry WHERE main_form = 'approach'")
      .get() as { id: string }
    const { threadId, answerId } = seedAnsweredThread(database, {
      main: { kind: 'entry', entryId: entry.id },
      question: '这句怎么理解？',
      answer: PIN_ANSWER,
      model: 'fixture-model'
    })
    for (const needle of ['approach', 'complain']) {
      const start = PIN_ANSWER.indexOf(needle)
      const pinned = createPin(database, {
        threadId,
        answerId,
        start,
        end: start + needle.length,
        target: { kind: 'unfiled' }
      })
      if (pinned.status !== 'pinned') throw new Error('没钉上')
    }
  } finally {
    database.close()
  }
}

test('钉住/撤销/归位/移动/丢弃/批量归位后未归档数即时更新，删线程保留钉住', async ({
  launch,
  userDataDirectory
}) => {
  seedUnfiledPins(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 2 })
  // 有真实未归档时，读屏描述仍是「未归档 N 条」，不写成线程数。
  await expect(nav(page).getByRole('button', { name: '对话', exact: true })).toHaveAttribute(
    'title',
    '未归档 2 条'
  )
  await expect(page.locator('#nav-count-unfiled')).toHaveText('未归档 2 条')

  const board = page.getByRole('complementary', { name: '钉板' })
  await nav(page).getByRole('button', { name: '对话' }).click()
  await page.locator('.thread-row').filter({ hasText: 'approach' }).click()

  // 钉住一条到未归档再撤销：未归档先加一、再减回去。
  await page.locator('.assistant-actions').getByRole('button', { name: '钉住' }).click()
  const createDialog = page.getByRole('dialog', { name: '钉到哪儿' })
  await createDialog.getByRole('button', { name: '未归档', exact: true }).click()
  await createDialog.getByRole('button', { name: '钉住', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已放进未归档')
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 3 })
  await page.getByRole('button', { name: '撤销' }).click()
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 2 })

  await board.getByRole('button', { name: '未归档 2', exact: true }).click()
  await expect(page.getByRole('tab', { name: '未归档 2' })).toBeVisible()

  // 丢弃一条再撤销：未归档先减后回。
  await page.locator('.pin-card').first().getByRole('button', { name: '丢弃' }).click()
  await expect(page.getByRole('status')).toContainText('已丢弃')
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 1 })
  await page.getByRole('button', { name: '撤销' }).click()
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 2 })

  // 归到词条：未归档减一，词条数不变。
  await page.locator('.pin-card').first().getByRole('button', { name: '归到词条' }).click()
  const fileDialog = page.getByRole('dialog', { name: '归到哪儿' })
  await expect(fileDialog.getByRole('button', { name: /词条 · approach/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await fileDialog.getByRole('button', { name: '归位' }).click()
  await expect(page.getByRole('status')).toContainText('已归到 approach')
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 1 })

  // 换落点（移动）把这条已归位的钉住移回未归档：未归档加一。
  await page.getByRole('tab', { name: '当前对话' }).click()
  const moved = page.locator('.pin-card').first()
  await moved.getByRole('button', { name: '换落点' }).click()
  const moveDialog = page.getByRole('dialog', { name: '换落点' })
  await moveDialog.getByRole('button', { name: '未归档', exact: true }).click()
  await moveDialog.getByRole('button', { name: '换到这儿' }).click()
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 2 })

  // 删除对话：钉住按快照保留，未归档数不误减，词条数也不变。
  const list = page.getByRole('complementary', { name: '对话列表' })
  await list.getByRole('button', { name: '删除对话：approach' }).click()
  const deleteDialog = page.getByRole('dialog', { name: '删除对话' })
  await deleteDialog.getByRole('button', { name: '删除对话', exact: true }).click()
  await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 2 })

  // 空白线程里全部归位：未归档归零；撤销再回到 2。
  await board.getByRole('button', { name: '未归档 2', exact: true }).click()
  await expect(page.getByRole('tab', { name: '未归档 2' })).toBeVisible()
  await page.getByRole('button', { name: '全部归位' }).click()
  const fileAllDialog = page.getByRole('dialog', { name: '全部未归档归到哪儿' })
  await expect(fileAllDialog.getByRole('button', { name: /词条 · approach/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await fileAllDialog.getByRole('button', { name: '全部归位' }).click()
  await expect(page.getByRole('status')).toContainText('已将 2 条归位')
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 0 })
  await page.getByRole('button', { name: '撤销' }).click()
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 2 })
})

/** 种一个词条，再把一条钉住挂到 articleA 上。 */
function seedArticlePin(userDataDirectory: string, corpus: string): void {
  seedWordEntries(userDataDirectory, corpus, { picks })
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    const { threadId, answerId } = seedAnsweredThread(database, {
      main: { kind: 'none' },
      question: '这篇怎么读？',
      answer: PIN_ANSWER,
      model: 'fixture-model'
    })
    const pinned = createPin(database, {
      threadId,
      answerId,
      start: 0,
      end: PIN_ANSWER.indexOf('\n'),
      target: { kind: 'article', articleId: articleA.id }
    })
    if (pinned.status !== 'pinned') throw new Error('没钉上')
  } finally {
    database.close()
  }
}

test('删除文章时文章数减一、消失的词条数减一、挂在本篇的钉住退回未归档；重新导入不复活', async ({
  launch,
  userDataDirectory
}) => {
  // 多放一篇坏语料：文章库里出现「重新导入」入口，正文所在篇仍正常导入。
  const brokenCorpus = await mkdtemp(join(tmpdir(), 'english-learning-nav-counts-broken-'))
  try {
    const broken = fixtureArticle({ id: 'fixture-counts-broken', sentences: [['Broken text.']] })
    const paragraphs = broken.json.paragraphs as { sentences: { text: string }[] }[]
    paragraphs[0]!.sentences[0]!.text = 'A sentence that no longer matches.'
    writeCorpusDirectory(brokenCorpus, [articleA, articleB, broken])
    seedArticlePin(userDataDirectory, brokenCorpus)
    const { page } = await launch({ env: { CORPUS_DIRECTORY: brokenCorpus } })
    await expectCounts(page, { entries: 1, articles: 2, unfiled: 0 })

    await nav(page).getByRole('button', { name: '文章库' }).click()
    await selectLibraryArticle(page, '2024年6月 · 第1套 · 仔细阅读 Passage One')
    const detail = page.getByRole('complementary', { name: '文章详情' })
    await detail.getByRole('button', { name: '删除文章' }).click()
    const dialog = page.getByRole('alertdialog', { name: '删除文章' })
    await expect(dialog).toContainText('1 条钉住会移到未归档')
    await dialog.getByRole('button', { name: '确认删除' }).click()
    await expect(page.getByText('文章已删除。')).toBeVisible()

    await expectCounts(page, { entries: 0, articles: 1, unfiled: 1 })

    // 重新导入语料：删掉的 id 有标记，不会复活；坏的那篇仍失败，计数原样。
    await page.getByRole('button', { name: '重新导入' }).click()
    await expect(
      page.getByRole('status').filter({ hasText: '重新导入完成' })
    ).toContainText('重新导入完成')
    await expectCounts(page, { entries: 0, articles: 1, unfiled: 1 })
  } finally {
    await rm(brokenCorpus, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('存为 AI 文章后文章数即时加一，词条与未归档不变', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const stub = await startSseStub({
    kind: 'stream',
    text: ['Approach shapes how we read. Context keeps the meaning alive.']
  })
  stubs.push(stub)
  const { page } = await launch({
    env: {
      CORPUS_DIRECTORY: corpusDirectory,
      DEEPSEEK_BASE_URL: stub.baseUrl,
      DEEPSEEK_API_KEY: 'e2e-test-key',
      DEEPSEEK_MODEL: 'deepseek-flash'
    }
  })
  await expectCounts(page, { entries: 1, articles: 2, unfiled: 0 })

  await nav(page).getByRole('button', { name: '词条' }).click()
  await page.getByRole('checkbox', { name: '选择词条：approach' }).check()
  await page.getByRole('button', { name: '用这些词学习' }).click()
  await expect(page.getByRole('heading', { name: /^approach/, level: 1 })).toBeVisible()
  await page.getByRole('textbox', { name: '输入问题' }).fill('用这个词写一篇短文。')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('Approach shapes how we read.')).toBeVisible()

  await page.locator('.assistant-actions').getByRole('button', { name: '存为文章' }).click()
  await expect(page.getByText(/已存为文章「/)).toBeVisible()
  await expectCounts(page, { entries: 1, articles: 3, unfiled: 0 })

  await nav(page).getByRole('button', { name: '文章库' }).click()
  await expect(page.locator('.library-count')).toHaveText('3 篇 · 2 个场次')
})

/** 系统对话框在 E2E 里没法点：换成直接返回用例给的路径。 */
async function stubSaveDialog(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (async () => ({
      canceled: false,
      filePath
    })) as unknown as typeof dialog.showSaveDialog
  }, file)
}

async function stubOpenDialog(app: ElectronApplication, file: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [filePath]
    })) as unknown as typeof dialog.showOpenDialog
  }, file)
}

async function openDataSection(page: Page): Promise<void> {
  await nav(page).getByRole('button', { name: '设置' }).click()
  await page
    .getByRole('complementary', { name: '设置分区' })
    .getByRole('button', { name: '数据' })
    .click()
  await expect(page.getByRole('heading', { name: '数据' })).toBeVisible()
}

test('从备份恢复后三个计数按恢复的整库重读', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const workspace = await mkdtemp(join(tmpdir(), 'english-learning-nav-counts-backup-'))
  try {
    const backupFile = join(workspace, 'nav-counts-backup.db')
    const handle = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    const { page, electronApp } = handle
    if (electronApp === null) throw new Error('开发态用例拿不到主进程句柄')
    await expectCounts(page, { entries: 1, articles: 2, unfiled: 0 })

    await openDataSection(page)
    await stubSaveDialog(electronApp, backupFile)
    await page.getByRole('button', { name: '立即备份' }).click()
    await expect(page.getByRole('status')).toContainText('已备份到 nav-counts-backup.db')

    // 备份后删掉一篇文章：文章数与词条数都少了。
    await nav(page).getByRole('button', { name: '文章库' }).click()
    await selectLibraryArticle(page, '2024年6月 · 第1套 · 仔细阅读 Passage One')
    await page
      .getByRole('complementary', { name: '文章详情' })
      .getByRole('button', { name: '删除文章' })
      .click()
    await page
      .getByRole('alertdialog', { name: '删除文章' })
      .getByRole('button', { name: '确认删除' })
      .click()
    await expectCounts(page, { entries: 0, articles: 1, unfiled: 0 })

    // 恢复备份：整库换回备份那一刻，界面重新载入，三个数跟着回来。
    await openDataSection(page)
    await stubOpenDialog(electronApp, backupFile)
    await page.getByRole('button', { name: '从备份恢复…' }).click()
    const confirm = page.getByRole('alertdialog', { name: '确认恢复' })
    const reloaded = page.waitForEvent('load')
    await confirm.getByRole('button', { name: '恢复' }).click()
    await reloaded
    await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
    await expectCounts(page, { entries: 1, articles: 2, unfiled: 0 })
  } finally {
    await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})
