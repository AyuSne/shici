import { expect, type Page } from '@playwright/test'
import { askQuestion, createThread, saveAnswer } from '../../src/main/chat/threads'
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
