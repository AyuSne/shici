import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { askQuestion, createGroupThread, saveAnswer } from '../../src/main/chat/threads'
import { openDatabase } from '../../src/main/db/database'
import {
  fixtureArticle,
  writeCorpusDirectory,
  type FixtureEntry
} from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { selectAnswerText } from '../fixtures/answer-selection'
import { databasePath } from '../fixtures/database'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'

/**
 * #83 对话页减负：无顶栏重复钉板按钮、左栏可折叠、选区正上方胶囊、
 * 组词上下文智能预选、手动改选优先、钉住竖线动效与可搜索落点。
 */
const article = fixtureArticle({
  id: 'fixture-craft-83-chat',
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['She approached the counter quietly.', 'The approachable clerk smiled.'],
    ['Context keeps the skill alive.']
  ]
})

const ANSWER = 'The approached form means came near, while Context is different.'

type JsonParagraph = {
  id: string
  sentences: { ordinal: number; start: number; end: number }[]
}

function selectionOf(entry: FixtureEntry, paragraphIndex: number, needle: string) {
  const paragraph = (entry.json.paragraphs as JsonParagraph[])[paragraphIndex]!
  const text = (entry.json.paragraphs as { text: string }[])[paragraphIndex]!.text
  const start = text.indexOf(needle)
  const sentenceOrdinal = paragraph.sentences.findIndex(
    (candidate) => candidate.start <= start && start < candidate.end
  )
  return {
    articleId: entry.id,
    paragraphId: paragraph.id,
    sentenceOrdinal,
    start,
    end: start + needle.length
  }
}

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-craft-83-chat-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const picks: SeedPick[] = [
  { entry: article, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
  { entry: article, paragraphIndex: 1, needle: 'approached', at: '2026-11-18T08:05:00.000Z' },
  { entry: article, paragraphIndex: 2, needle: 'Context', at: '2026-11-18T08:10:00.000Z' }
]
void selectionOf

/** 在测试库里建一条带两个词上下文的组词对话，回答已落库。 */
function seedGroupThread(userDataDirectory: string): string {
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    const rows = database.prepare('SELECT id, main_form FROM word_entry').all() as {
      id: string
      main_form: string
    }[]
    const approach = rows.find((row) => row.main_form === 'approach')!
    const context = rows.find((row) => row.main_form === 'Context')!
    const created = createGroupThread(database, {
      entryIds: [approach.id, context.id]
    })
    if (created.status !== 'created') throw new Error('组词线程没建起来')
    const asked = askQuestion(database, {
      threadId: created.thread.id,
      text: '这两个词怎么区分？'
    })
    if (asked.status !== 'asked') throw new Error('问题没写进去')
    const saved = saveAnswer(database, {
      threadId: created.thread.id,
      questionId: asked.questionId,
      text: ANSWER,
      thinking: '',
      phase: 'done'
    })
    if (saved.status !== 'saved') throw new Error('回答没写进去')
    return created.thread.id
  } finally {
    database.close()
  }
}

async function launchChat(
  launch: (options?: { env?: Record<string, string> }) => Promise<{ page: Page }>,
  userDataDirectory: string
): Promise<{ page: Page; threadId: string }> {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const threadId = seedGroupThread(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.evaluate((id) => {
    window.location.hash = `#/chat/${id}`
  }, threadId)
  await expect(page.locator('.assistant-text')).toContainText('The approached form')
  return { page, threadId }
}

async function selectAndPin(page: Page, needle: string): Promise<void> {
  await selectAnswerText(page, needle)
  const capsule = page.locator('.selection-capsule')
  await expect(capsule).toBeVisible()
  await capsule.getByRole('button', { name: '钉住', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '钉到哪儿' })).toBeVisible()
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
        window.setContentSize(size.width, 900)
      },
      { width, height: 900 }
    )
  } else {
    await page.setViewportSize({ width, height: 900 })
  }
  await expect
    .poll(() => page.evaluate(() => window.innerWidth), { timeout: 5_000 })
    .toBeLessThanOrEqual(width + 2)
  await page.waitForTimeout(200)
}

test('选中回答片段：正上方胶囊只有钉住/追问/复制，追问把选段带进上下文', async ({
  launch,
  userDataDirectory
}) => {
  const { page } = await launchChat(launch, userDataDirectory)

  await selectAnswerText(page, 'approached')
  const capsule = page.locator('.selection-capsule')
  await expect(capsule).toBeVisible()
  await expect(capsule.getByRole('button')).toHaveText(['钉住', '追问', '复制'])
  await expect(capsule.getByRole('button', { name: '释义' })).toHaveCount(0)

  // 浮在选区正上方，而不是页面底部。
  const selectionRect = await page.evaluate(() => {
    const range = window.getSelection()?.getRangeAt(0)
    if (!range) throw new Error('没有选区')
    const rect = range.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom }
  })
  const capsuleBox = await capsule.boundingBox()
  expect(capsuleBox).not.toBeNull()
  expect(capsuleBox!.y + capsuleBox!.height).toBeLessThanOrEqual(selectionRect.top + 1)
  expect(selectionRect.bottom).toBeGreaterThan(selectionRect.top)

  await capsule.getByRole('button', { name: '追问' }).click()
  await expect(
    page.locator('.context-chip-label').filter({ hasText: /^追问$/ })
  ).toHaveCount(1)
  await expect(page.getByRole('textbox', { name: '输入问题' })).toBeFocused()
})

test('组词上下文钉住：按主词形与变体唯一命中自动预选；手动改选后以手动落点为准', async ({
  launch,
  userDataDirectory
}) => {
  const { page } = await launchChat(launch, userDataDirectory)

  // 选中变体 approached：上下文里有 approach 与 Context，但只有 approach 收过这个词形。
  await selectAndPin(page, 'approached')
  const dialog = page.getByRole('dialog', { name: '钉到哪儿' })
  await expect(dialog.getByRole('button', { name: /^词条 · approach$/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )

  // 手动改选 Context 并用 Enter 从搜索选择器选中。
  const picker = dialog.getByRole('combobox', { name: '选择词条' })
  await picker.fill('con')
  const listbox = dialog.getByRole('listbox', { name: '选择词条候选' })
  await expect(listbox.getByRole('option')).toHaveCount(1)
  await picker.press('Enter')
  await expect(dialog.locator('.target-picker-current')).toContainText('Context')
  await dialog.getByRole('button', { name: '钉住', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('已钉到词条 Context')

  // 下一段仍选中 approached：手动落点优先于智能预选。
  await selectAndPin(page, 'approached')
  const nextDialog = page.getByRole('dialog', { name: '钉到哪儿' })
  await expect(nextDialog.getByRole('button', { name: /^词条 · Context$/ })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  await nextDialog.getByRole('button', { name: '取消' }).click()
})

test('钉住落点可搜索文章；钉住后 260ms 琥珀竖线自上而下，边缘拉手取代顶栏开关', async ({
  launch,
  userDataDirectory
}) => {
  const { page } = await launchChat(launch, userDataDirectory)

  await selectAndPin(page, 'approached')
  const dialog = page.getByRole('dialog', { name: '钉到哪儿' })
  await dialog.getByRole('button', { name: /^文章 · / }).click()
  const articlePicker = dialog.getByRole('combobox', { name: '选择文章' })
  await articlePicker.fill('2024')
  const options = dialog.getByRole('listbox', { name: '选择文章候选' })
  await expect(options.getByRole('option')).toHaveCount(1)
  await articlePicker.press('ArrowDown')
  await articlePicker.press('Enter')
  await expect(dialog.locator('.target-picker-current')).toContainText('2024')
  await dialog.getByRole('button', { name: '钉住', exact: true }).click()

  // 顶栏不再有第二个钉板开关；右边缘拉手带微点，点开就是钉板。
  await expect(page.getByRole('button', { name: /钉板 \d+ · 本对话/ })).toHaveCount(0)
  const handle = page.getByRole('button', { name: /^钉板 / })
  await expect(handle.locator('.pin-board-dot')).toBeVisible()
  await handle.click()
  await expect(page.getByRole('complementary', { name: '钉板' })).toBeVisible()
  await expect(page.locator('.pin-card')).toHaveCount(1)

  const pinned = page.locator('.assistant-text .is-pinned').first()
  await expect(pinned).toBeVisible()
  const animation = await pinned.evaluate((element) => {
    const style = getComputedStyle(element, '::before')
    return { name: style.animationName, duration: style.animationDuration }
  })
  expect(animation.name).toBe('pin-line-draw')
  expect(animation.duration).toBe('0.26s')
})

test('1280px 打开钉板时左栏一键折叠/展开，正文不被挤窄', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const threadId = seedGroupThread(userDataDirectory)
  const launched = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  const { page, electronApp } = launched
  await resizeTo(page, electronApp ?? null, 1280)
  await page.evaluate((id) => {
    window.location.hash = `#/chat/${id}`
  }, threadId)
  await expect(page.locator('.assistant-text')).toContainText('The approached form')

  const rail = page.getByRole('complementary', { name: '对话列表' })
  const toggle = page.getByRole('button', { name: '对话列表' })
  await expect(toggle).toBeVisible()
  await expect(rail).toBeVisible()
  const openWidth = (await page.locator('.chat-main').boundingBox())!.width

  await page.getByRole('button', { name: /^钉板 / }).click()
  await expect(page.getByRole('complementary', { name: '钉板' })).toBeVisible()
  const squeezed = (await page.locator('.chat-main').boundingBox())!.width
  expect(squeezed).toBeLessThan(openWidth)

  await toggle.click()
  await expect(page.locator('.chat-page')).toHaveAttribute('data-rail-collapsed', 'true')
  await expect(rail).toBeHidden()
  await expect
    .poll(async () => (await page.locator('.chat-main').boundingBox())?.width ?? 0)
    .toBeGreaterThan(squeezed + 200)
  expect((await page.locator('.chat-main').boundingBox())!.width).toBeGreaterThanOrEqual(680)
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    inner: window.innerWidth
  }))
  expect(overflow.document).toBeLessThanOrEqual(overflow.inner + 1)

  await toggle.click()
  await expect(rail).toBeVisible()
})
