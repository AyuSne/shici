import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { askQuestion, createThread } from '../../src/main/chat/threads'
import { openDatabase } from '../../src/main/db/database'
import type { IpcBridge } from '../../src/shared/ipc-contract'
import { createPin } from '../../src/main/pins/pins'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { startSseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { holdIpcReply } from '../fixtures/bridge'
import { seedAnsweredThread } from '../fixtures/chat'
import { databasePath } from '../fixtures/database'
import { seedWordEntries } from '../fixtures/entries'

const original = 'Employers approach hiring differently.'
const answer = 'approach 在这里表示处理某事。'
const article = fixtureArticle({
  id: 'fixture-2026-06-s1-c1', year: 2026, month: 6, set: 1, sentences: [[original]]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-thread-deletion-corpus-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function seed(userDataDirectory: string, options: { withInactiveThread?: boolean; missingAnswer?: boolean } = {}): string {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    const { id: entryId } = database.prepare('SELECT id FROM word_entry').get() as { id: string }
    const { threadId, answerId } = seedAnsweredThread(database, {
      main: { kind: 'entry', entryId }, question: 'approach 怎么用？', answer, model: 'fixture-model'
    })
    for (const target of [{ kind: 'unfiled' }, { kind: 'entry', entryId }] as const) {
      const pin = createPin(database, { threadId, answerId, start: 0, end: answer.length, target })
      if (pin.status !== 'pinned') throw new Error('没钉上')
    }
    if (options.missingAnswer) {
      database.prepare('UPDATE pin SET answer_id = ? WHERE thread_id = ?').run('missing-answer', threadId)
    }
    if (options.withInactiveThread) {
      const inactive = createThread(database, { main: { kind: 'none' } })
      if (inactive.status !== 'created') throw new Error('没有创建另一条线程')
      const question = askQuestion(database, { threadId: inactive.thread.id, text: '无关的线程' })
      if (question.status !== 'asked') throw new Error('另一条线程没有写入问题')
    }
    return threadId
  } finally {
    database.close()
  }
}

function nav(page: Page, name: string) {
  return page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name, exact: true })
}

async function expectDeletedSnapshots(page: Page) {
  await page.getByRole('button', { name: /^钉板 / }).click()
  const card = page.getByRole('article').filter({ hasText: answer })
  await expect(card).toContainText(original)
  await expect(card).toContainText('源对话已删除')
  await expect(card.getByRole('button', { name: '看原对话' })).toBeDisabled()
  await page.getByRole('button', { name: /^(收起|关闭)钉板$/ }).click()

  await nav(page, '词条').click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await page.getByRole('button', { name: /^词典与学习内容/ }).click()
  const note = page.getByRole('article').filter({ hasText: answer })
  await expect(note).toContainText('源对话已删除')
  await expect(note.getByRole('button', { name: /看原对话/ })).toBeDisabled()
}

test('取消或确认删除当前线程，保留可读快照，重新打开和重启都不恢复已删线程', async ({ launch, userDataDirectory }) => {
  const threadId = seed(userDataDirectory)
  const options = { env: { CORPUS_DIRECTORY: corpusDirectory }, userDataDirectory }
  const app = await launch(options)
  const page = app.page
  await nav(page, '对话').click()
  const list = page.getByRole('complementary', { name: '对话列表' })
  await list.locator('.thread-row').filter({ hasText: 'approach' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  await page.getByRole('textbox', { name: '输入问题' }).fill('不会带去新学习的草稿')

  const remove = list.getByRole('button', { name: '删除对话：approach' })
  await expect(remove).toBeVisible({ timeout: 3000 })
  await remove.click()
  const dialog = page.getByRole('dialog', { name: '删除对话' })
  await expect(dialog).toContainText('钉住')
  await expect(dialog).toContainText('approach')
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(remove).toBeVisible()
  await expect(page.locator('.assistant-text')).toContainText(answer)

  await remove.click()
  await dialog.getByRole('button', { name: '删除对话', exact: true }).click()
  await expect(remove).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
  await expect(page.getByRole('textbox', { name: '输入问题' })).toHaveValue('')
  await expect(page.locator('.assistant-text')).toHaveCount(0)
  await expect(page).not.toHaveURL(new RegExp(threadId))
  await expectDeletedSnapshots(page)
  await nav(page, '对话').click()
  await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
  await expect(page).not.toHaveURL(new RegExp(threadId))
  await app.close()

  const restarted = (await launch(options)).page
  await expect(restarted.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
  await expect(restarted).not.toHaveURL(new RegExp(threadId))
  await expectDeletedSnapshots(restarted)
})

test('旧快照的线程仍在但原回答缺失，来源禁跳且丢弃前保护仅存的副本', async ({ launch, userDataDirectory }) => {
  seed(userDataDirectory, { missingAnswer: true })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await nav(page, '对话').click()
  await page.locator('.thread-row').filter({ hasText: 'approach' }).click()
  await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: /^钉板 / }).click()
  const board = page.getByRole('complementary', { name: '钉板' })
  const card = board.getByRole('article').filter({ hasText: answer })
  const source = card.getByRole('button', { name: '看原对话' })
  await expect(card).toContainText('原回答找不到')
  await expect(source).toBeDisabled()
  await expect(source).toHaveAttribute('title', '原回答找不到')

  await board.getByRole('tab', { name: '未归档 1' }).click()
  const discard = card.getByRole('button', { name: '丢弃' })
  await expect(source).toBeDisabled()
  await discard.click()
  await expect(page.getByRole('status')).toContainText('原回答找不到，这是仅存的副本 · 再点一次丢弃')
  await expect(card).toContainText(answer)
  await discard.click()
  await expect(card).toHaveCount(0)

  await nav(page, '词条').click()
  await page.locator('.entries-row').filter({ hasText: 'approach' }).click()
  await page.getByRole('button', { name: /^词典与学习内容/ }).click()
  const note = page.getByRole('article').filter({ hasText: answer })
  await expect(note).toContainText('原回答找不到')
  await expect(note.getByRole('button', { name: /看原对话/ })).toBeDisabled()
})

for (const leave of [false, true]) {
  test(leave ? '删除等待期间主动后退，不会被迟到的主对象读取或删除回复拉回' :
    '删除等待期间主对象读取迟到，最终仍回到新的学习', async ({ launch, userDataDirectory }) => {
    const threadId = seed(userDataDirectory)
    const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    if (electronApp === null) throw new Error('需要开发版 Electron 进程')
    await nav(page, '对话').click()
    await page.locator('.thread-row').filter({ hasText: 'approach' }).click()
    const mainLink = page.getByRole('heading', { name: 'approach', level: 1 }).getByRole('button')
    await expect(mainLink).toBeVisible()
    const read = await holdIpcReply(electronApp, 'chat:thread')
    const deletion = await holdIpcReply(electronApp, 'chat:delete')
    await mainLink.click()
    await expect.poll(read.pending).toBe(true)

    const remove = page.getByRole('button', { name: '删除对话：approach' })
    await remove.click()
    await page.getByRole('dialog', { name: '删除对话' }).getByRole('button', { name: '删除对话', exact: true }).click()
    await expect.poll(deletion.pending).toBe(true)
    if (leave) {
      await page.evaluate(() => { window.history.go(-2) })
      await expect(nav(page, '首页')).toHaveAttribute('aria-current', 'page')
    }

    await read.release()
    // Round-trip once from the renderer after releasing the read, while the deletion reply is still held.
    await page.evaluate(() => (window as unknown as { api: IpcBridge }).api.invoke('chat:list'))
    if (leave) await expect(nav(page, '首页')).toHaveAttribute('aria-current', 'page')
    else await expect(page).toHaveURL(new RegExp(`#/chat/${threadId}$`))

    await deletion.release()
    if (leave) {
      await page.evaluate(() => (window as unknown as { api: IpcBridge }).api.invoke('chat:list'))
      await expect(nav(page, '首页')).toHaveAttribute('aria-current', 'page')
    } else {
      await expect(remove).toHaveCount(0)
      await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
    }
  })
}

test('正在生成的线程不能删除，停止并落库后可删除，迟到的生成不能重新启动', async ({ launch, userDataDirectory }) => {
  const threadId = seed(userDataDirectory, { withInactiveThread: true })
  const stub = await startSseStub({ kind: 'hang', text: ['还在生成的部分内容'] })
  try {
    const { page } = await launch({ userDataDirectory, env: {
      CORPUS_DIRECTORY: corpusDirectory,
      DEEPSEEK_BASE_URL: stub.baseUrl,
      DEEPSEEK_API_KEY: 'e2e-test-key',
      DEEPSEEK_MODEL: 'fixture-model'
    } })
    await nav(page, '对话').click()
    const list = page.getByRole('complementary', { name: '对话列表' })
    await list.locator('.thread-row').filter({ hasText: 'approach' }).click()
    await expect(page.getByRole('heading', { name: 'approach', level: 1 })).toBeVisible()
    await page.getByRole('textbox', { name: '输入问题' }).fill('再举一例')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.getByText('还在生成的部分内容')).toBeVisible()
    const remove = list.getByRole('button', { name: '删除对话：approach' })
    await expect(remove).toBeDisabled()
    // 从实际 preload 穿过主进程处理器，确保限制不是只靠按钮。
    const tryDelete = (id: string) => (window as unknown as { api: IpcBridge }).api.invoke('chat:delete', { threadId: id })
    expect(await page.evaluate(tryDelete, threadId)).toEqual({ status: 'busy' })
    const removeInactive = list.getByRole('button', { name: '删除对话：无关的线程' })
    await removeInactive.click()
    await page.getByRole('dialog', { name: '删除对话' }).getByRole('button', { name: '删除对话', exact: true }).click()
    await expect(removeInactive).toHaveCount(0)
    await expect(page.getByText('还在生成的部分内容')).toBeVisible()
    await list.getByRole('button', { name: '新的学习' }).click()
    await expect(remove).toBeDisabled()
    await list.locator('.thread-row').filter({ hasText: 'approach' }).click()
    await page.getByRole('button', { name: '停止生成' }).click()
    await expect(page.getByText('已停止 · 未完成')).toBeVisible()
    await expect(remove).toBeEnabled()
    await remove.click()
    await page.getByRole('dialog', { name: '删除对话' }).getByRole('button', { name: '删除对话', exact: true }).click()
    await expect(remove).toHaveCount(0)
    expect(await page.evaluate((id) => (window as unknown as { api: IpcBridge }).api.invoke('chat:start', {
      threadId: id, streamId: 'late-stream', messages: [{ role: 'user', content: '迟到的请求' }]
    }), threadId)).toEqual({ accepted: false })
    expect(stub.requests).toHaveLength(1)
  } finally {
    await stub.close()
  }
})
