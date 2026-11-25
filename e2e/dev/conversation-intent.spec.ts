import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/database'
import { migrate } from '../../src/main/db/migrations'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { holdIpcReply } from '../fixtures/bridge'
import { seedAnsweredThread } from '../fixtures/chat'
import { databasePath } from '../fixtures/database'
import { openArticle } from '../fixtures/reading'

/**
 * F1：真实阅读页的轻问打开还在路上时离开阅读页，再打开另一条已有对话；
 * 迟到的轻问结果不能激活旧线程、不能盖掉 B，也不能弹旧错误。
 */

const TITLE = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-conversation-intent',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE,
  sentences: [['Readers approach new methods.'], ['A second paragraph keeps the page readable.']]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-conversation-intent-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function seedExistingThread(userDataDirectory: string): string {
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    migrate(database)
    return seedAnsweredThread(database, {
      question: '先聊这一条',
      answer: '这是已有的对话 B，不能被迟到的轻问打开换掉。'
    }).threadId
  } finally {
    database.close()
  }
}

function hashOf(page: Page): Promise<string> {
  return page.evaluate(() => window.location.hash)
}

test('离开阅读页后打开已有对话 B，迟到的轻问 A 不激活、不盖 B、不弹旧错误', async ({
  launch,
  userDataDirectory
}) => {
  const threadB = seedExistingThread(userDataDirectory)
  const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  if (electronApp === null) throw new Error('需要 Electron 主进程句柄')
  await openArticle(page, TITLE)

  const held = await holdIpcReply(electronApp as ElectronApplication, 'chat:open-for-main')
  await page.locator('.reading-bar').getByRole('button', { name: '问模型' }).click()
  await expect.poll(held.pending).toBe(true)

  // 打开请求还在主进程里挂着：先离开阅读页，再打开另一条已有对话 B。
  await page.locator('.reading-back').click()
  await expect(page.getByRole('navigation', { name: '全局导航' })).toBeVisible()
  await page.evaluate((threadId) => {
    window.location.hash = `#/chat/${threadId}`
  }, threadB)
  await expect(page.locator('.assistant-text[data-answer-id]')).toContainText('已有的对话 B')
  const bHash = await hashOf(page)

  // 释放迟到的 A：它已经不属于当前对话意图。
  await held.release()
  await page.waitForTimeout(400)

  expect(await hashOf(page)).toBe(bHash)
  await expect(page.locator('.assistant-text[data-answer-id]')).toContainText('已有的对话 B')
  await expect(page.getByRole('heading', { name: TITLE, level: 1 })).toHaveCount(0)
  await expect(page.locator('[data-question-drawer="true"]')).toHaveCount(0)
  await expect(page.locator('.toast[role="alert"]')).toHaveCount(0)
})
