import type { Page } from '@playwright/test'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { selectAnswerText } from '../fixtures/answer-selection'
import { clickAway, selectText } from '../fixtures/reading'

/**
 * 收官验收：整条学习链路一条用例跑完。
 * 从空白库开始，用随包的真实语料（63 篇）走完
 * 首页 → 文章库 → 阅读 → 选词 → 词条 → 对话 → 钉住 → 钉板归位 → 来源回跳。
 */

const stubs: SseStub[] = []

const ANSWER = '这里的表达指「着手处理」一件事，而不是单纯地靠近。'
const PINNED = '着手处理'

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

async function createStub(): Promise<SseStub> {
  const stub = await startSseStub({ kind: 'stream', thinking: ['先看语境。'], text: [ANSWER] })
  stubs.push(stub)
  return stub
}

function environment(baseUrl: string): Record<string, string> {
  return {
    DEEPSEEK_BASE_URL: baseUrl,
    DEEPSEEK_API_KEY: 'e2e-acceptance-key',
    DEEPSEEK_MODEL: 'deepseek-flash'
  }
}

function nav(page: Page, label: string) {
  return page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: label, exact: true })
}

/** 从第一段的正文里挑一个至少四个字母的词；返回它和它所在段落的索引。 */
async function pickWord(page: Page): Promise<{ word: string; paragraphIndex: number }> {
  const picked = await page.evaluate(() => {
    const paragraphs = Array.from(document.querySelectorAll('.reading-paragraph'))
    for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
      const text = paragraph.textContent ?? ''
      const matches = text.match(/[A-Za-z]{5,}/g) ?? text.match(/[A-Za-z]{4,}/g)
      if (matches === null || matches.length === 0) continue
      return { word: matches[0] as string, paragraphIndex }
    }
    throw new Error('正文里没有可选的英文词')
  })
  return picked
}

async function ask(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: '输入问题' }).fill(text)
  await page.getByRole('button', { name: '发送' }).click()
}

test.describe('收官验收 · 整条学习链路', () => {
  test('首页 → 文章库 → 阅读选词 → 词条 → 对话 → 钉住 → 钉板归位 → 来源回跳', async ({
    launch
  }) => {
    const stub = await createStub()
    const { page } = await launch({ env: environment(stub.baseUrl) })

    // 1. 首页：干净的首屏空态。
    await expect(page.getByRole('heading', { name: '先读一篇' })).toBeVisible()

    // 2. 文章库：63 篇真题材按场次分组，详情面板能开这一篇。
    await page.getByRole('button', { name: '从文章库挑一篇' }).click()
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()
    await expect(page.locator('.library-count')).toHaveText('63 篇 · 7 个场次')
    await page.locator('.library-row').first().click()
    const detail = page.getByRole('complementary', { name: '文章详情' })
    await expect(detail).toBeVisible()
    const articleTitle = (await detail.locator('.library-detail-title').textContent()) ?? ''
    expect(articleTitle).not.toBe('')

    // 3. 阅读：620 列正文，在第一段圈一个词。
    await detail.getByRole('button', { name: '继续阅读' }).click()
    await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
    await expect(page.getByRole('heading', { name: articleTitle, level: 1 })).toBeVisible()

    const { word, paragraphIndex } = await pickWord(page)
    await selectText(page, paragraphIndex, word)
    await expect(page.locator('.reading-selected')).toHaveText([word])

    const collectedPanel = page.getByRole('complementary', { name: '选词结果' })
    await expect(collectedPanel).toBeVisible()
    await expect(collectedPanel.getByText('已收下')).toBeVisible()
    // 词头只印一次词形；主词形与新收词形相同时就是它自己。
    const entryName = ((await collectedPanel.locator('.reading-panel-word').textContent()) ?? '').trim()
    expect(entryName).not.toBe('')

    await clickAway(page)
    await expect(page.locator('.reading-collected')).toHaveCount(1)

    // 4. 首页继续阅读：退回文章库，再回首页，看到这一篇和上次位置。
    await page.locator('.reading-scroll').evaluate((element) => {
      element.scrollTop = 600
    })
    await page.waitForTimeout(900)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: '文章库', level: 1 })).toBeVisible()

    await nav(page, '首页').click()
    // 继续阅读：场次在 eyebrow，标题只留篇名，meta 不重复场次与题型。
    const titleParts = articleTitle.split(' · ')
    const displayTitle = titleParts[titleParts.length - 1] ?? articleTitle
    await expect(page.getByRole('heading', { name: displayTitle, level: 1 })).toBeVisible()
    await expect(page.locator('.home-continue .eyebrow')).toHaveText(
      titleParts.slice(0, 2).join(' · ')
    )
    await expect(page.locator('.home-meta')).toHaveText(/\d+ 词 · 读到 \d+%/)
    await expect(page.getByText(/上次停在 第 \d+ 段 · 第 \d+ 句/)).toBeVisible()

    await page.getByRole('button', { name: '继续阅读' }).click()
    await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: displayTitle, level: 1 })).toBeVisible()

    // 5. 词条：原句已按文章分组收进来。
    await nav(page, '词条').click()
    await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
    await page
      .locator('.entries-row')
      .filter({
        has: page.locator('.entries-row-name', {
          hasText: new RegExp(`^${escapeRegExp(entryName)}$`, 'i')
        })
      })
      .click()
    await expect(page.getByRole('heading', { name: entryName, level: 2 })).toBeVisible()
    const sentenceGroup = page
      .locator('.entry-group')
      .filter({ has: page.locator('.entry-group-head', { hasText: articleTitle }) })
    await expect(sentenceGroup).toBeVisible()
    await expect(sentenceGroup.locator('.entry-sentence-text').first()).toContainText(word)

    // 6. 对话：从词条开线程，问题带上这个词条作上下文，回答流式抵达。
    await page.locator('.entries-main-actions').getByRole('button', { name: '问模型' }).click()
    await expect(page.getByRole('heading', { name: entryName, level: 1 })).toBeVisible()
    await expect(page.locator('.context-panel')).toContainText(entryName)
    await ask(page, '这个词在这句话里怎么理解？')
    await expect(page.locator('.assistant-text')).toContainText(ANSWER)
    await expect(page.getByRole('button', { name: '钉住', exact: true })).toBeVisible()

    // 7. 钉住：选中一段，先放进未归档。
    await selectAnswerText(page, PINNED)
    await page
      .locator('.selection-capsule')
      .getByRole('button', { name: '钉住', exact: true })
      .click()
    const pinDialog = page.getByRole('dialog', { name: '钉到哪儿' })
    await expect(pinDialog.getByRole('button', { name: /词条 · / })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await pinDialog.getByRole('button', { name: '未归档' }).click()
    await pinDialog.getByRole('button', { name: '钉住', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('已放进未归档')
    const pinBoard = page.getByRole('complementary', { name: '钉板' })
    const pinBoardHandle = pinBoard.getByRole('button', { name: /未归档 1/ })
    await expect(pinBoardHandle).toBeVisible()

    // 8. 钉板归位：从钉板把这条未归档归到词条。
    await pinBoardHandle.click()
    await expect(page.getByRole('tab', { name: '未归档 1' })).toBeVisible()
    await expect(page.locator('.pin-card')).toContainText(PINNED)
    await page.getByRole('button', { name: '归到词条' }).click()
    const fileDialog = page.getByRole('dialog', { name: '归到哪儿' })
    await expect(fileDialog.getByRole('button', { name: `词条 · ${entryName}` })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await fileDialog.getByRole('button', { name: '归位' }).click()
    await expect(page.getByRole('status')).toContainText(`已归到 ${entryName}`)
    await page.getByRole('tab', { name: '当前对话' }).click()
    await expect(page.locator('.pin-card')).toContainText(PINNED)

    // 9. 来源回跳：词条学习内容里出现来源行，点回对话并高亮那段回答。
    await nav(page, '词条').click()
    await page
      .locator('.entries-row')
      .filter({
        has: page.locator('.entries-row-name', {
          hasText: new RegExp(`^${escapeRegExp(entryName)}$`, 'i')
        })
      })
      .click()
    await page.getByRole('button', { name: /^词典与学习内容/ }).click()
    await expect(page.locator('.entry-note-body')).toContainText(PINNED)
    await expect(page.locator('.entry-note-source')).toContainText(
      `来自 ${entryName} · 第 1 轮`
    )
    await page.getByRole('button', { name: '看原对话' }).click()

    await expect(page.getByRole('status')).toContainText(`来自词条 ${entryName} · 学习内容`)
    await expect(page.locator('.assistant-text [data-md-block].is-source-hit')).toHaveCount(1)
    await expect(page.locator('.assistant-text [data-md-block].is-pinned')).toHaveCount(1)
    await expect(page.locator('.assistant-text')).toContainText(PINNED)
  })
})

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
