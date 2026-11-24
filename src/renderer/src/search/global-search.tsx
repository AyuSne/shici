import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode
} from 'react'
import type {
  GlobalArticleResult,
  GlobalEntryResult,
  SearchShortcuts
} from '../../../shared/global-search'
import type { LibraryArticle } from '../../../shared/library'
import type { HomeEntryChip } from '../../../shared/library'
import { loadSearchShortcuts, searchEverything } from '../api'
import { focusablesIn, trapTabTarget } from '../components/focus-trap'
import { ENTRY_SEARCH_MATCH_LABELS } from '../entries/format'
import { failureText } from '../errors'
import { navigate } from '../navigate'
import { NAV_ITEMS } from '../navigation'
import { clearSearchSession, currentLocationHash, rememberSearchSession } from './session'
import { SearchSnippetText } from './snippet-text'
import { INITIAL_SEARCH_MACHINE, searchReducer } from './state'

const LOADING_TEXT = '正在搜索…'
const ERROR_FALLBACK = '搜索没有完成，再试一次。'
const IDLE_TEXT = '输入关键词，同时搜词条名、原句、学习内容与文章正文。'

/**
 * 全局搜索覆盖层。它只挂在当前页面上方，不改变地址、不重挂载底页：
 * 关闭（Esc / 点外部）只是收起自己，底页的对象、草稿、筛选与滚动都不动。
 * 只有点结果时才真正导航，并把这次搜索的查询与来源记下来，供阅读页返回「搜索结果」。
 */
export function GlobalSearch({
  initialQuery,
  onClose,
  onChooseResult
}: {
  initialQuery: string
  onClose: () => void
  /** 点结果是一次显式目标定位；同 hash 时也靠它让底页重新执行 focus。 */
  onChooseResult: () => void
}) {
  const [machine, dispatch] = useReducer(searchReducer, INITIAL_SEARCH_MACHINE, (base) =>
    initialQuery.trim() === ''
      ? base
      : searchReducer(base, { type: 'query-changed', query: initialQuery })
  )
  const [input, setInput] = useState(initialQuery)
  const [shortcuts, setShortcuts] = useState<SearchShortcuts | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const restoreFocus = useRef<HTMLElement | null>(null)

  // 打开就把焦点放进输入框；关闭时还给打开它的按钮，且不把底页滚回顶部。
  useLayoutEffect(() => {
    restoreFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    inputRef.current?.focus({ preventScroll: true })
    return () => {
      const target = restoreFocus.current
      restoreFocus.current = null
      if (target !== null && target.isConnected) target.focus({ preventScroll: true })
    }
  }, [])

  // Esc 在捕获阶段只关搜索：preventDefault + stopPropagation，不让阅读页退出、
  // 对话停止生成或取消编辑；输入法组合态里的 Esc 交给输入法。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.isComposing) return
      event.preventDefault()
      event.stopPropagation()
      dispatch({ type: 'closed' })
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose])

  // 空态的最近文章 / 最近词条只读一次：打开搜索时若还没输入，就摆出来。
  useEffect(() => {
    let active = true
    loadSearchShortcuts().then(
      (value) => {
        if (active) setShortcuts(value)
      },
      () => {
        // 读不到最近项时仍能正常输入搜索，不把覆盖层卡在错误态。
        if (active) setShortcuts(null)
      }
    )
    return () => {
      active = false
    }
  }, [])

  // 查询进入加载态才发请求；快速改词、清空或关闭后，旧回复靠代次丢弃。
  useEffect(() => {
    const state = machine.state
    if (state.status !== 'loading') return
    let active = true
    const requestId = machine.requestId
    searchEverything(state.query).then(
      (results) => {
        if (active) dispatch({ type: 'loaded', requestId, query: state.query, results })
      },
      (error: unknown) => {
        if (active) {
          dispatch({
            type: 'failed',
            requestId,
            query: state.query,
            message: failureText(error, ERROR_FALLBACK)
          })
        }
      }
    )
    return () => {
      active = false
    }
  }, [machine.state, machine.requestId])

  const state = machine.state

  function chooseEntry(result: GlobalEntryResult): void {
    rememberSearchSession({ query: state.query, originHash: currentLocationHash() })
    onChooseResult()
    onClose()
    const hit = result.hit
    if (hit.match === 'sentence') {
      navigate('entries', { entryId: hit.entryId, entrySentenceId: hit.entrySentenceId })
      return
    }
    if (hit.match === 'learning-note') {
      navigate('entries', { entryId: hit.entryId, noteId: hit.noteId })
      return
    }
    navigate('entries', { entryId: hit.entryId })
  }

  function chooseArticle(result: GlobalArticleResult): void {
    rememberSearchSession({ query: state.query, originHash: currentLocationHash() })
    onChooseResult()
    onClose()
    navigate('reading', {
      articleId: result.article.id,
      readingFrom: 'search',
      ...(result.paragraphId === null
        ? {}
        : {
            searchParagraphId: result.paragraphId,
            searchSentenceOrdinal: result.sentenceOrdinal
          }),
      ...(result.match === 'body' ? { searchQuery: state.query } : {})
    })
  }

  /** 空态最近文章：直接进阅读；返回时重新打开空的搜索面板，而不是旧查询。 */
  function chooseRecentArticle(article: LibraryArticle): void {
    clearSearchSession()
    onChooseResult()
    onClose()
    navigate('reading', { articleId: article.id, readingFrom: 'search' })
  }

  function chooseRecentEntry(entry: HomeEntryChip): void {
    onChooseResult()
    onClose()
    navigate('entries', { entryId: entry.id })
  }

  function choosePage(route: (typeof NAV_ITEMS)[number]['route']): void {
    onChooseResult()
    onClose()
    navigate(route)
  }

  /** Tab 只在覆盖层里循环；第一下 Tab 不会跑到下面的页面。 */
  function handlePanelKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Tab') return
    const panel = panelRef.current
    if (panel === null) return
    const active = document.activeElement
    const target = trapTabTarget(
      focusablesIn(panel),
      active,
      event.shiftKey,
      panel.contains(active)
    )
    if (target === null) return
    event.preventDefault()
    target.focus()
  }

  return (
    <div
      className="global-search"
      role="presentation"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="global-search-backdrop" aria-hidden="true" onClick={onClose} />
      <section
        ref={panelRef}
        className="global-search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
        onKeyDown={handlePanelKeyDown}
      >
        <header className="global-search-head">
          <input
            ref={inputRef}
            type="search"
            className="global-search-input"
            aria-label="搜索词条与文章"
            placeholder="搜词条名、原句、学习内容或文章正文"
            value={input}
            onChange={(event) => {
              setInput(event.target.value)
              dispatch({ type: 'query-changed', query: event.target.value })
            }}
          />
          <button
            type="button"
            className="global-search-close"
            aria-label="关闭搜索"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="global-search-body">
          {state.status === 'idle' ? (
            <>
              <p className="global-search-hint">{IDLE_TEXT}</p>
              {shortcuts === null ? null : (
                <div className="global-search-shortcuts">
                  {shortcuts.recentArticles.length === 0 ? null : (
                    <section className="global-search-shortcut-group" aria-label="最近打开的文章">
                      <h2 className="global-search-group-title">最近打开的文章</h2>
                      <ul className="global-search-shortcut-list">
                        {shortcuts.recentArticles.map((article) => (
                          <li key={article.id}>
                            <button
                              type="button"
                              className="global-search-shortcut"
                              data-shortcut="article"
                              onClick={() => chooseRecentArticle(article)}
                            >
                              <span className="global-search-shortcut-title">
                                {article.title}
                              </span>
                              <span className="global-search-shortcut-meta">
                                {article.sourceType === 'ai'
                                  ? 'AI 生成'
                                  : `${article.sessionLabel} · ${article.kindLabel}`}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  {shortcuts.recentEntries.length === 0 ? null : (
                    <section className="global-search-shortcut-group" aria-label="最近收集的词条">
                      <h2 className="global-search-group-title">最近收集的词条</h2>
                      <ul className="global-search-shortcut-list">
                        {shortcuts.recentEntries.map((entry) => (
                          <li key={entry.id}>
                            <button
                              type="button"
                              className="global-search-shortcut"
                              data-shortcut="entry"
                              onClick={() => chooseRecentEntry(entry)}
                            >
                              <span className="global-search-shortcut-title">
                                {entry.mainForm}
                              </span>
                              <span className="global-search-shortcut-meta">
                                {entry.sentenceCount} 句 · {entry.articleCount} 篇
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  <section className="global-search-shortcut-group" aria-label="常用跳转">
                    <h2 className="global-search-group-title">常用跳转</h2>
                    <div className="global-search-shortcut-pages">
                      {NAV_ITEMS.map((item) => (
                        <button
                          key={item.route}
                          type="button"
                          className="global-search-shortcut-page"
                          data-shortcut="page"
                          onClick={() => choosePage(item.route)}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </>
          ) : null}
          {state.status === 'loading' ? (
            <p className="global-search-status" role="status">
              {LOADING_TEXT}
            </p>
          ) : null}
          {state.status === 'error' ? (
            <div className="global-search-error" role="alert">
              <p>{state.message}</p>
              <button
                type="button"
                className="button"
                onClick={() => dispatch({ type: 'retry' })}
              >
                重试
              </button>
            </div>
          ) : null}
          {state.status === 'empty' ? (
            <p className="global-search-empty">没有搜到「{state.query}」。换个词试试。</p>
          ) : null}
          {state.status === 'results' ? (
            <>
              <ResultGroup
                title="词条"
                count={state.results.entries.length}
                emptyText="没有命中的词条。"
              >
                <ul className="global-search-list">
                  {state.results.entries.map((result) => (
                    <li key={result.entryId}>
                      <button
                        type="button"
                        className="global-search-entry"
                        data-match={result.hit.match}
                        onClick={() => chooseEntry(result)}
                      >
                        <span className="global-search-hit-head">
                          <span className="global-search-hit-title">{result.mainForm}</span>
                          <span className="global-search-hit-kind">
                            {ENTRY_SEARCH_MATCH_LABELS[result.hit.match]}
                          </span>
                        </span>
                        <span className="global-search-snippet">
                          <SearchSnippetText snippet={result.hit.snippet} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </ResultGroup>

              <ResultGroup
                title="文章"
                count={state.results.articles.length}
                emptyText="没有命中的文章。"
              >
                <ul className="global-search-list">
                  {state.results.articles.map((result) => (
                    <li key={result.article.id}>
                      <button
                        type="button"
                        className="global-search-article"
                        data-match={result.match}
                        data-source={result.article.sourceType}
                        onClick={() => chooseArticle(result)}
                      >
                        <span className="global-search-hit-head">
                          <span className="global-search-hit-title">
                            {result.article.title}
                          </span>
                          <span className="global-search-hit-kind">
                            {result.match === 'title' ? '篇名' : '正文'}
                          </span>
                        </span>
                        <span className="global-search-article-meta">
                          {result.article.sourceType === 'ai'
                            ? 'AI 生成'
                            : `${result.article.sessionLabel} · ${result.article.kindLabel}`}
                        </span>
                        <span className="global-search-snippet">
                          <SearchSnippetText snippet={result.snippet} />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </ResultGroup>
            </>
          ) : null}
        </div>
      </section>
    </div>
  )
}

/** 结果的一组：标题带计数，空组也给一句明确的话，不整组消失。 */
function ResultGroup({
  title,
  count,
  emptyText,
  children
}: {
  title: string
  count: number
  emptyText: string
  children: ReactNode
}) {
  return (
    <section className="global-search-group" aria-label={title}>
      <h2 className="global-search-group-title">
        {title}
        <span className="global-search-group-count">{count}</span>
      </h2>
      {count === 0 ? <p className="global-search-group-empty">{emptyText}</p> : children}
    </section>
  )
}
