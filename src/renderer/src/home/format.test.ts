import { describe, expect, it } from 'vitest'
import type { HomeSummary, LibraryArticle } from '../../../shared/library'
import {
  continueReadingDisplay,
  finishedReadingDisplay,
  homeEntryMeta,
  homeReadingState
} from './format'

/**
 * 首页继续阅读的三行文字：场次在 eyebrow、篇名在标题、meta 只留题型、词数与进度。
 * 语料把场次、套数、题型都塞进了 article.title，显示时要拆开；重命名后的篇名不能被改坏。
 */

function article(overrides: Partial<LibraryArticle> = {}): LibraryArticle {
  return {
    id: 'fixture-2026-06-s1-c1',
    title: '2026年6月 · 第1套 · 仔细阅读 Passage One',
    kind: 'careful_reading',
    sourceType: 'exam',
    kindLabel: '仔细阅读 Passage One',
    sessionLabel: '2026年6月',
    setLabel: '第1套',
    wordCount: 19,
    progress: { state: 'reading', percent: 50 },
    lastOpenedAt: '2026-11-18T09:00:00.000Z',
    ...overrides
  }
}

describe('continueReadingDisplay', () => {
  it('场次与套数放 eyebrow，标题不重复题型，meta 只留词数与进度', () => {
    const display = continueReadingDisplay(article())

    expect(display).toEqual({
      eyebrow: '2026年6月 · 第1套',
      title: '仔细阅读 Passage One',
      meta: '19 词 · 读到 50%'
    })
    expect(display.title).not.toBe(article().title)
    expect(display.meta).not.toContain('2026年6月')
    expect(display.meta).not.toContain('第1套')
    expect(display.meta).not.toContain('仔细阅读 Passage One')
  })

  it('重命名后的篇名原样显示，题型留在 meta 里且只出现一次', () => {
    const display = continueReadingDisplay(article({ title: 'Sarcasm and Jazz' }))

    expect(display).toEqual({
      eyebrow: '2026年6月 · 第1套',
      title: 'Sarcasm and Jazz',
      meta: '仔细阅读 Passage One · 19 词 · 读到 50%'
    })
    expect(display.meta.split('仔细阅读 Passage One')).toHaveLength(2)
  })

  it('篇名接在题型后面时只显示篇名，meta 仍保留题型', () => {
    const display = continueReadingDisplay(
      article({ title: '2026年6月 · 第1套 · 仔细阅读 Passage One · Sarcasm and Jazz' })
    )

    expect(display.title).toBe('Sarcasm and Jazz')
    expect(display.meta).toBe('仔细阅读 Passage One · 19 词 · 读到 50%')
  })

  it('重命名时保留了场次前缀也能拆出篇名', () => {
    const display = continueReadingDisplay(
      article({ title: '2026年6月 · 第1套 · 我的精读笔记' })
    )

    expect(display).toEqual({
      eyebrow: '2026年6月 · 第1套',
      title: '我的精读笔记',
      meta: '仔细阅读 Passage One · 19 词 · 读到 50%'
    })
  })

  it('未读的篇目在 meta 里写「未读」', () => {
    const display = continueReadingDisplay(article({ progress: { state: 'unread', percent: 0 } }))

    expect(display.meta).toBe('19 词 · 未读')
  })
})

describe('homeEntryMeta', () => {
  it('一个 chip 只写原句数与来源文章数', () => {
    expect(
      homeEntryMeta({ id: 'entry-1', mainForm: 'approach', sentenceCount: 3, articleCount: 2, lastCollectedAt: '' })
    ).toBe('3 句 · 2 篇')
  })
})

describe('homeReadingState', () => {
  function summary(overrides: Partial<HomeSummary> = {}): HomeSummary {
    return {
      library: { articleCount: 63, sessionCount: 7 },
      continueReading: null,
      completedArticleCount: 0,
      recentEntries: [],
      laterEntries: [],
      ...overrides
    }
  }

  it('还没打开过任何一篇是首启空态', () => {
    expect(homeReadingState(summary())).toBe('first-start')
    expect(homeReadingState(null)).toBe('first-start')
  })

  it('有未读完的一篇时继续阅读', () => {
    expect(
      homeReadingState(
        summary({
          continueReading: {
            article: article(),
            lastReadPoint: null,
            articleEntries: []
          }
        })
      )
    ).toBe('continue')
  })

  it('没有未读完的但读过并完成过，是「读完了」而不是首启', () => {
    expect(homeReadingState(summary({ completedArticleCount: 1 }))).toBe('finished')
    expect(homeReadingState(summary({ completedArticleCount: 63 }))).toBe('finished')
  })
})

describe('finishedReadingDisplay', () => {
  it('只说明真正读完的篇数，不拿文章库总数冒充已读', () => {
    const display = finishedReadingDisplay(2)

    expect(display.eyebrow).toBe('已读完 2 篇')
    expect(display.title).toBe('没有读到一半的文章了')
    expect(display.lede).toContain('重读')
    expect(display.lede).not.toContain('63')
  })
})
