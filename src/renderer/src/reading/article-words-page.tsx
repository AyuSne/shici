import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArticleWordsView } from '../../../shared/article-words'
import type { EntrySummary } from '../../../shared/entries'
import { createLearningNote, loadArticleWords, uncompleteArticleReading } from '../api'
import { getChatStore, openArticlePackThread } from '../chat/store'
import { ErrorBlock } from '../components/error-block'
import { showToast } from '../components/toast-store'
import { failureText } from '../errors'
import { useLaterMark } from '../later/use-later-mark'
import { forgetLibraryArticle, goBack, navigate, replaceRoute } from '../navigate'
import type { ReadingSource, WordsSource } from '../routes'
import { articleWordsBackTarget } from './back-target'
import { ArticleWordsEntryCard } from './article-words-entry'
import { articleWordsSummaryText, paragraphWordsCountText, paragraphWordsLabel } from './article-words-format'

/**
 * 本篇选词：同一篇文章下的只读子视图，按段落列出这篇实际收下的词条与原句，
 * 也是读后集中整理的工作台。
 *
 * 「已读完」只由阅读页底部的显式手势写；这个页面本身（顶栏查看、文章库详情、
 * 直接打开地址、刷新）从不写完成时间，所以未读完的篇目不会被误标成 100%。
 * 已读完的篇目在这里提供「取消已读完」：只清完成标记，保留阅读位置、本篇阅读
 * 设置与已收词条；命令失败就原地报错，不做乐观更新。文章不存在时沿用 #41 的
 * 退路回文章库；进入、刷新或退出都不写阅读位置与本篇阅读设置。
 *
 * 整理动作都留在列表里：点词条原地展开离线词典，用一条释义起草学习内容后显式
 * 「保存学习内容」才入库；「稍后看」就地切换。草稿按词条 id 保存，同一个词条在
 * 多段出现时共用同一份草稿与状态，保存一条不会动到别的未保存草稿。
 */
export function ArticleWordsPage({
  articleId,
  readingFrom,
  wordsFrom
}: {
  articleId: string | null
  readingFrom: ReadingSource | null
  wordsFrom: WordsSource | null
}) {
  const [view, setView] = useState<ArticleWordsView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  /** 就地展开的词条（按词条 id）；同一个词条在几段出现都一起展开。 */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** 每个词条一份未保存草稿；保存一条不影响其它词条。 */
  const [drafts, setDrafts] = useState<Readonly<Record<string, string>>>({})
  const [draftErrors, setDraftErrors] = useState<Readonly<Record<string, string>>>({})
  const [savingEntryId, setSavingEntryId] = useState<string | null>(null)
  const [packing, setPacking] = useState(false)
  const later = useLaterMark()
  /** 保存后重读视图的序号；换文章或离开后旧结果不能覆盖新文章。 */
  const wordsRequest = useRef(0)
  /** 打包请求的所有权：切文章 / 卸载后迟到的结果不再导航。 */
  const packAbort = useRef<AbortController | null>(null)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      packAbort.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (articleId === null) {
      setView(null)
      setError(null)
      return
    }
    let active = true
    wordsRequest.current += 1
    packAbort.current?.abort()
    setPacking(false)
    setView(null)
    setError(null)
    setCancelError(null)
    setCancelling(false)
    setExpanded(new Set())
    setDrafts({})
    setDraftErrors({})
    setSavingEntryId(null)

    const fallbackToLibrary = (): void => {
      // 文章可能刚在文章库里被删掉：清掉最近文章并回文章库，不把子视图停在死地址上。
      forgetLibraryArticle(articleId)
      replaceRoute('library')
    }

    loadArticleWords(articleId).then(
      (value) => {
        if (!active) return
        if (value === null) {
          fallbackToLibrary()
          return
        }
        setView(value)
      },
      (failure: unknown) => {
        if (active) setError(failureText(failure, '本篇选词没有读出来。'))
      }
    )

    return () => {
      active = false
    }
  }, [articleId, reloadToken])

  /** 保存学习内容后按库里的真实状态重读列表；草稿与展开状态留在界面这一层。 */
  function refreshWords(): void {
    if (articleId === null) return
    const request = ++wordsRequest.current
    loadArticleWords(articleId).then(
      (value) => {
        if (request !== wordsRequest.current) return
        if (value === null) {
          forgetLibraryArticle(articleId)
          replaceRoute('library')
          return
        }
        setView(value)
      },
      (failure: unknown) => {
        if (request !== wordsRequest.current) return
        showToast({
          message: failureText(failure, '学习内容保存了，但列表没有重新读出来。'),
          tone: 'error'
        })
      }
    )
  }

  function updateEntryEverywhere(
    entryId: string,
    update: (entry: EntrySummary) => EntrySummary
  ): void {
    setView((current) =>
      current === null
        ? current
        : {
            ...current,
            paragraphs: current.paragraphs.map((paragraph) => ({
              ...paragraph,
              entries: paragraph.entries.map((group) =>
                group.entry.id === entryId ? { ...group, entry: update(group.entry) } : group
              )
            }))
          }
    )
  }

  function toggleExpanded(entryId: string): void {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(entryId)) {
        next.delete(entryId)
      } else {
        next.add(entryId)
      }
      return next
    })
  }

  function setDraft(entryId: string, value: string): void {
    setDrafts((current) => ({ ...current, [entryId]: value }))
    setDraftErrors((current) => {
      if (current[entryId] === undefined) return current
      const next = { ...current }
      delete next[entryId]
      return next
    })
  }

  /** 显式保存：只有这里会写库；词典查询与起草都只停在界面。 */
  function saveDraft(entryId: string): void {
    const body = (drafts[entryId] ?? '').trim()
    if (body === '' || savingEntryId !== null) return
    setSavingEntryId(entryId)
    setDraftErrors((current) => {
      if (current[entryId] === undefined) return current
      const next = { ...current }
      delete next[entryId]
      return next
    })
    createLearningNote({ entryId, body }).then(
      (result) => {
        setSavingEntryId(null)
        if (result.status === 'saved') {
          setDrafts((current) => ({ ...current, [entryId]: '' }))
          showToast({ message: '学习内容已保存。' })
          refreshWords()
          return
        }
        if (result.status === 'rejected') {
          setDraftErrors((current) => ({
            ...current,
            [entryId]:
              result.reason === 'entry' ? '这个词条已经不在了。' : '学习内容不能是空的。'
          }))
          return
        }
        setDraftErrors((current) => ({
          ...current,
          [entryId]: '学习内容没有保存成功，再试一次。'
        }))
      },
      (failure: unknown) => {
        setSavingEntryId(null)
        setDraftErrors((current) => ({
          ...current,
          [entryId]: failureText(failure, '学习内容没有保存成功，再点一次保存。')
        }))
      }
    )
  }

  /** 就地切换稍后看：同一个词条的所有出现一起更新，失败只提示不假成功。 */
  function toggleLater(entryId: string, mainForm: string, marked: boolean): void {
    void later.setLater(
      { entryId, mainForm, later: !marked },
      {
        failureMessage: '稍后看没有改成功，再试一次。',
        onSettled: ({ entryId: changedId, markedAt, notice }) => {
          updateEntryEverywhere(changedId, (entry) => ({ ...entry, laterMarkedAt: markedAt }))
          showToast({ message: notice })
        },
        onMissing: () => {
          showToast({ message: '这个词条已经不在了。', tone: 'error' })
        },
        onError: ({ message }) => {
          showToast({ message, tone: 'error' })
        }
      }
    )
  }

  /**
   * 打包问模型：筛选与组线程都由主进程按本文原句完成，界面只负责回执。
   * 「已带上前 N 个」在跳转后立即给出，跟着用户进对话页；空结果留在原地温和提示。
   */
  function packUnorganized(): void {
    if (articleId === null || packing) return
    const controller = new AbortController()
    packAbort.current?.abort()
    packAbort.current = controller
    setPacking(true)
    void openArticlePackThread(articleId, {
      signal: controller.signal,
      onCreated: (created) => {
        const message =
          created.omittedCount > 0
            ? `已带上前 ${created.packedCount} 个词，还有 ${created.omittedCount} 个没带上。`
            : `已带上 ${created.packedCount} 个词，去对话页接着问。`
        // 对话页挂载时会清掉上一页残留的 Toast（避免旧撤销跨页生效）；
        // 这条是这次跳转的回执，等它挂好再显示，不会被那条清理顺手抹掉。
        window.setTimeout(() => showToast({ message }), 0)
      }
    }).then((result) => {
      if (controller.signal.aborted) return
      if (mounted.current) setPacking(false)
      if (result === null) {
        showToast({
          message: getChatStore().error ?? '没能把本篇的词打包问模型，再试一次。',
          tone: 'error'
        })
        return
      }
      if (result.status === 'created') return
      if (result.status === 'empty') {
        showToast({
          message:
            result.reason === 'all-organized'
              ? '本篇的拾词都已整理好学习内容，不用再打包了。'
              : '本篇还没有拾词，先在正文里圈几个词。'
        })
        return
      }
      showToast({ message: '这篇文章已经不在库里了。', tone: 'error' })
    })
  }

  /** 本篇还没整理学习内容的词条数（去重）；只用于提示，真正筛选在主进程。 */
  const unorganizedCount = useMemo(() => {
    if (view === null) return 0
    const ids = new Set<string>()
    for (const paragraph of view.paragraphs) {
      for (const group of paragraph.entries) {
        if (group.entry.noteCount === 0) ids.add(group.entry.id)
      }
    }
    return ids.size
  }, [view])

  /** 收回已读完：清完成标记后按主进程返回的真实进度重画，不做乐观更新。 */
  function cancelCompletion(): void {
    if (articleId === null || cancelling) return
    setCancelling(true)
    setCancelError(null)
    uncompleteArticleReading(articleId).then(
      (result) => {
        if (result.status === 'missing') {
          forgetLibraryArticle(articleId)
          replaceRoute('library')
          return
        }
        setCancelling(false)
        setView((current) =>
          current === null
            ? current
            : {
                ...current,
                article: { ...current.article, progress: result.progress }
              }
        )
        showToast({ message: '已收回「已读完」，阅读位置和已收词条都还在。' })
      },
      (failure: unknown) => {
        setCancelling(false)
        setCancelError(failureText(failure, '没有收回「已读完」，再试一次。'))
      }
    )
  }

  const backTarget = articleWordsBackTarget({ articleId, readingFrom, wordsFrom })

  /**
   * 页脚进来时退回上一层（就是刚才那页阅读页），保留阅读页的定位与滚动；
   * 刷新后浏览器历史里仍是那页阅读页，所以这条退路仍然成立。文章库详情进来
   * 或直接打开地址时没有可退的上一页，按映射显式去文章库或阅读页，不猜历史。
   */
  function goBackFromWords(): void {
    if (wordsFrom === 'reader' && articleId !== null) {
      goBack('reading', { articleId, readingFrom })
      return
    }
    navigate(backTarget.route, backTarget.options)
  }

  function backToReading(): void {
    if (articleId === null) {
      navigate('library')
      return
    }
    navigate('reading', { articleId, readingFrom })
  }

  const completed = view?.article.progress.state === 'completed'

  return (
    <div className="reading reading-words" data-article-words="true">
      <header className="reading-bar">
        <button
          type="button"
          className="reading-back"
          aria-label={backTarget.ariaLabel}
          onClick={goBackFromWords}
        >
          <span aria-hidden="true">←</span> {backTarget.label}
        </button>
        <div className="reading-bar-text">
          <h1 className="reading-bar-title">{view?.article.title ?? '本篇选词'}</h1>
        </div>
        <div className="reading-bar-actions">
          {view === null ? null : (
            <>
              <span className="article-words-summary">
                {articleWordsSummaryText(view.article)}
              </span>
              {completed ? <span className="article-words-completed">已读完</span> : null}
              {completed ? (
                <button
                  type="button"
                  className="reading-tool"
                  disabled={cancelling}
                  onClick={cancelCompletion}
                >
                  {cancelling ? '正在收回…' : '取消已读完'}
                </button>
              ) : null}
              <button type="button" className="reading-tool" onClick={backToReading}>
                回到阅读
              </button>
            </>
          )}
        </div>
      </header>

      {cancelError === null ? null : (
        <ErrorBlock
          className="article-words-cancel-error"
          message={cancelError}
          actionLabel="再收回一次"
          onAction={cancelCompletion}
        />
      )}

      <div className="reading-scroll">
        <div className="reading-sheet article-words-sheet">
          {error !== null ? (
            <ErrorBlock
              message={error}
              actionLabel="再读一次"
              onAction={() => setReloadToken((token) => token + 1)}
            />
          ) : view === null ? (
            <p className="empty-line" aria-busy="true">
              正在读本篇选词…
            </p>
          ) : view.paragraphs.length === 0 ? (
            <div className="article-words-empty">
              <p className="eyebrow">本篇还没收词</p>
              <h2 className="article-words-empty-title">先读一篇，圈下想学的词</h2>
              <p className="empty-line">在正文里圈一个词或短语，它就会按段落收在这里。</p>
              <button type="button" className="button button-primary" onClick={backToReading}>
                回到阅读
              </button>
            </div>
          ) : (
            <div className="article-words-workbench">
              <section className="article-words-pack" aria-label="打包问模型">
                <p className="article-words-pack-hint">
                  {unorganizedCount === 0
                    ? '本篇的拾词都已整理好学习内容。'
                    : `还有 ${unorganizedCount} 个词没有学习内容。`}
                </p>
                <button
                  type="button"
                  className="button button-primary article-words-pack-button"
                  disabled={packing}
                  onClick={packUnorganized}
                >
                  {packing ? '正在打包…' : '把本篇未整理的词打包问模型'}
                </button>
              </section>
              <ol className="article-words-paragraphs">
              {view.paragraphs.map((paragraph) => (
                <li key={paragraph.id} className="article-words-paragraph">
                  <h2 className="article-words-paragraph-head">
                    <span className="article-words-paragraph-label">
                      {paragraphWordsLabel(paragraph)}
                    </span>
                    <span className="article-words-paragraph-count">
                      {paragraphWordsCountText(paragraph.entries.length)}
                    </span>
                  </h2>
                  <ul className="article-words-entries">
                    {paragraph.entries.map((group) => (
                      <ArticleWordsEntryCard
                        key={group.entry.id}
                        group={group}
                        expanded={expanded.has(group.entry.id)}
                        draft={drafts[group.entry.id] ?? ''}
                        draftError={draftErrors[group.entry.id] ?? null}
                        saving={savingEntryId === group.entry.id}
                        laterBusy={later.busyEntryId === group.entry.id}
                        onToggle={() => toggleExpanded(group.entry.id)}
                        onDraftChange={(value) => setDraft(group.entry.id, value)}
                        onSave={() => saveDraft(group.entry.id)}
                        onToggleLater={() =>
                          toggleLater(
                            group.entry.id,
                            group.entry.mainForm,
                            group.entry.laterMarkedAt !== null
                          )
                        }
                        onOpenEntry={() => navigate('entries', { entryId: group.entry.id })}
                      />
                    ))}
                  </ul>
                </li>
              ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
