import { describe, expect, it } from 'vitest'
import type { ThreadContextItem } from '../../../shared/threads'
import {
  articleTitleMatches,
  contextPickerEmptyText,
  filterAddableContextItems,
  filterContextArticles,
  matchesContextSearch
} from './context-picker'

describe('上下文材料搜索', () => {
  it('忽略大小写，匹配标题、正文或出处', () => {
    const item = { label: 'Approach', text: 'A quiet counter', source: 'Reading one' }
    expect(matchesContextSearch(item, 'COUNTER')).toBe(true)
    expect(matchesContextSearch(item, 'reading')).toBe(true)
    expect(matchesContextSearch(item, 'missing')).toBe(false)
  })
})

describe('filterAddableContextItems', () => {
  const fullArticle: ThreadContextItem = {
    id: 'article:a1',
    kind: 'article',
    label: 'Article 1',
    text: 'Full article text',
    source: '2026年6月'
  }
  const coveredParagraph: ThreadContextItem = {
    id: 'paragraph:a1:1',
    kind: 'paragraph',
    label: '第 1 段',
    text: 'First paragraph',
    source: 'Article 1'
  }
  const wordItem: ThreadContextItem = {
    id: 'word:w1',
    kind: 'word',
    label: 'approach',
    text: 'approach',
    source: ''
  }

  it('排除已加入的材料和已被同篇全文覆盖的段落，并按搜索词过滤', () => {
    const candidates = [fullArticle, coveredParagraph, wordItem]
    expect(filterAddableContextItems(candidates, [fullArticle], '')).toEqual([wordItem])
    expect(filterAddableContextItems(candidates, [], 'app')).toEqual([wordItem])
  })
})

describe('filterContextArticles', () => {
  const articles = [
    { id: 'a1', title: '2026年6月 · 第1套 · 仔细阅读 Passage One' },
    { id: 'a2', title: '2026年6月 · 第2套 · 长篇匹配' }
  ]
  const materials = {
    a1: {
      article: null,
      paragraphs: [
        {
          id: 'paragraph:a1:1',
          kind: 'paragraph' as const,
          label: '第 1 段',
          text: 'Quiet counter service',
          source: 'Article 1'
        }
      ]
    }
  }

  it('同时支持按篇名和已加载段落正文搜索文章', () => {
    expect(filterContextArticles(articles, materials, '第2套')).toEqual([articles[1]])
    expect(filterContextArticles(articles, materials, 'counter')).toEqual([articles[0]])
    expect(articleTitleMatches('2026年6月 · 第2套', '第2套')).toBe(true)
    expect(articleTitleMatches('2026年6月 · 第2套', '第1套')).toBe(false)
  })
})

describe('contextPickerEmptyText', () => {
  it('区分搜索无果和各分类已全部加入时的空态说明', () => {
    expect(contextPickerEmptyText('related', 'xyz')).toBe('没有找到匹配的材料')
    expect(contextPickerEmptyText('related', '')).toBe('当前相关的材料都已加入')
    expect(contextPickerEmptyText('articles', '')).toBe('文章库还没有文章')
    expect(contextPickerEmptyText('words', '')).toBe('词条与学习内容都已加入')
  })
})
