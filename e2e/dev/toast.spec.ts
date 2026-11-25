import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPin } from '../../src/main/pins/pins'
import { openDatabase } from '../../src/main/db/database'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedAnsweredThread } from '../fixtures/chat'
import { expectReadableText } from '../fixtures/contrast'
import { databasePath, writeSetting } from '../fixtures/database'
import { seedWordEntries } from '../fixtures/entries'

/**
 * #80 顶部 Toast：标题栏下方安全区、5 秒到期、统一撤销动作、动作失败可见反馈，
 * 以及浅色 / 深色对比度与 reduced-motion 归零。全部走真实对话页操作。
 */

const article = fixtureArticle({
  id: 'fixture-toast-2026-06-s1-c1',
  sentences: [['Employers approach hiring differently.', 'Context keeps the skill alive.']]
})

const ANSWER = '第一段：approach 是接近。\n\n第二段：complain 只是抱怨。'

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-toast-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function seedUnfiledPin(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
  })
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    const entry = database
      .prepare("SELECT id FROM word_entry WHERE main_form = 'approach'")
      .get() as { id: string }
    const { threadId, answerId } = seedAnsweredThread(database, {
      main: { kind: 'entry', entryId: entry.id },
      question: '这句怎么理解？',
      answer: ANSWER,
      model: 'fixture-model'
    })
    const start = ANSWER.indexOf('approach')
    const pinned = createPin(database, {
      threadId,
      answerId,
      start,
      end: start + 'approach'.length,
      target: { kind: 'unfiled' }
    })
    if (pinned.status !== 'pinned') throw new Error('未归档钉住没造出来')
  } finally {
    database.close()
  }
}

function nav(page: Page) {
  return page.getByRole('navigation', { name: '全局导航' })
}

/** 打开对话页 → 打开钉板 → 未归档 → 丢弃一条，拿到「已丢弃 · 撤销」Toast。 */
async function discardOnePin(page: Page): Promise<void> {
  await nav(page).getByRole('button', { name: '对话', exact: true }).click()
  await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: /^钉板 / }).click()
  const board = page.getByRole('complementary', { name: '钉板' })
  await board.getByRole('tab', { name: '未归档 1', exact: true }).click()
  await page.locator('.pin-card').first().getByRole('button', { name: '丢弃' }).click()
  await expect(page.locator('.toast')).toContainText('已丢弃')
}

test('Toast 在标题栏下方顶部安全区，不遮挡对话输入框与底部快捷键行', async ({
  launch,
  userDataDirectory
}) => {
  seedUnfiledPin(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await discardOnePin(page)

  const toast = page.locator('.toast')
  await expect(toast).toHaveAttribute('role', 'status')
  const geometry = await page.evaluate(() => {
    const boxOf = (selector: string) => {
      const element = document.querySelector(selector)
      if (element === null) return null
      const box = element.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom }
    }
    return {
      titlebar: boxOf('.titlebar'),
      toast: boxOf('.toast'),
      composer: boxOf('.composer-box'),
      hint: boxOf('.composer-hint'),
      windowHeight: window.innerHeight
    }
  })
  expect(geometry.toast).not.toBeNull()
  expect(geometry.composer).not.toBeNull()
  expect(geometry.hint).not.toBeNull()
  // 顶部：在标题栏下方 6px 以上，且离窗口顶端不超过 80px。
  expect(geometry.toast!.top).toBeGreaterThanOrEqual((geometry.titlebar?.bottom ?? 0) + 6)
  expect(geometry.toast!.top).toBeLessThan(80)
  // 绝不落到输入框与快捷键行上。
  expect(geometry.toast!.bottom).toBeLessThan(geometry.composer!.top)
  expect(geometry.toast!.bottom).toBeLessThan(geometry.hint!.top)

  // 5 秒后自己消失，不执行任何动作。
  await expect(toast).toHaveCount(0, { timeout: 7_000 })
})

test('统一 5 秒「撤销」形态：点击后立即关闭并真的恢复', async ({
  launch,
  userDataDirectory
}) => {
  seedUnfiledPin(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await discardOnePin(page)
  const board = page.getByRole('complementary', { name: '钉板' })
  await expect(page.locator('.pin-card')).toHaveCount(0)

  const toast = page.locator('.toast')
  await expect(toast.getByRole('button', { name: '撤销' })).toBeVisible()
  await toast.getByRole('button', { name: '撤销' }).click()
  await expect(toast).toHaveCount(0)
  await expect(board.getByRole('tab', { name: '未归档 1', exact: true })).toBeVisible()
  await expect(page.locator('.pin-card')).toHaveCount(1)

  // 撤销只执行一次：再点旧的 Toast 已不存在。
  await expect(toast.getByRole('button', { name: '撤销' })).toHaveCount(0)
})

test('撤销动作异步失败被捕获，换成可见错误 Toast，且没有未处理 rejection', async ({
  launch,
  userDataDirectory
}) => {
  seedUnfiledPin(userDataDirectory)
  const { page, electronApp } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  if (electronApp === null) throw new Error('需要开发版 Electron 进程')
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await discardOnePin(page)
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('pins:restore')
    ipcMain.handle('pins:restore', () => {
      throw new Error('stub restore failure')
    })
  })

  await page.locator('.toast').getByRole('button', { name: '撤销' }).click()
  const errorToast = page.locator('.toast[role="alert"]')
  await expect(errorToast).toContainText('这次操作没有完成')
  await expect(errorToast).toHaveCount(1)
  expect(pageErrors).toEqual([])
})

test('浅色与深色下 Toast 文字与撤销按钮都达到 4.5:1', async ({
  launch,
  userDataDirectory
}) => {
  seedUnfiledPin(userDataDirectory)
  writeSetting(databasePath(userDataDirectory), 'theme', 'dark')
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await discardOnePin(page)
  await expectReadableText(page, [
    { label: '深色 Toast 文字', selector: '.toast-message' },
    { label: '深色 Toast 撤销按钮', selector: '.toast-undo' }
  ])

  // 切回浅色后再触发一条新的 Toast（同一套全局组件）。
  await page.getByRole('button', { name: '撤销' }).click()
  await page.getByRole('button', { name: '关闭钉板' }).click()
  await nav(page).getByRole('button', { name: '设置', exact: true }).click()
  await page
    .getByRole('complementary', { name: '设置分区' })
    .getByRole('button', { name: '外观', exact: true })
    .click()
  await page.getByRole('group', { name: '主题' }).getByRole('button', { name: '浅色' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await nav(page).getByRole('button', { name: '对话', exact: true }).click()
  await page.getByRole('button', { name: /^钉板 / }).click()
  await page
    .getByRole('complementary', { name: '钉板' })
    .getByRole('tab', { name: '未归档 1', exact: true })
    .click()
  await page.locator('.pin-card').first().getByRole('button', { name: '丢弃' }).click()
  await expect(page.locator('.toast')).toContainText('已丢弃')
  await expectReadableText(page, [
    { label: '浅色 Toast 文字', selector: '.toast-message' },
    { label: '浅色 Toast 撤销按钮', selector: '.toast-undo' }
  ])
})

test('减少动态效果时 Toast 不播放入场与倒计时动画', async ({ launch, userDataDirectory }) => {
  seedUnfiledPin(userDataDirectory)
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await discardOnePin(page)
  const animations = await page.locator('.toast').evaluate((element) => ({
    toast: getComputedStyle(element).animationName,
    progress: getComputedStyle(element.querySelector('.toast-progress')!).animationName
  }))
  expect(animations.toast).toBe('none')
  expect(animations.progress).toBe('none')
})
