import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ArticleContextMaterials,
  ThreadContextCandidates,
  ThreadContextItem,
  ThreadContextSummary
} from '../../../shared/threads'
import { Icon } from '../components/icons'
import {
  articleTitleMatches,
  contextPickerEmptyText,
  filterAddableContextItems,
  filterContextArticles,
  matchesContextSearch,
  type ContextPickerSection
} from './context-picker'
import { CONTEXT_KIND_LABEL, contextSummaryText } from './turns'

/**
 * 输入框上方的学习上下文：已选材料以轻量胶囊条摆在这里，每项可单独移除；
 * 点「添加上下文」向上浮出材料选择器，不挤压底部输入区和上方对话视野，
 * 支持搜索、分类切换、快速加全文以及点击外部 / 按 Esc / 点「收起 / 完成」关闭。
 */
export function ContextPanel({
  threadKey = null,
  items,
  summary,
  candidates,
  pickerOpen,
  onTogglePicker,
  onClosePicker,
  onAdd,
  onAddMany,
  loadArticle,
  onRemove
}: {
  threadKey?: string | null
  items: readonly ThreadContextItem[]
  summary: ThreadContextSummary
  candidates: ThreadContextCandidates | null
  pickerOpen: boolean
  onTogglePicker: () => void
  onClosePicker: () => void
  onAdd: (item: ThreadContextItem) => void
  onAddMany: (items: ThreadContextItem[]) => void
  loadArticle: (id: string) => Promise<ArticleContextMaterials>
  onRemove: (id: string) => void
}) {
  const [section, setSection] = useState<ContextPickerSection>('related')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [materials, setMaterials] = useState<Record<string, ArticleContextMaterials>>({})
  const [selected, setSelected] = useState<string[]>([])
  const [addingArticleId, setAddingArticleId] = useState<string | null>(null)
  const panelRef = useRef<HTMLElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const pickerSessionRef = useRef(0)
  const prevOpenRef = useRef(pickerOpen)
  const prevThreadRef = useRef(threadKey)
  const closedOutsideRef = useRef(false)
  const included = new Set(items.map((item) => item.id))
  const pending = useRef(new Map<string, Promise<ArticleContextMaterials>>())

  useEffect(() => {
    const threadChanged = prevThreadRef.current !== threadKey
    prevThreadRef.current = threadKey
    if (threadChanged) {
      pickerSessionRef.current += 1
      pending.current.clear()
      setAddingArticleId(null)
    }

    const wasOpen = prevOpenRef.current
    prevOpenRef.current = pickerOpen
    if (!pickerOpen) {
      pickerSessionRef.current += 1
      pending.current.clear()
      setQuery('')
      setExpanded(null)
      setMaterials({})
      setSelected([])
      setAddingArticleId(null)
      if (wasOpen && !threadChanged && !closedOutsideRef.current) {
        window.requestAnimationFrame(() => toggleRef.current?.focus())
      }
      closedOutsideRef.current = false
      return
    }

    closedOutsideRef.current = false
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [pickerOpen, threadKey])

  useEffect(() => {
    if (!pickerOpen) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Node ? event.target : null
      if (target !== null && panelRef.current?.contains(target)) {
        return
      }
      closedOutsideRef.current = true
      onClosePicker()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [pickerOpen, onClosePicker])

  const ensureArticleLoaded = useCallback(
    async (articleId: string): Promise<ArticleContextMaterials | null> => {
      const cached = materials[articleId]
      if (cached) return cached
      const session = pickerSessionRef.current
      let request = pending.current.get(articleId)
      if (!request) {
        request = loadArticle(articleId)
          .then((result) => {
            if (pickerSessionRef.current === session) {
              setMaterials((previous) => ({ ...previous, [articleId]: result }))
            }
            return result
          })
          .catch(() => {
            const empty: ArticleContextMaterials = { article: null, paragraphs: [] }
            if (pickerSessionRef.current === session) {
              setMaterials((previous) => ({ ...previous, [articleId]: empty }))
            }
            return empty
          })
          .finally(() => {
            if (pickerSessionRef.current === session) {
              pending.current.delete(articleId)
            }
          })
        pending.current.set(articleId, request)
      }
      const result = await request
      return pickerSessionRef.current === session ? result : null
    },
    [loadArticle, materials]
  )

  useEffect(() => {
    if (!pickerOpen || section !== 'articles' || !candidates) return
    const ids = query.trim()
      ? candidates.articles.map((article) => article.id)
      : expanded
        ? [expanded]
        : []
    for (const id of ids) {
      if (!materials[id] && !pending.current.has(id)) {
        void ensureArticleLoaded(id)
      }
    }
  }, [pickerOpen, section, query, expanded, candidates, materials, ensureArticleLoaded])

  async function addFullArticle(articleId: string): Promise<void> {
    if (included.has(`article:${articleId}`) || addingArticleId === articleId) return
    const session = pickerSessionRef.current
    setAddingArticleId(articleId)
    try {
      const result = await ensureArticleLoaded(articleId)
      if (result?.article && pickerSessionRef.current === session) {
        onAdd(result.article)
        if (expanded === articleId) setSelected([])
      }
    } finally {
      if (pickerSessionRef.current === session) {
        setAddingArticleId((current) => (current === articleId ? null : current))
      }
    }
  }

  const renderItems = (list: readonly ThreadContextItem[], currentSection: ContextPickerSection) => {
    const filtered = filterAddableContextItems(list, items, query)
    if (filtered.length === 0) {
      return <p className="context-picker-empty">{contextPickerEmptyText(currentSection, query)}</p>
    }
    return (
      <ul className="context-candidates">
        {filtered.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className="context-candidate"
              data-context-kind={item.kind}
              aria-label={`加入上下文：${item.label === '' ? item.text : item.label}`}
              onClick={() => onAdd(item)}
            >
              <span className="context-kind-pill">{CONTEXT_KIND_LABEL[item.kind]}</span>
              <span className="context-candidate-text">{item.text}</span>
              {item.source ? <span className="context-candidate-source">{item.source}</span> : null}
              <span className="context-candidate-add" aria-hidden="true">
                + 加入
              </span>
            </button>
          </li>
        ))}
      </ul>
    )
  }

  const filteredArticles =
    candidates === null ? [] : filterContextArticles(candidates.articles, materials, query)

  return (
    <section ref={panelRef} className="context-panel" aria-label="学习上下文">
      <div className="context-head">
        <span className="context-label">学习上下文</span>
        <span className="context-summary" data-testid="context-summary">
          {contextSummaryText(summary)}
        </span>
        <button
          ref={toggleRef}
          type="button"
          className="chat-action context-add"
          aria-expanded={pickerOpen}
          aria-label={pickerOpen ? '收起上下文' : '添加上下文'}
          onClick={onTogglePicker}
        >
          {pickerOpen ? '收起' : '+ 添加上下文'}
        </button>
      </div>

      {items.length === 0 ? (
        <p className="context-empty">还没有带上上下文</p>
      ) : (
        <ul className="context-chips">
          {items.map((item) => {
            const isSentence = item.kind === 'sentence'
            const label = isSentence || item.label === '' ? item.text : item.label
            return (
              <li key={item.id} className="context-chip" data-context-id={item.id}>
                <span className="context-kind">{CONTEXT_KIND_LABEL[item.kind]}</span>
                <span
                  className="context-chip-label"
                  title={isSentence || item.source === '' ? item.text : item.source}
                >
                  {label}
                </span>
                <button
                  type="button"
                  className="context-remove"
                  aria-label={`移除上下文：${label}`}
                  onClick={() => onRemove(item.id)}
                >
                  ×
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {pickerOpen ? (
        <div className="context-picker" role="group" aria-label="可加入的上下文">
          <div className="context-picker-bar">
            <div className="context-picker-search-wrap">
              <Icon name="search" size={14} className="context-picker-search-icon" />
              <input
                ref={searchRef}
                type="text"
                className="context-picker-search"
                aria-label="搜索上下文"
                placeholder="搜索文章、段落、词条或学习内容…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query === '' ? null : (
                <button
                  type="button"
                  className="context-picker-clear"
                  aria-label="清空搜索"
                  onClick={() => {
                    setQuery('')
                    searchRef.current?.focus()
                  }}
                >
                  <Icon name="close" size={12} />
                </button>
              )}
            </div>
            <button
              type="button"
              className="context-picker-done"
              onClick={onClosePicker}
            >
              完成
            </button>
          </div>

          <div className="context-picker-tabs" role="tablist" aria-label="材料分类">
            {([
              ['related', '当前相关'],
              ['articles', '文章与段落'],
              ['words', '词条与笔记']
            ] as const).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                className="context-picker-tab"
                aria-selected={section === key}
                onClick={() => setSection(key)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="context-picker-body">
            {candidates === null ? (
              <p className="context-picker-empty">正在读取可加的材料…</p>
            ) : section === 'related' ? (
              renderItems(candidates.items, 'related')
            ) : section === 'words' ? (
              renderItems(candidates.libraryItems, 'words')
            ) : filteredArticles.length === 0 ? (
              <p className="context-picker-empty">{contextPickerEmptyText('articles', query)}</p>
            ) : (
              <div className="context-article-list">
                {filteredArticles.map((article) => {
                  const data = materials[article.id]
                  const titleMatches = articleTitleMatches(article.title, query)
                  const isOpen = expanded === article.id
                  const fullIncluded = included.has(`article:${article.id}`)
                  const addingThis = addingArticleId === article.id
                  return (
                    <section key={article.id} className="context-article">
                      <div className="context-article-row">
                        <button
                          type="button"
                          className="context-article-toggle"
                          aria-expanded={isOpen}
                          onClick={() => {
                            setExpanded(isOpen ? null : article.id)
                            setSelected([])
                          }}
                        >
                          <span className="context-article-chevron" aria-hidden="true">
                            ▸
                          </span>
                          <span className="context-article-title">{article.title}</span>
                        </button>
                        <button
                          type="button"
                          className={
                            fullIncluded
                              ? 'context-article-quick is-added'
                              : 'context-article-quick'
                          }
                          disabled={fullIncluded || addingThis}
                          onClick={() => void addFullArticle(article.id)}
                        >
                          {fullIncluded ? '已加全文' : addingThis ? '加入中…' : '+ 全文'}
                        </button>
                      </div>
                      {isOpen ? (
                        data ? (
                          <div className="context-article-body">
                            {data.paragraphs
                              .filter(
                                (paragraph) =>
                                  titleMatches || matchesContextSearch(paragraph, query)
                              )
                              .map((paragraph) => {
                                const paragraphIncluded =
                                  fullIncluded || included.has(paragraph.id)
                                return (
                                  <label
                                    key={paragraph.id}
                                    className="context-paragraph"
                                    data-included={paragraphIncluded ? 'true' : undefined}
                                  >
                                    <input
                                      type="checkbox"
                                      className="context-paragraph-check"
                                      disabled={paragraphIncluded}
                                      checked={
                                        paragraphIncluded || selected.includes(paragraph.id)
                                      }
                                      onChange={(event) =>
                                        setSelected((previous) =>
                                          event.target.checked
                                            ? [...previous, paragraph.id]
                                            : previous.filter((id) => id !== paragraph.id)
                                        )
                                      }
                                    />
                                    <span className="context-paragraph-text">
                                      <strong className="context-paragraph-label">
                                        {paragraph.label}
                                      </strong>{' '}
                                      {paragraph.text}
                                    </span>
                                  </label>
                                )
                              })}
                            <div className="context-article-actions">
                              <button
                                type="button"
                                className="button button-small"
                                disabled={!data.article || fullIncluded}
                                onClick={() => {
                                  if (data.article) {
                                    onAdd(data.article)
                                    setSelected([])
                                  }
                                }}
                              >
                                {fullIncluded ? '已加入全文' : '加入全文'}
                              </button>
                              <button
                                type="button"
                                className="button button-small"
                                disabled={selected.length === 0 || fullIncluded}
                                onClick={() => {
                                  onAddMany(
                                    data.paragraphs.filter((paragraph) =>
                                      selected.includes(paragraph.id)
                                    )
                                  )
                                  setSelected([])
                                }}
                              >
                                {selected.length > 0
                                  ? `加入所选段落 (${selected.length})`
                                  : '加入所选段落'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <p className="context-picker-empty">正在读取段落…</p>
                        )
                      ) : null}
                    </section>
                  )
                })}
              </div>
            )}
          </div>
          {summary.charCount > 50000 ? (
            <p className="context-picker-warn">已选内容较多，发送时可能需要更长时间。</p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
