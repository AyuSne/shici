import type { Page } from '@playwright/test'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'

/**
 * #79 / #83 选区浮胶囊：长回答滚动到中段后，选区起点已经在视口上方。
 * 胶囊必须落在可见安全区（标题栏以下），不能因为 anchor.top 为负而跑到窗口外。
 */

const PARAGRAPHS = Array.from({ length: 26 }, (_value, index) =>
  `Paragraph ${index + 1} keeps enough words on the page so the answer scrolls well beyond one screen.`
)

let stub: SseStub

test.afterEach(async () => {
  await stub?.close()
})

async function ask(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '对话' })
    .click()
  await page.getByRole('textbox', { name: '输入问题' }).fill('给我一段很长的回答')
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.locator('.assistant-text[data-answer-id] p').last()).toBeVisible()
}

test('长回答滚动后选区起点在视口上方时，浮胶囊仍在标题栏以下且可点', async ({ launch }) => {
  stub = await startSseStub({ kind: 'stream', text: [PARAGRAPHS.join('\n\n')] })
  const { page } = await launch({
    env: {
      DEEPSEEK_BASE_URL: stub.baseUrl,
      DEEPSEEK_API_KEY: 'e2e-test-key',
      DEEPSEEK_MODEL: 'deepseek-flash'
    }
  })
  await ask(page)
  await expect(page.locator('.assistant-text[data-answer-id] p')).toHaveCount(PARAGRAPHS.length)

  const selectionTop = await page.evaluate(() => {
    const scroller = document.querySelector('.chat-scroll')
    if (scroller === null) throw new Error('没有对话滚动容器')
    scroller.scrollTop = scroller.scrollHeight
    const paragraphs = Array.from(
      document.querySelectorAll('.assistant-text[data-answer-id] p')
    )
    const startParagraph = paragraphs[2]
    const endParagraph = paragraphs.find((paragraph) => {
      const rect = paragraph.getBoundingClientRect()
      return rect.top > 120 && rect.bottom < window.innerHeight - 80
    })
    if (!startParagraph || !endParagraph) throw new Error('没有可选段落')
    const firstText = (element: Element): Text | null => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      return walker.nextNode() as Text | null
    }
    const lastText = (element: Element): Text | null => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      let last: Text | null = null
      while (walker.nextNode()) last = walker.currentNode as Text
      return last
    }
    const startNode = firstText(startParagraph)
    const endNode = lastText(endParagraph)
    if (startNode === null || endNode === null) throw new Error('段落没有文字')
    const range = document.createRange()
    range.setStart(startNode, 0)
    range.setEnd(endNode, endNode.data.length)
    const selection = window.getSelection()
    if (selection === null) throw new Error('没有选区')
    selection.removeAllRanges()
    selection.addRange(range)
    scroller.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    return range.getBoundingClientRect().top
  })

  // 真实复现：选区起点确实在视口上方（负坐标）。
  expect(selectionTop).toBeLessThan(0)
  const capsule = page.locator('.selection-capsule')
  await expect(capsule).toBeVisible()
  const titlebar = await page.locator('.titlebar').boundingBox()
  const box = await capsule.boundingBox()
  if (titlebar === null || box === null) throw new Error('没有量到标题栏或胶囊')
  expect(box.y).toBeGreaterThanOrEqual(titlebar.y + titlebar.height - 1)
  const viewport = await page.evaluate(() => window.innerHeight)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport)
  // 胶囊仍可点：不给被裁掉的按钮留位置。
  await expect(capsule.getByRole('button', { name: '复制', exact: true })).toBeEnabled()
})
