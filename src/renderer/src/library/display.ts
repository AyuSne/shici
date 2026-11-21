import type { LibraryArticle } from '../../../shared/library'
import { progressText } from './format'

/**
 * 语料把场次、套数与题型都塞进 `article.title`；首页与文章库都要把这串前缀拆开再显示。
 * 拆法只写这一处：首页拿拆出来的场次做 eyebrow、拿剩下的篇名做标题；文章库已按场次
 * 分组，列表行只在篇名确实没带套数/题型时才把它们补进 meta，避免同一行说两遍。
 * 用户改过的显示名原样保留，拆不出前缀时就整串当篇名。
 */

export type ArticleTitleParts = {
  /** 场次与套数，形如「2026年6月 · 第1套」；语料没有时为空串。 */
  sessionLine: string
  /** 去掉「场次 · 套数 · 题型」前缀后剩下的篇名。 */
  rest: string
  /** 剩下的篇名就是题型（语料没有单独的文章名）。 */
  titleIsKind: boolean
}

/** eyebrow 里的场次与套数；两者都可能为空。 */
export function articleSessionLine(article: LibraryArticle): string {
  return [article.sessionLabel, article.setLabel]
    .filter((part) => part.trim() !== '')
    .join(' · ')
}

export function articleTitleParts(article: LibraryArticle): ArticleTitleParts {
  const sessionLine = articleSessionLine(article)
  const title = article.title
  const afterSession =
    sessionLine !== '' && title.startsWith(`${sessionLine} · `)
      ? title.slice(sessionLine.length + ' · '.length)
      : title
  const afterKind =
    article.kindLabel !== '' && afterSession.startsWith(`${article.kindLabel} · `)
      ? afterSession.slice(article.kindLabel.length + ' · '.length)
      : afterSession

  return {
    sessionLine,
    rest: afterKind,
    titleIsKind: afterKind === '' || afterKind === article.kindLabel
  }
}

/**
 * 文章库一行的 meta：默认语料篇名已经把套数与题型写进标题，这里就不再重复；
 * 改过名的篇名不含这些信息，才补上套数与题型做区分。词数始终保留。
 * 搜索结果的篇名可能不在场次分组里，额外带上场次（篇名里没有时）。
 */
export function libraryArticleMetaParts(
  article: LibraryArticle,
  options: { includeSession?: boolean } = {}
): string[] {
  const parts = articleTitleParts(article)
  const meta: string[] = []
  if (options.includeSession === true && !article.title.includes(article.sessionLabel)) {
    meta.push(article.sessionLabel)
  }
  if (article.setLabel !== '' && !article.title.includes(article.setLabel)) {
    meta.push(article.setLabel)
  }
  if (article.kindLabel !== '' && !parts.titleIsKind) {
    meta.push(article.kindLabel)
  }
  meta.push(`${article.wordCount} 词`)
  return meta.filter((part) => part.trim() !== '')
}

/** 首页「继续阅读」的三行文字：场次进 eyebrow，篇名进标题，meta 不重复标题里的信息。 */
export type ContinueReadingDisplay = {
  eyebrow: string
  title: string
  meta: string
}

export function continueReadingDisplay(article: LibraryArticle): ContinueReadingDisplay {
  const parts = articleTitleParts(article)
  const eyebrow = parts.sessionLine || '继续阅读'
  const title = parts.titleIsKind
    ? article.kindLabel || parts.rest || article.title
    : parts.rest

  const meta: string[] = []
  if (!parts.titleIsKind && article.kindLabel !== '') {
    meta.push(article.kindLabel)
  }
  meta.push(`${article.wordCount} 词`)
  meta.push(progressText(article.progress))

  return { eyebrow, title, meta: meta.join(' · ') }
}

/** 套内省略默认篇名里的场次和套数，自定义篇名原样保留。 */
export function librarySetRowTitle(article: LibraryArticle): string {
  const defaultTitle = [article.sessionLabel, article.setLabel, article.kindLabel].join(' · ')
  return article.sourceType === 'exam' && article.title === defaultTitle
    ? article.kindLabel
    : article.title
}
