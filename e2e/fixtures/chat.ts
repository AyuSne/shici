import { expect, type Page } from '@playwright/test'
import {
  askQuestion,
  createThread,
  saveAnswer,
  updateThreadContext
} from '../../src/main/chat/threads'
import type { AppDatabase } from '../../src/main/db/database'
import type { CreateThreadRequest } from '../../src/shared/threads'

/** 从全局导航进入设置页，并等到设置标题可见。 */
export async function openSettings(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '设置' })
    .click()
  await expect(page.getByRole('heading', { name: '设置', level: 1 })).toBeVisible()
}

/** 从全局导航进入对话页，并等到输入框可用。 */
export async function openChat(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '对话' })
    .click()
  await expect(page.getByRole('textbox', { name: '输入问题' })).toBeVisible()
}

/** 填入问题并发送；调用方负责等待回答或停止。 */
export async function ask(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: '输入问题' }).fill(text)
  await page.getByRole('button', { name: '发送' }).click()
}

/**
 * 一条带若干词条上下文的组词线程（或挂文章的轻问线程），回答一次到位。
 * 上下文走主进程公开的 updateThreadContext，不直接改 context_json。
 */
export function seedWordGroupThread(
  database: AppDatabase,
  input: {
    entries: readonly { entryId: string; mainForm: string }[]
    question: string
    answer: string
    main?: CreateThreadRequest['main']
  }
): { threadId: string; answerId: string } {
  const created = createThread(database, { main: input.main ?? { kind: 'none' } })
  if (created.status !== 'created') throw new Error('组词线程没建起来')
  const threadId = created.thread.id
  const items = input.entries.map((entry) => ({
    id: `word:${entry.entryId}`,
    kind: 'word' as const,
    label: entry.mainForm,
    text: entry.mainForm,
    source: `${entry.mainForm} · 1 句 · 1 篇`
  }))
  const saved = updateThreadContext(database, { threadId, items })
  if (saved.status !== 'saved') throw new Error('组词上下文没写成')
  const asked = askQuestion(database, { threadId, text: input.question })
  if (asked.status !== 'asked') throw new Error('问题没写进去')
  const answer = saveAnswer(database, {
    threadId,
    questionId: asked.questionId,
    text: input.answer,
    thinking: '',
    phase: 'done'
  })
  const answerId =
    answer.status === 'saved' ? answer.thread.turns[0]?.answer?.id : undefined
  if (!answerId) throw new Error('没有保存回答')
  return { threadId, answerId }
}

/** Add a finished turn to an open fixture database; callers choose which ranges to pin. */
export function seedAnsweredThread(database: AppDatabase, fixture: {
  main?: CreateThreadRequest['main']
  question: string
  answer: string
  model?: string
}): { threadId: string; answerId: string } {
  const created = createThread(database, { main: fixture.main ?? { kind: 'none' } })
  if (created.status !== 'created') throw new Error('线程没建起来')
  const threadId = created.thread.id
  const asked = askQuestion(database, { threadId, text: fixture.question })
  if (asked.status !== 'asked') throw new Error('问题没写进去')
  const saved = saveAnswer(database, {
    threadId, questionId: asked.questionId, text: fixture.answer, thinking: '', phase: 'done',
    ...(fixture.model === undefined ? {} : { model: fixture.model })
  })
  const answerId = saved.status === 'saved' ? saved.thread.turns[0]?.answer?.id : undefined
  if (!answerId) throw new Error('没有保存回答')
  return { threadId, answerId }
}
