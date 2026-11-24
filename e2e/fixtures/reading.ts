import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

/**
 * 打开一篇文章的阅读页：文章库 → 第一行 → 继续阅读。
 * `title` 是语料里的篇名，用来确认打开的是这一篇。
 */
export async function openArticle(page: Page, title: string): Promise<void> {
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '文章库' })
    .click()
  await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
  await page.locator('.library-row').first().click()
  await page
    .getByRole('complementary', { name: '文章详情' })
    .getByRole('button', { name: '继续阅读' })
    .click()
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible()
}

/**
 * 按段落在 DOM 里圈出一段文字，再补一次 mouseup，走的是阅读页真实的选区处理。
 * 浏览器里拖选不一定逐字可控，这里用 Range 精确落下同一段选区。
 */
export async function selectText(
  page: Page,
  paragraphIndex: number,
  text: string
): Promise<void> {
  // 正文可能还在从主进程读回来，先等这一段真的挂上再落选区。
  await expect(page.locator('.reading-paragraph').nth(paragraphIndex)).toBeAttached()
  await page.evaluate(
    ({ paragraphIndex: index, text: target }) => {
      const paragraph = document.querySelectorAll('.reading-paragraph')[index]
      if (!paragraph) throw new Error(`没有第 ${index} 段`)
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      const nodes: { node: Text; start: number }[] = []
      let full = ''
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        nodes.push({ node, start: full.length })
        full += node.textContent ?? ''
      }
      const start = full.indexOf(target)
      if (start < 0) throw new Error(`段落里没有 ${target}`)

      const locate = (offset: number): [Text, number] => {
        for (const entry of nodes) {
          const length = entry.node.textContent?.length ?? 0
          if (offset >= entry.start && offset <= entry.start + length) {
            return [entry.node, offset - entry.start]
          }
        }
        const last = nodes.at(-1)
        if (!last) throw new Error('没有文字节点')
        return [last.node, last.node.textContent?.length ?? 0]
      }

      const [startNode, startOffset] = locate(start)
      const [endNode, endOffset] = locate(start + target.length)
      const range = document.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(endNode, endOffset)
      const selection = window.getSelection()
      if (!selection) throw new Error('没有选区')
      selection.removeAllRanges()
      selection.addRange(range)
      document
        .querySelector('.reading-body')
        ?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    },
    { paragraphIndex, text }
  )
}

/** 点正文外的地方收起浮层，让选中态变成已收集的弱高亮。 */
export async function clickAway(page: Page): Promise<void> {
  await page.locator('.reading-bar-title').click()
  await expect(page.locator('.reading-selected')).toHaveCount(0)
}

/**
 * 段落正文里一个字符中心点的屏幕坐标。双击与拖选都按真实鼠标位置走，
 * 不靠直接改 Range，这样吸附逻辑真的经过浏览器选区。
 */
async function characterCenter(
  page: Page,
  paragraphIndex: number,
  offset: number
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ paragraphIndex: index, offset: characterOffset }) => {
      const paragraph = document.querySelectorAll('.reading-paragraph')[index]
      if (!paragraph) throw new Error(`没有第 ${index} 段`)
      const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT)
      const nodes: { node: Text; start: number }[] = []
      let full = ''
      while (walker.nextNode()) {
        const node = walker.currentNode as Text
        nodes.push({ node, start: full.length })
        full += node.textContent ?? ''
      }
      const locate = (position: number): [Text, number] => {
        for (const entry of nodes) {
          const length = entry.node.textContent?.length ?? 0
          if (position >= entry.start && position <= entry.start + length) {
            return [entry.node, position - entry.start]
          }
        }
        throw new Error(`段落里没有第 ${position} 个字符`)
      }
      const [startNode, startOffset] = locate(characterOffset)
      const [endNode, endOffset] = locate(characterOffset + 1)
      const range = document.createRange()
      range.setStart(startNode, startOffset)
      range.setEnd(endNode, endOffset)
      const rect = range.getBoundingClientRect()
      // 设备像素比会给出 391.5 这类半像素坐标；取整后拖选才稳定落在字形内。
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }
    },
    { paragraphIndex, offset }
  )
}

/** 段落里某个词第一次出现处的字符区间，供测试算真实鼠标落点。 */
async function wordOffsets(
  page: Page,
  paragraphIndex: number,
  word: string
): Promise<{ start: number; end: number }> {
  return page.evaluate(
    ({ paragraphIndex: index, word: needle }) => {
      const paragraph = document.querySelectorAll('.reading-paragraph')[index]
      if (!paragraph) throw new Error(`没有第 ${index} 段`)
      const text = paragraph.textContent ?? ''
      const start = text.indexOf(needle)
      if (start < 0) throw new Error(`段落里没有 ${needle}`)
      return { start, end: start + needle.length }
    },
    { paragraphIndex, word }
  )
}

/** 真实双击段落里的一个词：落在词中部，浏览器会先选出这个词。 */
export async function doubleClickWord(
  page: Page,
  paragraphIndex: number,
  word: string
): Promise<void> {
  const { start, end } = await wordOffsets(page, paragraphIndex, word)
  const center = await characterCenter(page, paragraphIndex, start + Math.floor((end - start) / 2))
  await page.mouse.dblclick(center.x, center.y)
}

/**
 * 真实拖选：从第一个词的中部拖到第二个词的中部，起止都落在英文词内部，
 * 由阅读页的吸附逻辑补成完整词形。
 */
export async function dragBetweenWords(
  page: Page,
  paragraphIndex: number,
  fromWord: string,
  toWord: string
): Promise<void> {
  const text = await page.evaluate((index) => {
    const paragraph = document.querySelectorAll('.reading-paragraph')[index]
    return paragraph?.textContent ?? ''
  }, paragraphIndex)
  const fromStart = text.indexOf(fromWord)
  const toStart = text.indexOf(toWord, fromStart + fromWord.length)
  if (fromStart < 0 || toStart < 0) {
    throw new Error(`段落里找不到 ${fromWord} 或 ${toWord}`)
  }
  const from = await characterCenter(
    page,
    paragraphIndex,
    fromStart + Math.floor(fromWord.length / 2)
  )
  const to = await characterCenter(page, paragraphIndex, toStart + Math.floor(toWord.length / 2))
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await page.mouse.up()
}
