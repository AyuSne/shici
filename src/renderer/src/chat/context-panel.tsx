import { useEffect, useRef, useState } from 'react'
import { articleCoversParagraph } from '../../../shared/threads'
import type { ArticleContextMaterials, ThreadContextCandidates, ThreadContextItem, ThreadContextSummary } from '../../../shared/threads'
import { CONTEXT_KIND_LABEL, contextSummaryText } from './turns'
import { matchesContextSearch } from './context-picker'

/**
 * 输入框上方的学习上下文：这次的词、原句、段落与学习内容都摆在这里，
 * 每一项能单独移除；「添加上下文」展开这次还能加的材料，顶部写清条数与字数。
 */
export function ContextPanel({
  items,
  summary,
  candidates,
  pickerOpen,
  onTogglePicker,
  onAdd,
  onAddMany,
  loadArticle,
  onRemove
}: {
  items: readonly ThreadContextItem[]
  summary: ThreadContextSummary
  candidates: ThreadContextCandidates | null
  pickerOpen: boolean
  onTogglePicker: () => void
  onAdd: (item: ThreadContextItem) => void
  onAddMany: (items: ThreadContextItem[]) => void
  loadArticle: (id: string) => Promise<ArticleContextMaterials>
  onRemove: (id: string) => void
}) {
  const [section, setSection] = useState<'related' | 'articles' | 'words'>('related')
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [materials, setMaterials] = useState<Record<string, ArticleContextMaterials>>({})
  const [selected, setSelected] = useState<string[]>([])
  const included = new Set(items.map((item) => item.id))
  const pending = useRef(new Set<string>())
  useEffect(() => {
    if (!pickerOpen) { setQuery(''); setExpanded(null); setMaterials({}); setSelected([]) }
  }, [pickerOpen])
  useEffect(() => {
    if (!pickerOpen || section !== 'articles' || !candidates) return
    const ids = query.trim() ? candidates.articles.map((article) => article.id) : expanded ? [expanded] : []
    for (const id of ids) {
      if (!materials[id] && !pending.current.has(id)) {
        pending.current.add(id)
        void loadArticle(id).then((result) => setMaterials((previous) => ({ ...previous, [id]: result })))
          .catch(() => setMaterials((previous) => ({ ...previous, [id]: { article: null, paragraphs: [] } })))
          .finally(() => pending.current.delete(id))
      }
    }
  }, [pickerOpen, section, query, expanded, candidates, materials, loadArticle])
  const renderItems = (list: readonly ThreadContextItem[]) => (
    <ul className="context-candidates">
      {list.filter((item) => !included.has(item.id) && !items.some((full) => articleCoversParagraph(full, item)) && matchesContextSearch(item, query)).map((item) => (
        <li key={item.id}><button type="button" className="context-candidate"
          data-context-kind={item.kind} aria-label={`加入上下文：${item.label === '' ? item.text : item.label}`}
          onClick={() => onAdd(item)}>
          <span className="context-kind">{CONTEXT_KIND_LABEL[item.kind]}</span>
          <span className="context-candidate-text">{item.text}</span>
          {item.source && <span className="context-candidate-source">{item.source}</span>}
        </button></li>
      ))}
    </ul>
  )
  return (
    <section className="context-panel" aria-label="学习上下文">
      <div className="context-head">
        <span className="context-label">学习上下文</span>
        <span className="context-summary" data-testid="context-summary">
          {contextSummaryText(summary)}
        </span>
        <button
          type="button"
          className="chat-action context-add"
          aria-expanded={pickerOpen}
          onClick={onTogglePicker}
        >
          添加上下文
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
                <span className="context-chip-label" title={isSentence || item.source === '' ? item.text : item.source}>
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
          <input aria-label="搜索上下文" placeholder="搜索材料" value={query} onChange={(event) => setQuery(event.target.value)} />
          <div className="context-picker-tabs" role="tablist" aria-label="材料分类">
            {([['related', '当前相关'], ['articles', '文章与段落'], ['words', '词条与笔记']] as const).map(([key, label]) => (
              <button key={key} type="button" role="tab" aria-selected={section === key} onClick={() => setSection(key)}>{label}</button>
            ))}
          </div>
          {candidates === null ? <p className="empty-line">正在读取可加的材料…</p> : section === 'related' ? renderItems(candidates.items) : section === 'words' ? renderItems(candidates.libraryItems) : (
            <div className="context-article-list">
              {candidates.articles.filter((article) => {
                const data = materials[article.id]
                return !query.trim() || article.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) ||
                  data?.paragraphs.some((paragraph) => matchesContextSearch(paragraph, query))
              }).map((article) => {
                const data = materials[article.id]
                const titleMatches = !query.trim() || article.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
                const isOpen = expanded === article.id
                const fullIncluded = included.has(`article:${article.id}`)
                return <section key={article.id} className="context-article">
                  <button type="button" aria-expanded={isOpen} onClick={() => { setExpanded(isOpen ? null : article.id); setSelected([]) }}>{article.title}</button>
                  {isOpen && (data ? <div>
                    <button type="button" disabled={!data.article || fullIncluded} onClick={() => { if (data.article) onAdd(data.article) }}>加入全文</button>
                    {fullIncluded && <p>已加入全文</p>}
                    {data.paragraphs.filter((paragraph) => titleMatches || matchesContextSearch(paragraph, query)).map((paragraph) => <label key={paragraph.id} className="context-paragraph">
                      <input type="checkbox" disabled={fullIncluded || included.has(paragraph.id)} checked={selected.includes(paragraph.id)} onChange={(event) => setSelected((previous) => event.target.checked ? [...previous, paragraph.id] : previous.filter((id) => id !== paragraph.id))} />
                      <span>{paragraph.label} · {paragraph.text}</span>
                    </label>)}
                    <button type="button" disabled={selected.length === 0 || fullIncluded} onClick={() => { onAddMany(data.paragraphs.filter((paragraph) => selected.includes(paragraph.id))); setSelected([]) }}>加入所选段落</button>
                  </div> : <p>正在读取段落…</p>)}
                </section>
              })}
            </div>
          )}
          {summary.charCount > 50000 && <p className="empty-line">已选内容较多，发送时可能需要更长时间。</p>}
        </div>
      ) : null}
    </section>
  )
}
