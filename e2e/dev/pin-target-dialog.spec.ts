import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/database'
import { migrate } from '../../src/main/db/migrations'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { selectAnswerRange } from '../fixtures/answer-selection'
import { seedWordGroupThread } from '../fixtures/chat'
import { databasePath } from '../fixtures/database'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'
import { openArticle } from '../fixtures/reading'

/**
 * #83 AC7 / #79：钉住弹层的落点预选、单次 Enter 落钉与输入法组合态。
 * 真实 Electron 窗口里从划选、点「钉住」、等待预选到按 Enter，全部走用户路径。
 */

const TITLE = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-pin-enter',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE,
  sentences: [
    ['The alpha value appears first.', 'The bravo value appears next.'],
    ['Both alpha and bravo are useful.']
  ]
})

const picks: SeedPick[] = [
  { entry: article, paragraphIndex: 0, needle: 'alpha', at: '2026-11-18T08:00:00.000Z' },
  { entry: article, paragraphIndex: 0, needle: 'bravo', at: '2026-11-18T08:05:00.000Z' }
]

const ANSWER = 'The alpha value and the bravo value both matter here.'

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-pin-enter-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

type Seeded = { threadId: string; answerId: string }

function entryIds(userDataDirectory: string): { alpha: string; bravo: string } {
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    migrate(database)
    const read = (mainForm: string): string => {
      const row = database
        .prepare('SELECT id FROM word_entry WHERE main_form = ?')
        .get(mainForm) as { id: string } | undefined
      if (!row) throw new Error(`没有词条 ${mainForm}`)
      return row.id
    }
    return { alpha: read('alpha'), bravo: read('bravo') }
  } finally {
    database.close()
  }
}

function seedGroup(userDataDirectory: string, main?: { kind: 'article'; articleId: string }): Seeded {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const ids = entryIds(userDataDirectory)
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    migrate(database)
    return seedWordGroupThread(database, {
      entries: [
        { entryId: ids.alpha, mainForm: 'alpha' },
        { entryId: ids.bravo, mainForm: 'bravo' }
      ],
      question: '这两个词怎么用？',
      answer: ANSWER,
      ...(main === undefined ? {} : { main })
    })
  } finally {
    database.close()
  }
}

async function boardCount(page: import('@playwright/test').Page, threadId: string): Promise<number> {
  return page.evaluate(async (id) => {
    const api = (window as unknown as {
      api: { invoke(channel: string, payload: unknown): Promise<unknown> }
    }).api
    const board = (await api.invoke('pins:board', { threadId: id })) as {
      threadPins: unknown[]
      unfiledPins: unknown[]
    }
    return board.threadPins.length + board.unfiledPins.length
  }, threadId)
}

async function openSeededThread(
  page: import('@playwright/test').Page,
  threadId: string
): Promise<void> {
  await page.evaluate((id) => {
    window.location.hash = `#/chat/${id}`
  }, threadId)
  await expect(page.locator('.assistant-text[data-answer-id] p')).toContainText('alpha')
}

const dialogOf = (page: import('@playwright/test').Page) =>
  page.getByRole('dialog', { name: '钉到哪儿' })

async function selectAndOpenDialog(
  page: import('@playwright/test').Page,
  text: string,
  container?: string
): Promise<ReturnType<typeof dialogOf>> {
  await selectAnswerRange(
    page,
    { selector: '.assistant-text[data-answer-id] p', text },
    { selector: '.assistant-text[data-answer-id] p', text, edge: 'end' },
    container === undefined ? {} : { container }
  )
  await page
    .locator('.selection-capsule')
    .getByRole('button', { name: '钉住', exact: true })
    .click()
  const dialog = dialogOf(page)
  await expect(dialog).toBeVisible()
  return dialog
}

test('预选就绪后单个 Enter 只落一颗钉', async ({ launch, userDataDirectory }) => {
  const seeded = seedGroup(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openSeededThread(page, seeded.threadId)

  const dialog = await selectAndOpenDialog(page, 'alpha')
  await expect(dialog.locator('.target-picker-current')).toContainText('alpha')
  await expect(dialog.getByRole('button', { name: '钉住', exact: true })).toBeEnabled()

  await page.keyboard.press('Enter')

  await expect(page.getByText('已钉到词条 alpha')).toBeVisible()
  await expect(dialog).toHaveCount(0)
  expect(await boardCount(page, seeded.threadId)).toBe(1)
})

test('输入过滤后 Enter 先选候选，再按 Enter 才确认，不会提前落钉', async ({
  launch,
  userDataDirectory
}) => {
  const seeded = seedGroup(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openSeededThread(page, seeded.threadId)

  const dialog = await selectAndOpenDialog(page, 'alpha')
  const input = dialog.getByRole('combobox', { name: '选择词条' })
  await input.fill('bravo')
  await expect(dialog.getByRole('option', { name: /bravo/ })).toBeVisible()

  await page.keyboard.press('Enter')
  await expect(dialog.locator('.target-picker-current')).toContainText('bravo')
  // 第一次 Enter 只选中候选：弹层还在，也还没有落钉。
  await expect(dialog).toBeVisible()
  expect(await boardCount(page, seeded.threadId)).toBe(0)

  await page.keyboard.press('Enter')
  await expect(page.getByText('已钉到词条 bravo')).toBeVisible()
  await expect(dialog).toHaveCount(0)
  expect(await boardCount(page, seeded.threadId)).toBe(1)
})

test('输入法组合态的 Enter / 方向键 / Esc 不选、不落钉、不关层；普通 Esc 仍归弹层', async ({
  launch,
  userDataDirectory
}) => {
  const seeded = seedGroup(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openSeededThread(page, seeded.threadId)

  const dialog = await selectAndOpenDialog(page, 'alpha')
  const input = dialog.getByRole('combobox', { name: '选择词条' })
  await expect(dialog.locator('.target-picker-current')).toContainText('alpha')

  async function composing(key: string): Promise<void> {
    await input.evaluate((element, value) => {
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: value,
          isComposing: true,
          bubbles: true,
          cancelable: true
        })
      )
    }, key)
  }

  await composing('ArrowDown')
  await expect(input).toHaveAttribute('aria-expanded', 'false')
  await composing('Enter')
  await expect(dialog).toBeVisible()
  expect(await boardCount(page, seeded.threadId)).toBe(0)
  await composing('Escape')
  await expect(dialog).toBeVisible()
  await expect(input).toHaveAttribute('aria-expanded', 'false')

  // 组合态结束后：普通 Enter 直接确认预选，且只落一颗钉。
  await page.keyboard.press('Enter')
  await expect(page.getByText('已钉到词条 alpha')).toBeVisible()
  expect(await boardCount(page, seeded.threadId)).toBe(1)
})

test('普通 Esc 关闭钉住弹层且不落钉', async ({ launch, userDataDirectory }) => {
  const seeded = seedGroup(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openSeededThread(page, seeded.threadId)

  const dialog = await selectAndOpenDialog(page, 'alpha')
  await expect(dialog.locator('.target-picker-current')).toContainText('alpha')
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await boardCount(page, seeded.threadId)).toBe(0)
})

test('连续自动预选：接受 auto A 后，下一次选 B 仍预选 B', async ({
  launch,
  userDataDirectory
}) => {
  const seeded = seedGroup(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openSeededThread(page, seeded.threadId)

  const first = await selectAndOpenDialog(page, 'alpha')
  await expect(first.locator('.target-picker-current')).toContainText('alpha')
  await page.keyboard.press('Enter')
  await expect(page.getByText('已钉到词条 alpha')).toBeVisible()

  const second = await selectAndOpenDialog(page, 'bravo')
  await expect(second.locator('.target-picker-current')).toContainText('bravo')
  await page.keyboard.press('Enter')
  await expect(page.getByText('已钉到词条 bravo')).toBeVisible()
  expect(await boardCount(page, seeded.threadId)).toBe(2)
})

test('阅读轻问抽屉手工改过的落点，跨抽屉重开与展开完整对话页后仍生效', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const ids = entryIds(userDataDirectory)
  const database = openDatabase(databasePath(userDataDirectory))
  let seeded: Seeded
  try {
    migrate(database)
    seeded = seedWordGroupThread(database, {
      entries: [
        { entryId: ids.alpha, mainForm: 'alpha' },
        { entryId: ids.bravo, mainForm: 'bravo' }
      ],
      question: '先问一句',
      answer: ANSWER,
      main: { kind: 'article', articleId: article.id }
    })
  } finally {
    database.close()
  }
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await openArticle(page, TITLE)

  async function openDrawer(): Promise<void> {
    await page.locator('.reading-bar').getByRole('button', { name: '问模型' }).click()
    await expect(page.locator('.assistant-text[data-answer-id] p')).toContainText('alpha')
  }

  await openDrawer()
  const first = await selectAndOpenDialog(page, 'alpha', '.reading-drawer-body')
  await expect(first.locator('.target-picker-current')).toContainText('alpha')
  // 用户把预选的 alpha 改成 bravo：这算一次真正的手动落点。
  await first.getByRole('combobox', { name: '选择词条' }).fill('bravo')
  await page.keyboard.press('Enter')
  await expect(first.locator('.target-picker-current')).toContainText('bravo')
  await first.getByRole('button', { name: '钉住', exact: true }).click()
  await expect(page.getByText('已钉到词条 bravo')).toBeVisible()

  await page.keyboard.press('Escape') // 收回抽屉（钉住弹层已随落钉关闭）
  await expect(page.locator('.reading-drawer')).toHaveCount(0)

  await openDrawer()
  const second = await selectAndOpenDialog(page, 'alpha', '.reading-drawer-body')
  await expect(second.locator('.target-picker-current')).toContainText('bravo')
  await page.keyboard.press('Escape')
  await expect(second).toHaveCount(0)

  await page.locator('.reading-drawer-expand').click()
  await expect(page).toHaveURL(/#\/chat\//)
  await expect(page.locator('.chat-main')).toBeVisible()
  const third = await selectAndOpenDialog(page, 'alpha')
  await expect(third.locator('.target-picker-current')).toContainText('bravo')
  // 手动落点覆盖后续的自动预选：选 bravo 也仍是 bravo，选回 alpha 也仍是 bravo。
  await page.keyboard.press('Escape')
  await expect(third).toHaveCount(0)
  const fourth = await selectAndOpenDialog(page, 'bravo')
  await expect(fourth.locator('.target-picker-current')).toContainText('bravo')
  await page.keyboard.press('Escape')
  await expect(fourth).toHaveCount(0)
  const fifth = await selectAndOpenDialog(page, 'alpha')
  await expect(fifth.locator('.target-picker-current')).toContainText('bravo')
  expect(seeded.threadId).not.toBe('')
})
