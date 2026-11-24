import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { askQuestion, createThread, saveAnswer } from '../../src/main/chat/threads'
import { openDatabase } from '../../src/main/db/database'
import { createPin } from '../../src/main/pins/pins'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test, type AppHandle, type LaunchOptions } from '../fixtures/app'
import { selectAnswerText } from '../fixtures/answer-selection'
import { databasePath } from '../fixtures/database'
import { seedWordEntries } from '../fixtures/entries'

const article = fixtureArticle({
  id: 'fixture-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.', 'Approaching a new desk takes patience.'],
    ['Context keeps the skill alive.', 'Repeated words stick.']
  ]
})

const ANSWER = '第一段：approach 是接近，也可以指方法。\n\n第二段：complain 只是抱怨，事情也许还能补救。'

let corpusDirectory: string
const stubs: SseStub[] = []

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-pins-corpus-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(): Promise<SseStub> {
  const stub = await startSseStub({ kind: 'stream', text: [ANSWER] })
  stubs.push(stub)
  return stub
}

function environment(baseUrl: string): Record<string, string> {
  return {
    DEEPSEEK_BASE_URL: baseUrl,
    DEEPSEEK_API_KEY: 'e2e-test-key',
    DEEPSEEK_MODEL: 'deepseek-flash',
    CORPUS_DIRECTORY: corpusDirectory
  }
}

function seed(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      {
        entry: article,
        paragraphIndex: 0,
        needle: 'approach',
        at: '2026-11-18T08:00:00.000Z'
      }
    ]
  })
}

/** 先钉一条到词条，再把源线程删掉；钉住与学习内容按快照留下。 */
function seedPinnedNoteThenDeleteSourceThread(userDataDirectory: string): void {
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    const entry = database
      .prepare("SELECT id FROM word_entry WHERE main_form = 'approach'")
      .get() as { id: string }
    const created = createThread(
      database,
      { main: { kind: 'entry', entryId: entry.id } },
      { now: '2026-11-18T08:30:00.000Z' }
    )
    if (created.status !== 'created') throw new Error('线程没建起来')
    const asked = askQuestion(
      database,
      { threadId: created.thread.id, text: 'approach 怎么用？' },
      { now: '2026-11-18T08:31:00.000Z' }
    )
    if (asked.status !== 'asked') throw new Error('问题没写进去')
    const saved = saveAnswer(
      database,
      {
        threadId: created.thread.id,
        questionId: asked.questionId,
        text: ANSWER,
        thinking: '',
        phase: 'done'
      },
      { now: '2026-11-18T08:32:00.000Z' }
    )
    if (saved.status !== 'saved') throw new Error('回答没写进去')
    const answerId = saved.thread.turns[0]?.answer?.id
    if (!answerId) throw new Error('没有回答')
    const start = ANSWER.indexOf('approach 是接近')
    const pinned = createPin(
      database,
      {
        threadId: created.thread.id,
        answerId,
        start,
        end: start + 'approach 是接近'.length,
        target: { kind: 'entry', entryId: entry.id }
      },
      { now: '2026-11-18T08:33:00.000Z', model: 'deepseek-flash' }
    )
    if (pinned.status !== 'pinned') throw new Error('没钉上')
    database.prepare('DELETE FROM thread WHERE id = ?').run(created.thread.id)
  } finally {
    database.close()
  }
}

/** 先钉两条到未归档，供钉板的归位与丢弃用例使用。 */
function seedUnfiledPins(userDataDirectory: string): void {
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    const created = createThread(
      database,
      { main: { kind: 'none' } },
      { now: '2026-11-18T08:30:00.000Z' }
    )
    if (created.status !== 'created') throw new Error('线程没建起来')
    const asked = askQuestion(
      database,
      { threadId: created.thread.id, text: '这句怎么理解？' },
      { now: '2026-11-18T08:31:00.000Z' }
    )
    if (asked.status !== 'asked') throw new Error('问题没写进去')
    const saved = saveAnswer(
      database,
      {
        threadId: created.thread.id,
        questionId: asked.questionId,
        text: ANSWER,
        thinking: '',
        phase: 'done'
      },
      { now: '2026-11-18T08:32:00.000Z' }
    )
    if (saved.status !== 'saved') throw new Error('回答没写进去')
    const answerId = saved.thread.turns[0]?.answer?.id
    if (!answerId) throw new Error('没有回答')
    for (const needle of ['approach 是接近', 'complain']) {
      const start = ANSWER.indexOf(needle)
      const pinned = createPin(
        database,
        {
          threadId: created.thread.id,
          answerId,
          start,
          end: start + needle.length,
          target: { kind: 'unfiled' }
        },
        { now: '2026-11-18T08:33:00.000Z', model: 'deepseek-flash' }
      )
      if (pinned.status !== 'pinned') throw new Error('没钉上')
    }
  } finally {
    database.close()
  }
}

async function launchApp(
  launch: (options?: LaunchOptions) => Promise<AppHandle>,
  options: LaunchOptions
): Promise<Page> {
  const handle = await launch(options)
  return handle.page
}

async function openBlankChat(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '对话' })
    .click()
  await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
}

async function ask(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: '输入问题' }).fill(text)
  await page.getByRole('button', { name: '发送' }).click()
}

async function openEntry(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条' })
    .click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await page
    .locator('.entries-row')
    .filter({
      has: page.locator('.entries-row-name', { hasText: new RegExp(`^${name}$`) })
    })
    .click()
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible()
}

test.describe('钉住与钉板', () => {
  test('空白线程钉到未归档，再归到词条，从学习内容回跳并高亮', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    const stub = await createStub()
    const page = await launchApp(launch, { env: environment(stub.baseUrl) })

    await openBlankChat(page)
    await ask(page, '这句怎么理解？')
    await expect(page.locator('.assistant-text')).toContainText('approach 是接近')

    await selectAnswerText(page, 'approach 是接近')
    await page
      .locator('.selection-capsule')
      .getByRole('button', { name: '钉住', exact: true })
      .click()

    // 空白线程的默认落点是未归档。
    const dialog = page.getByRole('dialog', { name: '钉到哪儿' })
    await expect(dialog.getByRole('button', { name: '未归档' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await dialog.getByRole('button', { name: '钉住', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('已放进未归档')
    await expect(page.getByRole('complementary', { name: '钉板' }).getByRole('button', { name: /未归档 1/ })).toBeVisible()

    // 未归档不算收集：词条里还没有学习内容。
    await openEntry(page, 'approach')
    await expect(page.getByRole('button', { name: /^展开学习内容/ })).toContainText('0')
    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '对话' })
      .click()
    // 回到那条线程，钉板的「这条线程」才有着落。
    await page.locator('.thread-row').filter({ hasText: '这句怎么理解？' }).click()
    await expect(page.getByRole('heading', { name: '这句怎么理解？', level: 1 })).toBeVisible()

    // 钉板里归到词条。
    await page.getByRole('button', { name: /^钉板 / }).click()
    await expect(page.getByRole('tab', { name: '未归档 1' })).toBeVisible()
    await expect(page.locator('.pin-card')).toContainText('approach 是接近')
    await page.getByRole('button', { name: '归到词条' }).click()
    const fileDialog = page.getByRole('dialog', { name: '归到哪儿' })
    await expect(fileDialog.getByRole('button', { name: /词条 · approach/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await fileDialog.getByRole('button', { name: '归位' }).click()
    await expect(page.getByRole('status')).toContainText('已归到 approach')
    await page.getByRole('tab', { name: '当前对话' }).click()
    await expect(page.locator('.pin-card')).toContainText('approach')

    // 词条学习内容里出现来源行，点回对话后高亮那段回答。
    await openEntry(page, 'approach')
    await page.getByRole('button', { name: /^展开学习内容/ }).click()
    await expect(page.locator('.entry-note-body')).toContainText('approach 是接近')
    await expect(page.locator('.entry-note-source')).toContainText('来自 这句怎么理解？')
    await page.getByRole('button', { name: '看原对话' }).click()

    await expect(page.getByRole('status')).toContainText('来自词条 approach · 学习内容')
    await expect(page.locator('.assistant-text [data-md-block].is-source-hit')).toHaveCount(1)
    await expect(page.locator('.assistant-text [data-md-block].is-pinned')).toHaveCount(1)
    await expect(page.locator('.assistant-text')).toContainText('approach 是接近')
  })

  test('挂词条的线程预选该词条，钉完 5 秒内可撤销', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    const stub = await createStub()
    const page = await launchApp(launch, {
      userDataDirectory,
      env: environment(stub.baseUrl)
    })

    await openEntry(page, 'approach')
    await page.locator('.entries-main-actions').getByRole('button', { name: '问模型' }).click()
    await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
    await ask(page, '这个词怎么用？')
    await expect(page.locator('.assistant-text')).toContainText('approach 是接近')

    await selectAnswerText(page, 'approach 是接近')
    await page
      .locator('.selection-capsule')
      .getByRole('button', { name: '钉住', exact: true })
      .click()
    const dialog = page.getByRole('dialog', { name: '钉到哪儿' })
    await expect(dialog.getByRole('button', { name: /词条 · approach/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await dialog.getByRole('button', { name: '钉住', exact: true }).click()

    await expect(page.getByRole('status')).toContainText('已钉到词条 approach')
    await expect(page.locator('.assistant-text [data-md-block].is-pinned')).toHaveCount(1)
    await expect(page.locator('.pin-badge')).toContainText('已钉 · approach')

    // 钉住瞬间不自动打开钉板；从顶栏打开能看到这条。
    await expect(page.getByRole('complementary', { name: '钉板' })).toHaveCount(1)
    await page.getByRole('button', { name: /^钉板 / }).click()
    await expect(page.locator('.pin-card')).toContainText('approach 是接近')

    // 5 秒内撤销：钉住与学习内容一起消失。
    await page.getByRole('button', { name: '撤销' }).click()
    await expect(page.getByRole('status')).toHaveCount(0)
    await expect(page.locator('.pin-card')).toHaveCount(0)

    await openEntry(page, 'approach')
    await expect(page.getByRole('button', { name: /^展开学习内容/ })).toContainText('0')
  })

  test('未归档可全部归位并撤销，丢弃也能撤销', async ({ launch, userDataDirectory }) => {
    seed(userDataDirectory)
    seedUnfiledPins(userDataDirectory)
    const stub = await createStub()
    const page = await launchApp(launch, { env: environment(stub.baseUrl) })

    await openBlankChat(page)
    await page.locator('.thread-row').filter({ hasText: '这句怎么理解？' }).click()
    await expect(page.getByRole('heading', { name: '这句怎么理解？', level: 1 })).toBeVisible()
    await page.getByRole('button', { name: /^钉板 / }).click()
    await page.getByRole('tab', { name: '未归档 2' }).click()
    await expect(page.locator('.pin-card')).toHaveCount(2)

    await page.getByRole('button', { name: '全部归位' }).click()
    const dialog = page.getByRole('dialog', { name: '全部未归档归到哪儿' })
    await expect(dialog.getByRole('button', { name: /词条 · approach/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await dialog.getByRole('button', { name: '全部归位' }).click()
    await expect(page.getByRole('status')).toContainText('已将 2 条归位')
    await expect(page.getByRole('tab', { name: '未归档 0' })).toBeVisible()

    // 撤销「全部归位」：两条一起回到未归档，学习内容也撤掉。
    await page.getByRole('button', { name: '撤销' }).click()
    await expect(page.getByRole('tab', { name: '未归档 2' })).toBeVisible()
    await expect(page.locator('.pin-card')).toHaveCount(2)

    await openEntry(page, 'approach')
    await expect(page.getByRole('button', { name: /^展开学习内容/ })).toContainText('0')

    // 回到对话，丢弃一条再撤销。
    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '对话' })
      .click()
    await page.locator('.thread-row').filter({ hasText: '这句怎么理解？' }).click()
    await page.getByRole('button', { name: /^钉板 / }).click()
    await page.getByRole('tab', { name: '未归档 2' }).click()
    await page.locator('.pin-card').first().getByRole('button', { name: '丢弃' }).click()
    await expect(page.getByRole('status')).toContainText('已丢弃')
    await expect(page.locator('.pin-card')).toHaveCount(1)
    await page.getByRole('button', { name: '撤销' }).click()
    await expect(page.locator('.pin-card')).toHaveCount(2)
  })

  test('源对话删除后学习内容仍留快照，看原对话入口置灰', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    seedPinnedNoteThenDeleteSourceThread(userDataDirectory)
    const stub = await createStub()
    const page = await launchApp(launch, { env: environment(stub.baseUrl) })

    await openEntry(page, 'approach')
    await page.getByRole('button', { name: /^展开学习内容/ }).click()
    await expect(page.locator('.entry-note-body')).toContainText('approach 是接近')
    await expect(page.locator('.entry-note-source')).toContainText('来自 approach · 第 1 轮')
    const source = page.getByRole('button', { name: '看原对话' })
    await expect(source).toBeDisabled()
    await expect(source).toHaveAttribute('title', '源对话已删除')
  })
})
