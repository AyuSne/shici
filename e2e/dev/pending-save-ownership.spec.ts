import type { ElectronApplication } from '@playwright/test'
import { openDatabase } from '../../src/main/db/database'
import { migrate } from '../../src/main/db/migrations'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { ask, openChat, seedAnsweredThread } from '../fixtures/chat'
import { databasePath } from '../fixtures/database'

/**
 * E2：A 的回答已经生成完，落库调用失败时用户已打开 B。
 * 旧行为会把「回答没能保存」和“重新生成”写到 B；修复后错误与未保存正文归属 A，
 * 回到 A 可以看到原文并只重试保存，不重新请求模型。
 */

let stub: SseStub

test.afterEach(async () => {
  await stub?.close()
})

async function holdFailingSave(app: ElectronApplication): Promise<{
  pending: () => Promise<boolean>
  release: () => Promise<void>
}> {
  const gate = '__e2ePendingSaveGate'
  await app.evaluate(({ ipcMain }, key) => {
    type Handler = Parameters<typeof ipcMain.handle>[1]
    const handlers = (ipcMain as typeof ipcMain & {
      _invokeHandlers: Map<string, Handler>
    })._invokeHandlers
    const original = handlers.get('chat:answer')
    if (!original) throw new Error('没有注册 chat:answer')
    ipcMain.removeHandler('chat:answer')
    ipcMain.handle('chat:answer', async (...args) => {
      ipcMain.removeHandler('chat:answer')
      ipcMain.handle('chat:answer', original)
      const globals = globalThis as Record<string, unknown>
      await new Promise<void>((resolve) => {
        globals[key] = resolve
      })
      // 模拟回复丢失：服务端已经写入，renderer 只收到 throw。
      await original(...args)
      throw new Error('e2e 保存回复丢失')
    })
  }, gate)
  return {
    pending: () => app.evaluate((_electron, key) => key in globalThis, gate),
    release: () =>
      app.evaluate((_electron, key) => {
        const globals = globalThis as Record<string, unknown>
        const release = globals[key]
        if (typeof release !== 'function') throw new Error('没有待释放的保存')
        delete globals[key]
        release()
      }, gate)
  }
}

function seedB(userDataDirectory: string): string {
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    migrate(database)
    return seedAnsweredThread(database, {
      question: 'B 的问题',
      answer: '这是 B 的已有回答，不能被 A 的保存错误覆盖。'
    }).threadId
  } finally {
    database.close()
  }
}

test('A 后台保存回复丢失后切到 B 再回 A：B 干净，A 的未保存正文仍在且只重试保存', async ({
  launch,
  userDataDirectory
}) => {
  const threadB = seedB(userDataDirectory)
  stub = await startSseStub({
    kind: 'hang',
    text: ['A 未保存正文。']
  })
  const { page, electronApp } = await launch({
    env: {
      DEEPSEEK_BASE_URL: stub.baseUrl,
      DEEPSEEK_API_KEY: 'e2e-test-key',
      DEEPSEEK_MODEL: 'deepseek-flash'
    }
  })
  if (electronApp === null) throw new Error('需要 Electron 主进程句柄')
  await openChat(page)
  await ask(page, 'A 的问题')
  await expect(page.locator('.assistant-text')).toContainText('A 未保存正文。')
  const threadA = await page.evaluate(() => window.location.hash.replace('#/chat/', ''))
  expect(threadA).not.toBe('')

  const gate = await holdFailingSave(electronApp as ElectronApplication)
  await page.keyboard.press('Escape')
  await expect.poll(gate.pending).toBe(true)

  await page.evaluate((id) => {
    window.location.hash = `#/chat/${id}`
  }, threadB)
  await expect(page.locator('.assistant-text[data-answer-id]')).toContainText('这是 B 的已有回答')
  await expect(page.locator('.pending-save')).toHaveCount(0)
  await gate.release()
  await page.waitForTimeout(300)

  // B 不被 A 的失败污染，也没有 A 的待保存正文。
  await expect(page.locator('.assistant-text[data-answer-id]')).toContainText('这是 B 的已有回答')
  await expect(page.getByText('这条回答没能保存')).toHaveCount(0)
  await expect(page.locator('.pending-save')).toHaveCount(0)

  await page.evaluate((id) => {
    window.location.hash = `#/chat/${id}`
  }, threadA)
  const pending = page.getByRole('region', { name: '尚未保存的回答' })
  await expect(pending).toBeVisible()
  await expect(pending).toContainText('A 未保存正文。')
  const composer = page.getByRole('textbox', { name: '输入问题' })
  await expect(composer).toBeEditable()
  await composer.fill('保存后再发')
  await expect(page.getByRole('button', { name: '发送' })).toBeDisabled()
  const requestsBeforeRetry = stub.requests.length

  await pending.getByRole('button', { name: '保存这条回答' }).click()
  await expect(pending).toHaveCount(0)
  await expect(page.getByRole('button', { name: '发送' })).toBeEnabled()
  await expect(page.locator('.assistant-text[data-answer-id]')).toContainText('A 未保存正文。')
  expect(stub.requests.length).toBe(requestsBeforeRetry)

  // 服务端第一次其实已提交；retry 同 attempt 只能有一条不可变回答。
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    const row = database
      .prepare(
        `SELECT COUNT(*) AS count FROM thread_entry
          WHERE thread_id = ? AND kind = 'answer'`
      )
      .get(threadA) as { count: number }
    expect(row.count).toBe(1)
  } finally {
    database.close()
  }
})
