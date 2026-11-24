import type { Page } from '@playwright/test'
import { openDatabase } from '../../src/main/db/database'
import { migrate } from '../../src/main/db/migrations'
import { createPin } from '../../src/main/pins/pins'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test, type LaunchOptions, type AppHandle } from '../fixtures/app'
import { selectAnswerRange } from '../fixtures/answer-selection'
import { seedAnsweredThread } from '../fixtures/chat'
import { databasePath } from '../fixtures/database'

const SOURCE = '## **用法** #\r\n\r\n*开头* repeat 😀 **repeat**\r\n软换行 `a*b`\r\n\r\n最后一段。\r\n\r\n- **甲项**\r\n- *乙项*\r\n- 丙项\r\n\r\n3. 顺序一\r\n4. 顺序二'
const THINKING = '这段思维链不属于回答正文。'

let stub: SseStub

test.afterEach(async () => {
  await stub?.close()
})

async function openChat(launch: (options?: LaunchOptions) => Promise<AppHandle>) {
  const app = await launch({
    env: {
      DEEPSEEK_BASE_URL: stub.baseUrl,
      DEEPSEEK_API_KEY: 'e2e-test-key',
      DEEPSEEK_MODEL: 'deepseek-flash'
    }
  })
  await app.page.getByRole('navigation', { name: '全局导航' }).getByRole('button', { name: '对话' }).click()
  return app
}

async function ask(page: Page, question: string) {
  await page.getByRole('textbox', { name: '输入问题' }).fill(question)
  await page.getByRole('button', { name: '发送' }).click()
}

test('活动流和停止后保留 Markdown 结构、段内换行与块间距', async ({ launch }) => {
  stub = await startSseStub({ kind: 'hang', thinking: [THINKING], text: [SOURCE] })
  const { page } = await openChat(launch)
  await ask(page, '请按结构解释')
  const answer = page.getByRole('article', { name: '学习助手' })
  const body = answer.locator('.assistant-text')
  const heading = body.getByRole('heading', { name: '用法', exact: true })
  await expect(heading).toBeVisible()
  await expect(heading).toHaveCSS('line-height', '24px')
  await expect(heading.locator('strong')).toHaveText('用法')
  await expect(body.locator('p em')).toHaveText('开头')
  await expect(body.locator('p strong')).toHaveText('repeat')
  await expect(body.locator('code')).toHaveText('a*b')
  await expect(body.locator('ul > li')).toHaveText(['甲项', '乙项', '丙项'])
  await expect(body.locator('ul > li').nth(1)).toHaveCSS('margin-top', '8px')
  await expect(body.locator('ol > li')).toHaveText(['顺序一', '顺序二'])
  await expect(body.locator('ol')).toHaveJSProperty('start', 3)
  await expect(body).not.toContainText(/\*\*|## |^- |^[34]\. /m)
  const [firstLine, secondLine, paragraph, list] = await Promise.all([
    body.locator('p strong').boundingBox(), body.locator('code').boundingBox(),
    body.locator('p').last().boundingBox(), body.locator('ul').boundingBox()
  ])
  expect(secondLine!.y).toBeGreaterThan(firstLine!.y + firstLine!.height)
  expect(list!.y).toBeGreaterThan(paragraph!.y + paragraph!.height)
  await expect(answer.getByRole('button', { name: '钉住', exact: true })).toHaveCount(0)
  await expect(answer.getByRole('button', { name: /已思考/ })).toHaveAttribute('aria-expanded', 'false')
  await selectAnswerRange(page,
    { selector: '.assistant-text h3', childOffset: 0 },
    { selector: '.assistant-text h3', childOffset: 1 })
  await expect(page.locator('.selection-capsule')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await expect(answer.getByText('已停止 · 未完成')).toBeVisible()
  await expect(heading).toBeVisible()
  await expect(answer.getByRole('button', { name: '钉住', exact: true })).toBeVisible()
})

async function pinSelection(page: Page, count: number) {
  await page.locator('.selection-capsule').getByRole('button', { name: '钉住', exact: true }).click()
  await page.getByRole('dialog', { name: '钉到哪儿' }).getByRole('button', { name: '钉住', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '钉板' }).getByRole('button', { name: new RegExp(`未归档 ${count}`) })).toBeVisible()
}

test('跨段、跨列表和叶边界的选区以原文保存，只标命中块', async ({ launch }) => {
  stub = await startSseStub({ kind: 'stream', thinking: [THINKING], text: [SOURCE] })
  const { page } = await openChat(launch)
  await ask(page, '请给我可以钉住的回答')
  const body = page.locator('.assistant-text[data-answer-id]')
  await expect(body.locator('ol')).toBeVisible()

  // Start at the preceding leaf's end and end at the break leaf's start. Neither
  // neighboring leaf contributes a character; only the second "repeat" is selected.
  const paragraph = '.assistant-text p'
  await selectAnswerRange(page,
    { selector: paragraph, text: ' repeat 😀 ', edge: 'end' },
    { selector: paragraph, text: '\r\n' })
  await pinSelection(page, 1)

  await selectAnswerRange(page,
    { selector: paragraph, text: '😀' },
    { selector: paragraph, index: 1, text: '最后', edge: 'end' })
  await pinSelection(page, 2)
  await expect(body.locator('p.is-pinned')).toHaveCount(2)
  await expect(body.locator('h3.is-pinned')).toHaveCount(0)

  // Select two complete list items backwards using only list element boundaries.
  const list = '.assistant-text ul'
  await selectAnswerRange(page, { selector: list, childOffset: 2 }, { selector: list, childOffset: 0 })
  await pinSelection(page, 3)
  await expect(body.locator('ul > li.is-pinned')).toHaveCount(2)
  await expect(body.locator('ul > li').last()).not.toHaveClass(/is-pinned/)
  await expect(body.locator('ul .pin-badge')).toHaveCount(1)

  // A badge cannot be an endpoint even though it's inside a Markdown block.
  const listStart = { selector: list, childOffset: 0 }
  const listEnd = { selector: list, childOffset: 2 }
  const card = page.locator('.selection-capsule')
  await selectAnswerRange(page, listStart, listEnd)
  await expect(card).toBeVisible()
  await selectAnswerRange(page, listStart, { selector: `${list} .pin-badge`, text: '已钉', edge: 'end' })
  await expect(card).toHaveCount(0)

  await page.getByRole('button', { name: /已思考/ }).click()
  await selectAnswerRange(page, listStart, listEnd)
  await expect(card).toBeVisible()
  await selectAnswerRange(page, { selector: '.thinking-body', text: THINKING }, listEnd)
  await expect(card).toHaveCount(0)

  await page.getByRole('complementary', { name: '钉板' }).getByRole('button', { name: /未归档 3/ }).click()
  await expect.poll(async () => (await page.locator('.pin-card-excerpt').evaluateAll(
    (cards) => cards.map((card) => card.getAttribute('title'))
  )).sort()).toEqual([
    'repeat', '😀 **repeat**\r\n软换行 `a*b`\r\n\r\n最后', '甲项**\r\n- *乙项'
  ].sort())
})

function seedLegacyPin(userDataDirectory: string) {
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    migrate(database)
    const { threadId, answerId } = seedAnsweredThread(database, { question: '旧版对话', answer: SOURCE })
    const pinned = createPin(database, {
      threadId, answerId,
      start: SOURCE.indexOf('最后一段。'),
      end: SOURCE.indexOf('- *乙项*'),
      target: { kind: 'unfiled' }
    })
    if (pinned.status !== 'pinned') throw new Error('没钉上')
  } finally {
    database.close()
  }
}

test('旧纯文本钉住只标相交的段与列表项，错误部分仍可单独选择', async ({ launch, userDataDirectory }) => {
  seedLegacyPin(userDataDirectory)
  stub = await startSseStub({ kind: 'truncate', text: ['**错误前的部分**'] })
  const { page } = await openChat(launch)
  await page.getByRole('button', { name: /旧版对话 未挂对象/ }).click()
  const firstAnswer = page.getByRole('article', { name: '学习助手' }).first()
  const body = firstAnswer.locator('.assistant-text')
  const bars = body.locator('.is-pinned')
  await expect(bars).toHaveText(['最后一段。', '甲项'])
  expect(await bars.evaluateAll((elements) => elements.map((element) => getComputedStyle(element, '::before').width))).toEqual(['2px', '2px'])
  await expect(body.locator('.pin-badge')).toHaveCount(0)

  await ask(page, '接着再问一次')
  const partial = page.getByRole('article', { name: '学习助手' }).last()
  await expect(partial.getByRole('alert')).toBeVisible()
  await expect(partial.locator('strong')).toHaveText('错误前的部分')
  await expect(partial.getByText('未完成', { exact: true })).toBeVisible()

  const start = { selector: '.assistant-text p strong', index: 1, text: '错误前的部分' }
  const end = { ...start, edge: 'end' } as const
  const card = page.locator('.selection-capsule')
  await selectAnswerRange(page, start, end)
  await expect(card).toBeVisible()
  await selectAnswerRange(page, { selector: '.assistant-text h3', text: '用法' }, end)
  await expect(card).toHaveCount(0)
})

test('回答复制按钮把原始 Markdown 正文写进剪贴板，不带思维链', async ({ launch }) => {
  stub = await startSseStub({ kind: 'stream', thinking: [THINKING], text: [SOURCE] })
  const { page } = await openChat(launch)
  const writes = await page.evaluateHandle(() => {
    const captured: string[] = []
    navigator.clipboard.writeText = async (text) => { captured.push(text) }
    return captured
  })
  await ask(page, '这条回答要复制')
  const answer = page.getByRole('article', { name: '学习助手' })
  await answer.getByRole('button', { name: /已思考/ }).click()
  await expect(answer.getByTestId('thinking-body')).toHaveText(THINKING)
  await answer.getByRole('button', { name: '复制', exact: true }).click()
  await expect(page.getByRole('status')).toHaveText('已复制')
  expect(await writes.jsonValue()).toEqual([SOURCE])
})
