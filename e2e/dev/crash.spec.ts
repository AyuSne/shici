import Database from 'better-sqlite3'
import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { databasePath } from '../fixtures/database'
import { seedWordEntries } from '../fixtures/entries'

/**
 * 收官验收：进程被强杀（不经过 before-quit、不 close SQLite）后重启，
 * 已确认保存的数据仍然完整；流式生成中断时也不会留下写了一半的回答。
 */

const ANSWER = 'approach 在这里表示着手处理一件事。'

const article = fixtureArticle({
  id: 'fixture-crash-2026-06-s1-b',
  year: 2026,
  month: 6,
  set: 1,
  kind: 'long_match',
  sentences: [
    [
      'Readers approach a crash test with a calm plan.',
      'The collected word and its sentence must survive the restart.'
    ],
    [
      'A second paragraph gives the reading position a place to go.',
      'The footer writes back which sentence was on screen.'
    ],
    [
      'A third paragraph makes the page scroll far enough for a save.',
      'The position is written after the scroll stops moving.'
    ]
  ]
})

const articleTitle = '2026年6月 · 第1套 · 长篇匹配'

let corpusDirectory: string
const stubs: SseStub[] = []

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-crash-corpus-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

function environment(baseUrl: string): Record<string, string> {
  return {
    CORPUS_DIRECTORY: corpusDirectory,
    DEEPSEEK_BASE_URL: baseUrl,
    DEEPSEEK_API_KEY: 'e2e-crash-key',
    DEEPSEEK_MODEL: 'deepseek-flash'
  }
}

async function createStub(
  script: Parameters<typeof startSseStub>[0]
): Promise<SseStub> {
  const stub = await startSseStub(script)
  stubs.push(stub)
  return stub
}

async function nav(page: Page, label: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: label, exact: true })
    .click()
}

type Snapshot = {
  schemaVersion: number
  integrity: string
  articles: number
  entries: number
  entrySentences: number
  notes: number
  threads: number
  threadEntries: number
  pins: number
  lastParagraphId: string | null
  lastSentenceIndex: number | null
  pinTexts: string[]
  noteBodies: string[]
}

/** 直接读库：重启前后的同一份事实要逐项相等。 */
function snapshotOf(databaseFile: string): Snapshot {
  const database = new Database(databaseFile, { readonly: true, fileMustExist: true })
  try {
    const count = (table: string): number =>
      (database.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
    const articleRow = database
      .prepare(
        'SELECT last_paragraph_id, last_sentence_index FROM article WHERE id = ?'
      )
      .get(article.id) as {
      last_paragraph_id: string | null
      last_sentence_index: number | null
    }
    return {
      schemaVersion: database.pragma('user_version', { simple: true }) as number,
      integrity: database.pragma('integrity_check', { simple: true }) as string,
      articles: count('article'),
      entries: count('word_entry'),
      entrySentences: count('entry_sentence'),
      notes: count('learning_note'),
      threads: count('thread'),
      threadEntries: count('thread_entry'),
      pins: count('pin'),
      lastParagraphId: articleRow.last_paragraph_id,
      lastSentenceIndex: articleRow.last_sentence_index,
      pinTexts: (
        database.prepare('SELECT captured_text FROM pin ORDER BY created_at').all() as {
          captured_text: string
        }[]
      ).map((row) => row.captured_text),
      noteBodies: (
        database.prepare('SELECT body FROM learning_note ORDER BY created_at').all() as {
          body: string
        }[]
      ).map((row) => row.body)
    }
  } finally {
    database.close()
  }
}

async function openArticleFromLibrary(page: Page): Promise<void> {
  await nav(page, '文章库')
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await page.locator('.library-row').first().click()
  await page
    .getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' })
    .click()
  await expect(page.getByRole('heading', { name: articleTitle, level: 1 })).toBeVisible()
}

test.describe('收官验收 · 强杀重启', () => {
  test('已确认保存的阅读位置、词条、对话与钉住在强杀后仍完整', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'stream', text: [ANSWER] })
    seedWordEntries(userDataDirectory, corpusDirectory, {
      picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
    })
    const databaseFile = databasePath(userDataDirectory)

    const first = await launch({ env: environment(stub.baseUrl) })
    const page = first.page

    // 读到后面，等位置写库。
    await openArticleFromLibrary(page)
    await page.locator('.reading-scroll').evaluate((element) => {
      element.scrollTop = 700
    })
    await page.waitForTimeout(900)
    const footer = (await page.locator('.reading-foot span').first().textContent()) ?? ''
    const footerMatch = footer.match(/读到 第 (\d+) 段 · 第 (\d+) 句/)
    expect(footerMatch).not.toBeNull()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()

    // 从词条开线程、提问、把回答钉到词条。
    await nav(page, '词条')
    await page.locator('.entries-row').first().click()
    await expect(page.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
    await page.locator('.entries-main-actions').getByRole('button', { name: '问模型' }).click()
    await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
    await page.getByRole('textbox', { name: '输入问题' }).fill('this 在这个句子里怎么理解？')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.locator('.assistant-text')).toContainText(ANSWER)
    await page
      .locator('.assistant-actions')
      .getByRole('button', { name: '钉住', exact: true })
      .click()
    const dialog = page.getByRole('dialog', { name: '钉到哪儿' })
    await expect(dialog.getByRole('button', { name: '词条 · approach' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await dialog.getByRole('button', { name: '钉住', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('已钉到词条 approach')
    await expect(page.locator('.pin-badge')).toContainText('已钉 · approach')

    // 界面一确认钉住就强杀：不给退出收尾、不给 SQLite close 任何机会。
    await first.kill()

    // 下一个连接打开 WAL：库完整，已确认保存的动作一条不少。
    const afterKill = snapshotOf(databaseFile)
    expect(afterKill.integrity).toBe('ok')
    expect(afterKill.entries).toBe(1)
    expect(afterKill.entrySentences).toBe(1)
    expect(afterKill.notes).toBe(1)
    expect(afterKill.threads).toBe(1)
    expect(afterKill.pins).toBe(1)
    expect(afterKill.lastParagraphId).not.toBeNull()

    const second = await launch({ userDataDirectory, env: environment(stub.baseUrl) })
    const reopened = second.page

    // 首页继续阅读回到同一篇、同一句。
    await expect(
      reopened.getByRole('heading', {
        name: articleTitle.split(' · ').at(-1) ?? articleTitle,
        level: 1
      })
    ).toBeVisible()
    await expect(
      reopened.getByText(`上次停在 第 ${footerMatch?.[1]} 段 · 第 ${footerMatch?.[2]} 句`)
    ).toBeVisible()

    // 词条、原句、学习内容与来源行都还在。
    await nav(reopened, '词条')
    await reopened.locator('.entries-row').first().click()
    await expect(reopened.getByRole('heading', { name: 'approach', level: 2 })).toBeVisible()
    await expect(
      reopened.locator('.entry-sentence-text').filter({ hasText: 'Readers approach' })
    ).toBeVisible()
    await expect(reopened.getByRole('button', { name: /^展开学习内容/ })).toContainText('1')
    await reopened.getByRole('button', { name: /^展开学习内容/ }).click()
    await expect(reopened.locator('.entry-note-body')).toContainText(ANSWER)
    await expect(reopened.locator('.entry-note-source')).toContainText('来自 approach · 第 1 轮')

    // 对话、回答与钉住都还在。
    await nav(reopened, '对话')
    await reopened.locator('.thread-row').first().click()
    await expect(reopened.locator('.assistant-text')).toContainText(ANSWER)
    await reopened.getByRole('button', { name: /^钉板 / }).click()
    await expect(reopened.locator('.pin-card')).toContainText(ANSWER)

    // 重启后再读一遍库：没有重复导入，也没有多出半条记录。
    const after = snapshotOf(databaseFile)
    expect(after).toEqual(afterKill)
    expect(after.integrity).toBe('ok')
  })

  test('流式中被杀：重启后问题还在、没有半截回答，能继续生成', async ({
    launch,
    userDataDirectory
  }) => {
    const stub = await createStub({ kind: 'hang', thinking: ['先想一半。'], text: ['写到一半'] })
    const databaseFile = databasePath(userDataDirectory)

    const first = await launch({ env: environment(stub.baseUrl) })
    const page = first.page
    await nav(page, '对话')
    await page.getByRole('textbox', { name: '输入问题' }).fill('断在半路的问题')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.locator('.assistant-text')).toContainText('写到一半')

    await first.kill()
    expect(snapshotOf(databaseFile).integrity).toBe('ok')

    // 重启后这一问仍在，只是没有回答；界面要能继续把它答完。
    stub.setScript({ kind: 'stream', text: ['补上的回答。'] })
    const second = await launch({ userDataDirectory, env: environment(stub.baseUrl) })
    const reopened = second.page
    await nav(reopened, '对话')
    await reopened.locator('.thread-row').filter({ hasText: '断在半路的问题' }).click()
    await expect(reopened.locator('.chat-message-user')).toContainText('断在半路的问题')
    await expect(reopened.locator('.chat-unanswered')).toContainText('这条还没有回答。')
    await expect(reopened.locator('.assistant-text')).toHaveCount(0)
    expect(snapshotOf(databaseFile).threadEntries).toBe(1)

    await reopened.locator('.chat-unanswered').getByRole('button', { name: '生成回答' }).click()
    await expect(reopened.locator('.assistant-text')).toContainText('补上的回答。')
    expect(snapshotOf(databaseFile).threadEntries).toBe(2)
    expect(snapshotOf(databaseFile).integrity).toBe('ok')
  })
})
