import { articleCoversParagraph, type ArticleContextMaterials, type ThreadContextItem } from '../../../shared/threads'

export type ContextPickerSection = 'related' | 'articles' | 'words'

export function matchesContextSearch(item: { label: string; text: string; source: string }, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  return needle === '' || [item.label, item.text, item.source].some((value) => value.toLocaleLowerCase().includes(needle))
}

/** 从候选材料中过滤出尚未加入、未被同篇全文覆盖且匹配搜索词的项目。 */
export function filterAddableContextItems(
  candidates: readonly ThreadContextItem[],
  currentItems: readonly ThreadContextItem[],
  query: string
): ThreadContextItem[] {
  const included = new Set(currentItems.map((item) => item.id))
  return candidates.filter(
    (item) =>
      !included.has(item.id) &&
      !currentItems.some((full) => articleCoversParagraph(full, item)) &&
      matchesContextSearch(item, query)
  )
}

/** 判断文章标题本身是否匹配当前搜索词。 */
export function articleTitleMatches(title: string, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()
  return needle === '' || title.toLocaleLowerCase().includes(needle)
}

/** 按篇名或已加载段落正文过滤文章候选列表。 */
export function filterContextArticles<T extends { id: string; title: string }>(
  articles: readonly T[],
  materials: Readonly<Record<string, ArticleContextMaterials>>,
  query: string
): T[] {
  if (query.trim() === '') {
    return [...articles]
  }
  return articles.filter((article) => {
    if (articleTitleMatches(article.title, query)) {
      return true
    }
    return (
      materials[article.id]?.paragraphs.some((paragraph) =>
        matchesContextSearch(paragraph, query)
      ) ?? false
    )
  })
}

export function contextPickerEmptyText(section: ContextPickerSection, query: string): string {
  if (query.trim() !== '') {
    return '没有找到匹配的材料'
  }
  if (section === 'related') {
    return '当前相关的材料都已加入'
  }
  if (section === 'articles') {
    return '文章库还没有文章'
  }
  return '词条与学习内容都已加入'
}
