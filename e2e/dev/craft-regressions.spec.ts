import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/main/db/database'
import { migrate } from '../../src/main/db/migrations'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { selectAnswerRange } from '../fixtures/answer-selection'
import { seedWordGroupThread } from '../fixtures/chat'
import { databasePath } from '../fixtures/database'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'

/**
 * 文档硬性 token 的运行时回归：不用肉眼，也不读源码字符串；从真实渲染出的
 * computed style / 实际加载的样式表取过渡时长、圆角、字号、关键帧位移。
 */

const TITLE = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-craft-regressions',
  year: 2026,
  month: 6,
  set: 1,
  label: TITLE,
  sentences: [
    ['The alpha value appears first.', 'The bravo value appears next.'],
    ['Another alpha line keeps the page tall.']
  ]
})

const picks: SeedPick[] = [
  { entry: article, paragraphIndex: 0, needle: 'alpha', at: '2026-11-18T08:00:00.000Z' },
  { entry: article, paragraphIndex: 1, needle: 'alpha', at: '2026-11-18T08:05:00.000Z' }
]

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-craft-regressions-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function entryIds(userDataDirectory: string): string[] {
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    migrate(database)
    const rows = database
      .prepare('SELECT id FROM word_entry ORDER BY main_form')
      .all() as { id: string }[]
    return rows.map((row) => row.id)
  } finally {
    database.close()
  }
}

test('导航 / 选择器 / Toast / 钉住竖线的运行时样式符合 token', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const ids = entryIds(userDataDirectory)
  const database = openDatabase(databasePath(userDataDirectory))
  let threadId: string
  try {
    migrate(database)
    threadId = seedWordGroupThread(database, {
      entries: ids.map((id) => ({ entryId: id, mainForm: 'alpha' })),
      question: '怎么用',
      answer: 'The alpha value and the bravo value both matter.'
    }).threadId
  } finally {
    database.close()
  }

  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.evaluate((id) => {
    window.location.hash = `#/chat/${id}`
  }, threadId)
  await expect(page.locator('.assistant-text[data-answer-id] p')).toContainText('alpha')

  // 140ms 不在 token 的 150–260ms 里：收起侧栏的文字/计数/悬停提示都用 150ms 悬停档。
  await page.locator('.nav-collapse').click()
  await expect(page.locator('.globals')).toHaveClass(/is-collapsed/)
  const durations = await page.evaluate(() => {
    const read = (selector: string): string[] => {
      const element = document.querySelector(selector)
      if (element === null) throw new Error(`没有 ${selector}`)
      const style = getComputedStyle(element)
      return [style.transitionDuration, style.transitionProperty]
    }
    return {
      label: read('.nav-label'),
      count: read('.nav-count'),
      tip: read('.nav-tip'),
      kbd: getComputedStyle(document.querySelector('.nav-kbd')!).fontSize,
      collapseRadius: getComputedStyle(document.querySelector('.nav-collapse')!).borderRadius,
      tipRadius: getComputedStyle(document.querySelector('.nav-tip')!).borderRadius
    }
  })
  expect(durations.label[0]).toContain('0.15s')
  expect(durations.count[0]).toContain('0.15s')
  expect(durations.tip[0]).toContain('0.15s')
  expect(`${durations.label[0]}${durations.count[0]}${durations.tip[0]}`).not.toContain('0.14s')
  expect(durations.kbd).toBe('12px')
  expect(durations.collapseRadius).toBe('8px')
  expect(durations.tipRadius).toBe('8px')

  // 钉住弹层：输入框焦点偏移统一 2px，候选圆角用 8px 档。
  await selectAnswerRange(
    page,
    { selector: '.assistant-text[data-answer-id] p', text: 'alpha' },
    { selector: '.assistant-text[data-answer-id] p', text: 'alpha', edge: 'end' }
  )
  await page
    .locator('.selection-capsule')
    .getByRole('button', { name: '钉住', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: '钉到哪儿' })
  await expect(dialog.locator('.target-picker-current')).toContainText('alpha')
  await dialog.getByRole('combobox', { name: '选择词条' }).click()
  await expect(dialog.getByRole('option').first()).toBeVisible()
  const pickerStyles = await page.evaluate(() => {
    const readRule = (selectorText: string, property: string): string => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList
        try {
          rules = sheet.cssRules
        } catch {
          continue
        }
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSStyleRule && rule.selectorText.includes(selectorText)) {
            const value = rule.style.getPropertyValue(property)
            if (value !== '') return value
          }
        }
      }
      return ''
    }
    return {
      optionRadius: getComputedStyle(document.querySelector('.target-picker-option')!).borderRadius,
      // outline-offset 会被窗口缩放折算；读真实加载规则里的声明值，避免 1.71px 的噪声。
      focusOffset: readRule('.target-picker-input:focus-visible', 'outline-offset')
    }
  })
  expect(pickerStyles.optionRadius).toBe('8px')
  expect(pickerStyles.focusOffset).toBe('2px')

  // 落钉：Toast 字号回到 12px 档；倒计时与新鲜钉住竖线都不许缩放。
  await page.keyboard.press('Enter') // 选中候选
  await page.keyboard.press('Enter') // 确认落钉
  await expect(page.locator('.toast')).toContainText('已钉到词条 alpha')
  const animationStyles = await page.evaluate(() => {
    const toast = document.querySelector('.toast')!
    const progress = document.querySelector('.toast-progress')!
    const keyframesOf = (name: string): string[] => {
      for (const sheet of Array.from(document.styleSheets)) {
        let rules: CSSRuleList
        try {
          rules = sheet.cssRules
        } catch {
          continue
        }
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSKeyframesRule && rule.name === name) {
            return Array.from(rule.cssRules).map(
              (frame) => (frame as CSSKeyframeRule).style.cssText
            )
          }
        }
      }
      return []
    }
    const fresh = document.querySelector('.is-fresh-pin')
    return {
      toastFont: getComputedStyle(toast).fontSize,
      toastLineHeight: getComputedStyle(toast).lineHeight,
      progressTransform: getComputedStyle(progress).transform,
      countdownFrames: keyframesOf('toast-countdown'),
      pinFrames: keyframesOf('pin-line-draw'),
      drawerFrames: keyframesOf('reading-drawer-in'),
      freshPseudoTransform:
        fresh === null
          ? 'missing'
          : getComputedStyle(fresh, '::before').transform
    }
  })
  expect(animationStyles.toastFont).toBe('12px')
  // caption 角色是 12/16，不能只有字号对、行高停在 18。
  expect(animationStyles.toastLineHeight).toBe('16px')
  expect(animationStyles.progressTransform).toBe('none')

  expect(animationStyles.countdownFrames.length).toBeGreaterThan(0)
  expect(animationStyles.countdownFrames.join('')).not.toContain('transform')
  expect(animationStyles.pinFrames.length).toBeGreaterThan(0)
  expect(animationStyles.pinFrames.join('')).not.toContain('transform')
  expect(animationStyles.pinFrames.join('')).toContain('clip-path')

  // 动画结束后竖线不留下任何缩放矩阵。
  await page.waitForTimeout(400)
  const settled = await page.evaluate(() => {
    const fresh = document.querySelector('.is-fresh-pin')
    return fresh === null ? 'missing' : getComputedStyle(fresh, '::before').transform
  })
  if (settled !== 'missing') expect(settled).toBe('none')

  // 轻问抽屉位移 ≤6px：直接读实际加载样式表里的关键帧，不靠静态偏移。
  await page.evaluate((articleId) => {
    window.location.hash = `#/reading/${articleId}?from=home`
  }, article.id)
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await page.locator('.reading-bar').getByRole('button', { name: '问模型' }).click()
  await expect(page.locator('.reading-drawer')).toBeVisible()
  expect(animationStyles.drawerFrames.length).toBeGreaterThan(0)
  const shifts = animationStyles.drawerFrames
    .join(' ')
    .match(/translateX\(([-\d.]+)px\)/g)
    ?.map((value) => Math.abs(Number(/translateX\(([-\d.]+)px\)/.exec(value)![1])))
    .filter((value) => Number.isFinite(value))
  expect(shifts === undefined ? 0 : Math.max(...shifts)).toBeLessThanOrEqual(6)
})

test('阅读眉批标签 / 词条菜单 / 首页 chip 的字号与圆角落在 token 梯度上', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks,
    notes: [{ entryMainForm: 'alpha', body: 'alpha 是第一个值。', pinned: true }]
  })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })

  await page.evaluate((articleId) => {
    window.location.hash = `#/reading/${articleId}?from=home`
  }, article.id)
  await expect(page.locator('[data-reading-page="true"]')).toBeVisible()
  await page.locator('.reading-collected').first().click()
  const card = page.getByRole('complementary', { name: '词条' })
  await expect(card).toBeVisible()
  await expect(card.locator('.reading-panel-glance-label').first()).toHaveText('置顶学习内容')
  const glanceFont = await card
    .locator('.reading-panel-glance-label')
    .first()
    .evaluate((element) => getComputedStyle(element).fontSize)
  expect(glanceFont).toBe('12px')

  // 词条右栏维护菜单的圆角也是 8px 档。
  await page.locator('.reading-back').click()
  await expect(page.getByRole('navigation', { name: '全局导航' })).toBeVisible()
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '词条', exact: true })
    .click()
  await page.locator('.entries-row').first().click()
  await page.getByRole('button', { name: '展开学习内容' }).click()
  const rail = page.locator('.entries-rail-open')
  await rail.getByRole('button', { name: '词条维护' }).click()
  const menuItem = rail.getByRole('menuitem').first()
  await expect(menuItem).toBeVisible()
  expect(
    await menuItem.evaluate((element) => getComputedStyle(element).borderRadius)
  ).toBe('8px')

  // 首页已拾 chip 的 12.5px 不在梯度里，收口到 13px。
  await page
    .getByRole('navigation', { name: '全局导航' })
    .getByRole('button', { name: '首页', exact: true })
    .click()
  const chip = page.locator('.home-picked-chip').first()
  await expect(chip).toBeVisible()
  expect(await chip.evaluate((element) => getComputedStyle(element).fontSize)).toBe('13px')
})
