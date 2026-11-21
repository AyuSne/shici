import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type {
  ArticleDetail,
  ImportReport,
  LibraryArticle,
  LibraryListing,
  LibrarySearchResults
} from '../../../shared/library'
import {
  loadArticleDetail,
  loadLibrary,
  reimportCorpus,
  searchLibrary
} from '../api'
import { failureText } from '../errors'
import { ErrorBlock } from '../components/error-block'
import { getChatStore, openThreadForMain } from '../chat/store'
import { LibraryArticleActions } from '../library/article-actions'
import { ArticleCollectedSection } from '../library/article-collected'
import { libraryArticleMetaParts, librarySetRowTitle } from '../library/display'
import { formatDay, progressText } from '../library/format'
import { forgetLibraryArticle, navigate, replaceRoute } from '../navigate'
import { parseView } from '../routes'
import { libraryViewState, updateLibraryViewState } from '../view-state'

/**
 * 文章库：左边按场次分组的列表（搜索时换成命中结果），右边是选中一篇的详情。
 * 「继续阅读」把文章 id 交给阅读页，由阅读页记下最近打开并恢复上次位置。
 */
export function LibraryPage({
  articleId,
  corpusImport,
  onReimport
}: {
  articleId: string | null
  corpusImport: ImportReport
  onReimport: (report: ImportReport) => void
}) {
  const [listing, setListing] = useState<LibraryListing | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [query, setQuery] = useState(() => libraryViewState().query)
  const [expansion, setExpansion] = useState(() => libraryViewState())
  const [found, setFound] = useState<LibrarySearchResults | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(articleId)
  const [detail, setDetail] = useState<ArticleDetail | null>(null)
  const [reimporting, setReimporting] = useState(false)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const restoredScroll = useRef(false)

  useLayoutEffect(() => {
    const node = rootRef.current?.closest('main')
    if (!node) return
    const remember = (): void => {
      if (restoredScroll.current) updateLibraryViewState({ scrollTop: node.scrollTop })
    }
    node.addEventListener('scroll', remember)
    return () => {
      remember()
      node.removeEventListener('scroll', remember)
    }
  }, [])

  useLayoutEffect(() => {
    if (restoredScroll.current || listing === null) return
    if (query.trim() !== '' && found?.query !== query.trim()) return
    const node = rootRef.current?.closest('main')
    if (!node) return
    node.scrollTop = libraryViewState().scrollTop
    restoredScroll.current = true
  }, [found, listing, query])

  useEffect(() => {
    let active = true
    setLoadError(null)
    loadLibrary().then(
      (value) => {
        if (!active) return
        setListing(value)
        // 只有 AI 文章时也要有默认选中：先取真题第一行，没有就取生成文章第一篇。
        const firstId = value.sessions[0]?.sets[0]?.articles[0]?.id ?? value.aiArticles[0]?.id ?? null
        const current = parseView(window.location.hash)
        const routeId = current.route === 'library' ? current.articleId : null
        const routeStillExists =
          routeId !== null &&
          (value.sessions.some((session) =>
            session.sets.some((set) => set.articles.some((article) => article.id === routeId))
          ) ||
            value.aiArticles.some((article) => article.id === routeId))
        const resolved = routeStillExists ? routeId : firstId
        if (libraryViewState().expandedSessions === null) {
          const selectedSession = value.sessions.find((session) =>
            session.sets.some((set) => set.articles.some((article) => article.id === resolved))
          )
          const selectedSet = selectedSession?.sets.find((set) => set.articles.some((article) => article.id === resolved))
          const patch = {
            expandedSessions: selectedSession ? [selectedSession.id] : [],
            expandedSets: selectedSession && selectedSet ? [`${selectedSession.id}:${selectedSet.id}`] : [],
            aiExpanded: selectedSession === undefined && value.aiArticles.length > 0
          }
          updateLibraryViewState(patch)
          setExpansion(libraryViewState())
        }
        setSelectedId(resolved)
        if (resolved !== routeId) {
          replaceRoute('library', resolved === null ? {} : { articleId: resolved })
        }
      },
      (error: unknown) => {
        if (active) setLoadError(failureText(error, '文章库没有读出来。'))
      }
    )
    return () => {
      active = false
    }
  }, [reloadToken])

  useEffect(() => {
    if (articleId !== null) setSelectedId(articleId)
  }, [articleId])

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null)
      return
    }
    let active = true
    loadArticleDetail(selectedId).then(
      (value) => {
        if (active) setDetail(value)
      },
      (error: unknown) => {
        if (active) setLoadError(failureText(error, '文章库没有读出来。'))
      }
    )
    return () => {
      active = false
    }
  }, [selectedId, reloadToken])

  const trimmedQuery = query.trim()

  useEffect(() => {
    if (trimmedQuery === '') {
      setFound(null)
      return
    }
    let active = true
    searchLibrary(trimmedQuery).then(
      (value) => {
        if (active) setFound(value)
      },
      (error: unknown) => {
        if (active) setLoadError(failureText(error, '文章库没有读出来。'))
      }
    )
    return () => {
      active = false
    }
  }, [trimmedQuery, reloadToken])

  useEffect(() => {
    if (importMessage === null) return
    const timer = window.setTimeout(() => setImportMessage(null), 5000)
    return () => window.clearTimeout(timer)
  }, [importMessage])

  useEffect(() => {
    if (hint === null) return
    const timer = window.setTimeout(() => setHint(null), 5000)
    return () => window.clearTimeout(timer)
  }, [hint])

  function updateExpansion(patch: Partial<ReturnType<typeof libraryViewState>>): void {
    updateLibraryViewState(patch)
    setExpansion(libraryViewState())
  }

  function toggleSession(id: string): void {
    const open = expansion.expandedSessions ?? []
    updateExpansion({ expandedSessions: open.includes(id) ? open.filter((item) => item !== id) : [...open, id] })
  }

  function toggleSet(id: string): void {
    const open = expansion.expandedSets
    updateExpansion({ expandedSets: open.includes(id) ? open.filter((item) => item !== id) : [...open, id] })
  }

  function select(articleId: string): void {
    setSelectedId(articleId)
    replaceRoute('library', { articleId })
  }

  function open(articleId: string): void {
    navigate('reading', { articleId, readingFrom: 'library' })
  }

  async function askAboutArticle(forceNew = false): Promise<void> {
    if (detail === null) return
    setLoadError(null)
    const opened = await openThreadForMain({ kind: 'article', articleId: detail.id }, { forceNew })
    if (opened === null) setLoadError(getChatStore().error ?? '没能打开线程，请刷新文章库后再试。')
  }

  function retryLoad(): void {
    setLoadError(null)
    setReloadToken((token) => token + 1)
  }

  /** 删掉当前这篇后，优先接上列表里的下一篇；没有就退回上一篇。 */
  function nextArticleId(articleId: string): string | null {
    if (listing === null) return null
    const ids = [
      ...listing.sessions.flatMap((session) => session.sets.flatMap((set) => set.articles.map((article) => article.id))),
      ...listing.aiArticles.map((article) => article.id)
    ]
    const index = ids.indexOf(articleId)
    if (index < 0) return ids[0] ?? null
    return ids[index + 1] ?? ids[index - 1] ?? null
  }

  function articleRenamed(title: string): void {
    setHint(`篇名已改为「${title}」。`)
    setReloadToken((token) => token + 1)
  }

  function articleDeleted(articleId: string): void {
    forgetLibraryArticle(articleId)
    setDetail(null)
    const next = nextArticleId(articleId)
    setSelectedId(next)
    replaceRoute('library', next === null ? {} : { articleId: next })
    setHint('文章已删除。')
    setReloadToken((token) => token + 1)
  }

  /** 修好随包语料后原地再导一遍，不必重启应用。 */
  async function retryImport(): Promise<void> {
    if (reimporting) return
    setReimporting(true)
    setImportMessage(null)
    setLoadError(null)
    try {
      const report = await reimportCorpus()
      onReimport(report)
      setReloadToken((token) => token + 1)
      setImportMessage(
        report.failed.length === 0
          ? `重新导入完成：${report.total} 篇都在库里了。`
          : `重新导入完成：还有 ${report.failed.length} 篇没导进来。`
      )
    } catch (error) {
      setLoadError(failureText(error, '重新导入没有完成，再试一次。'))
    } finally {
      setReimporting(false)
    }
  }

  const failureCount = corpusImport.failed.length
  // 以库里实际篇数为准：这一轮失败的那篇可能上一轮就已经导进来了。
  const storedCount =
    listing?.articleCount ??
    corpusImport.imported + corpusImport.updated + corpusImport.skipped

  return (
    <div ref={rootRef} className="page page-wide library">
      <header className="library-head">
        <div>
          <h1 className="page-title">文章库</h1>
          <p className="library-count">
            {listing === null
              ? '正在读取本机资料库…'
              : listing.sessionCount === 0
                ? `${listing.articleCount} 篇`
                : `${listing.articleCount} 篇 · ${listing.sessionCount} 个场次`}
          </p>
        </div>
        <label className="library-search">
          <input
            type="search"
            aria-label="搜篇名或正文"
            placeholder="搜篇名或正文"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              updateLibraryViewState({ query: event.target.value })
            }}
          />
        </label>
      </header>

      {failureCount > 0 ? (
        <section className="library-warning" role="alert">
          <p className="library-warning-title">
            有 {failureCount} 篇没导进来，其余 {storedCount} 篇已在库里。
          </p>
          <ul className="library-warning-list">
            {corpusImport.failed.map((failure) => (
              <li key={failure.id}>
                <span className="library-warning-id">{failure.id}</span>
                {failure.reason}
              </li>
            ))}
          </ul>
          <div className="library-warning-actions">
            <button
              type="button"
              className="button button-small"
              disabled={reimporting}
              onClick={() => void retryImport()}
            >
              {reimporting ? '正在重新导入…' : '重新导入'}
            </button>
            <span className="library-warning-hint">
              再试一次；一直失败说明随包语料损坏，需要重新安装。
            </span>
          </div>
        </section>
      ) : null}

      {loadError !== null ? (
        <ErrorBlock message={loadError} onAction={retryLoad} />
      ) : null}

      <div className="library-columns">
        <div className="library-list">
          {found !== null ? (
            <SearchResults
              query={found.query}
              results={found.results}
              selectedId={selectedId}
              onSelect={select}
            />
          ) : listing !== null ? (
            <>
              {listing.sessions.map((session) => {
                const expanded = expansion.expandedSessions?.includes(session.id) ?? false
                return (
                  <section key={session.id} className="library-session" aria-label={session.label}>
                    <h2 className="library-session-head">
                      <button type="button" className="library-group-toggle" aria-expanded={expanded}
                        onClick={() => toggleSession(session.id)}>
                        <span aria-hidden="true">{expanded ? '▾' : '▸'}</span> {session.label}
                        <span className="library-session-count">{session.sets.reduce((n, set) => n + set.articles.length, 0)} 篇</span>
                      </button>
                    </h2>
                    {expanded ? session.sets.map((set) => {
                      const key = `${session.id}:${set.id}`
                      const setExpanded = expansion.expandedSets.includes(key)
                      return <section key={key} className="library-set">
                        <h3 className="library-set-head">
                          <button type="button" className="library-group-toggle" aria-expanded={setExpanded}
                            onClick={() => toggleSet(key)}>
                            <span aria-hidden="true">{setExpanded ? '▾' : '▸'}</span> {set.label}
                            <span className="library-session-count">{set.articles.length} 篇</span>
                          </button>
                        </h3>
                        {setExpanded ? <ArticleRowList articles={set.articles} selectedId={selectedId} onSelect={select} inSet /> : null}
                      </section>
                    }) : null}
                  </section>
                )
              })}
              <section className="library-ai-section" aria-label="AI 生成">
                <h2 className="library-ai-head">
                  <button type="button" className="library-group-toggle" aria-expanded={expansion.aiExpanded}
                    onClick={() => updateExpansion({ aiExpanded: !expansion.aiExpanded })}>
                    <span aria-hidden="true">{expansion.aiExpanded ? '▾' : '▸'}</span> AI 生成
                    <span className="library-session-count">{listing.aiArticles.length} 篇</span>
                  </button>
                </h2>
                {expansion.aiExpanded ? listing.aiArticles.length === 0 ? (
                  <div className="library-ai-empty">
                    <p className="empty-line">用一组词生成第一篇</p>
                    <button type="button" className="button button-small" onClick={() => navigate('entries')}>去词条页选词</button>
                  </div>
                ) : <ArticleRowList articles={listing.aiArticles} selectedId={selectedId} onSelect={select} /> : null}
              </section>
            </>
          ) : null}
        </div>

        <aside className="library-detail" aria-label="文章详情">
          {detail === null ? (
            <p className="empty-line">在左边选一篇。</p>
          ) : (
            <>
              <p className="eyebrow">{detail.sourceType === 'ai' ? '生成文章' : '这篇'}</p>
              <h2 className="library-detail-title">{detail.title}</h2>
              <dl className="library-meta">
                {detail.sessionLabel === '' && detail.setLabel === '' ? null : (
                  <div>
                    <dt>场次</dt>
                    <dd>
                      {[detail.sessionLabel, detail.setLabel]
                        .filter((part) => part.trim() !== '')
                        .join(' · ')}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>题型</dt>
                  <dd>{detail.kindLabel}</dd>
                </div>
                <div>
                  <dt>篇幅</dt>
                  <dd>
                    {detail.wordCount} 词 · {detail.paragraphCount} 段 · {detail.sentenceCount} 句
                  </dd>
                </div>
                <div>
                  <dt>进度</dt>
                  <dd>{progressText(detail.progress)}</dd>
                </div>
                <div>
                  <dt>最近打开</dt>
                  <dd>
                    {detail.lastOpenedAt === null
                      ? '还没打开过'
                      : formatDay(detail.lastOpenedAt)}
                  </dd>
                </div>
                {detail.pages === '' ? null : (
                  <div>
                    <dt>原卷</dt>
                    <dd>{detail.pages}</dd>
                  </div>
                )}
              </dl>
              {detail.sourceWords.length === 0 ? null : (
                <section className="library-source-words" aria-label="来源词">
                  <h3 className="library-collected-title">来源词</h3>
                  <ul className="library-source-word-list">
                    {detail.sourceWords.map((word) => (
                      <li key={word.entryId}>
                        {word.mainForm === null ? (
                          // 词条后来被删掉了：保留「这是来源」的事实，但不做成可点的死链接。
                          <span className="library-source-missing">词条已删除</span>
                        ) : (
                          <button
                            type="button"
                            className="chat-main-link"
                            onClick={() => navigate('entries', { entryId: word.entryId })}
                          >
                            {word.mainForm}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <div className="library-detail-actions">
                <button
                  type="button"
                  className="button button-primary"
                  onClick={() => open(detail.id)}
                >
                  {detail.progress.state === 'completed' ? '重读' : '继续阅读'}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => void askAboutArticle()}
                >
                  与这篇对话
                </button>
                <button type="button" className="button" onClick={() => void askAboutArticle(true)}>
                  新开一条
                </button>
              </div>
              <ArticleCollectedSection article={detail} />
              <LibraryArticleActions
                detail={detail}
                onRenamed={articleRenamed}
                onDeleted={articleDeleted}
                onError={(message) => setLoadError(message)}
              />
            </>
          )}
        </aside>
      </div>

      {importMessage === null ? null : (
        <p className="toast" role="status">
          {importMessage}
        </p>
      )}
      {hint === null ? null : (
        <p className="toast" role="status">
          {hint}
        </p>
      )}
    </div>
  )
}

/** 真题分组与 AI 段共用同一行：篇名、meta（含 AI 生成与词数）与进度。 */
function ArticleRowList({
  articles,
  selectedId,
  onSelect,
  inSet = false
}: {
  articles: readonly LibraryArticle[]
  inSet?: boolean
  selectedId: string | null
  onSelect: (articleId: string) => void
}) {
  return (
    <ul className="library-rows">
      {articles.map((article) => (
        <li key={article.id}>
          <button
            type="button"
            className="library-row"
            aria-current={article.id === selectedId ? 'true' : undefined}
            onClick={() => onSelect(article.id)}
          >
            <span className="library-row-name">{inSet ? librarySetRowTitle(article) : article.title}</span>
            <span className="library-row-meta">
              {libraryArticleMetaParts(article).join(' · ')}
            </span>
            <span className="library-row-progress">{progressText(article.progress)}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function SearchResults({
  query,
  results,
  selectedId,
  onSelect
}: {
  query: string
  results: LibrarySearchResults['results']
  selectedId: string | null
  onSelect: (articleId: string) => void
}) {
  return (
    <section className="library-session" aria-label={`「${query}」的搜索结果`}>
      <h2 className="library-session-head">
        <span>「{query}」的结果</span>
        <span className="library-session-count">{results.length} 篇</span>
      </h2>
      {results.length === 0 ? (
        <p className="empty-line">没有找到。换个词试试，篇名和正文都会搜。</p>
      ) : (
        <ul className="library-rows">
          {results.map((result) => (
            <li key={result.article.id}>
              <button
                type="button"
                className="library-row library-row-search"
                aria-current={result.article.id === selectedId ? 'true' : undefined}
                onClick={() => onSelect(result.article.id)}
              >
                <span className="library-row-name">{result.article.title}</span>
                <span className="library-row-meta">
                  {libraryArticleMetaParts(result.article, { includeSession: true }).join(' · ')}
                </span>
                <span className="library-row-progress">
                  {progressText(result.article.progress)}
                </span>
                <span className="library-snippet">
                  <span className="library-hit">
                    {result.matched === 'title' ? '篇名命中' : '正文命中'}
                  </span>
                  {highlight(result.snippet, query)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** 把 <mark> 左右按原文字面切出来，不拼 HTML。 */
function highlight(text: string, query: string): ReactNode[] {
  const needle = query.toLowerCase()
  if (needle === '') {
    return [text]
  }
  const haystack = text.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  while (cursor < text.length) {
    const hit = haystack.indexOf(needle, cursor)
    if (hit < 0) {
      parts.push(text.slice(cursor))
      break
    }
    if (hit > cursor) {
      parts.push(text.slice(cursor, hit))
    }
    parts.push(<mark key={hit}>{text.slice(hit, hit + needle.length)}</mark>)
    cursor = hit + needle.length
  }
  return parts
}
