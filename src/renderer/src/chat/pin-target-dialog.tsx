import { useEffect, useState, type KeyboardEvent } from 'react'
import type { EntryListItem } from '../../../shared/entries'
import type { LibraryArticle } from '../../../shared/library'
import type { PinTargetKind, PinTargetView } from '../../../shared/pins'
import { loadEntryList, loadLibrary } from '../api'
import { ErrorBlock } from '../components/error-block'
import { SearchableTargetPicker } from '../components/searchable-target-picker'
import type { SearchableTarget } from '../components/target-search'
import { failureText } from '../errors'

/**
 * 钉住 / 归位时的落点选择。默认落点由线程主对象推导，弹层里可以改；
 * 词条与文章都是本机已有的东西，选一个具体目标，不在这里新建。
 */

type TargetMode = PinTargetKind

export function PinTargetDialog({
  title,
  confirmLabel,
  initial,
  busy,
  onCancel,
  onConfirm
}: {
  title: string
  confirmLabel: string
  initial: PinTargetView
  busy: boolean
  onCancel: () => void
  onConfirm: (target: PinTargetView) => void
}) {
  const [mode, setMode] = useState<TargetMode>(initial.kind)
  const [entryId, setEntryId] = useState<string | null>(
    initial.kind === 'entry' ? initial.entryId : null
  )
  const [articleId, setArticleId] = useState<string | null>(
    initial.kind === 'article' ? initial.articleId : null
  )
  const [entries, setEntries] = useState<EntryListItem[] | null>(null)
  const [articles, setArticles] = useState<LibraryArticle[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let active = true
    loadEntryList({ sort: 'recent' }).then(
      (listing) => {
        if (active) setEntries(listing.entries)
      },
      (reason: unknown) => {
        if (active) setError(failureText(reason, '钉住的目标没有读出来。'))
      }
    )
    loadLibrary().then(
      (listing) => {
        if (active) {
          // 钉住的「文章」落点包含生成文章：AI 文章同样能钉、能回链、能按删除规则退未归档。
          setArticles([
            ...listing.sessions.flatMap((session) => session.sets.flatMap((set) => set.articles)),
            ...listing.aiArticles
          ])
        }
      },
      (reason: unknown) => {
        if (active) setError(failureText(reason, '钉住的目标没有读出来。'))
      }
    )
    return () => {
      active = false
    }
  }, [reloadToken])

  // 预选的词条 / 文章可能已经不在了：列表到位后落到第一个可用目标。
  useEffect(() => {
    if (entries === null) return
    setEntryId((current) =>
      current !== null && entries.some((entry) => entry.id === current)
        ? current
        : (entries[0]?.id ?? null)
    )
  }, [entries])

  useEffect(() => {
    if (articles === null) return
    setArticleId((current) =>
      current !== null && articles.some((article) => article.id === current)
        ? current
        : (articles[0]?.id ?? null)
    )
  }, [articles])

  const selectedEntry = entries?.find((entry) => entry.id === entryId) ?? null
  const selectedArticle = articles?.find((article) => article.id === articleId) ?? null
  const entryTargets: SearchableTarget[] = (entries ?? []).map((entry) => ({
    id: entry.id,
    label: entry.mainForm,
    detail: [
      entry.variants.length > 0 ? entry.variants.join('、') : '',
      `${entry.sentenceCount} 句`
    ]
      .filter(Boolean)
      .join(' · ')
  }))
  const articleTargets: SearchableTarget[] = (articles ?? []).map((article) => ({
    id: article.id,
    label: article.title,
    detail: article.kindLabel
  }))
  const entryLabel = selectedEntry?.mainForm ?? (initial.kind === 'entry' ? initial.label : '词条')
  const articleLabel =
    selectedArticle?.title ?? (initial.kind === 'article' ? initial.label : '文章')
  const entryReady = entries !== null && selectedEntry !== null
  const articleReady = articles !== null && selectedArticle !== null
  const canConfirm =
    !busy &&
    (mode === 'unfiled' ||
      (mode === 'entry' ? entryReady : articleReady))

  const confirm = (): void => {
    if (!canConfirm) return
    if (mode === 'entry' && selectedEntry !== null) {
      onConfirm({ kind: 'entry', entryId: selectedEntry.id, label: selectedEntry.mainForm })
      return
    }
    if (mode === 'article' && selectedArticle !== null) {
      onConfirm({
        kind: 'article',
        articleId: selectedArticle.id,
        label: selectedArticle.title
      })
      return
    }
    if (mode === 'unfiled') {
      onConfirm({ kind: 'unfiled' })
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
      return
    }
    const tag = (event.target as HTMLElement).tagName
    if (
      event.key === 'Enter' &&
      tag !== 'SELECT' &&
      tag !== 'BUTTON' &&
      tag !== 'TEXTAREA' &&
      tag !== 'INPUT' &&
      !event.defaultPrevented
    ) {
      event.preventDefault()
      confirm()
    }
  }

  return (
    <div className="pin-dialog" role="dialog" aria-label={title} onKeyDown={onKeyDown}>
      <h4 className="pin-dialog-title">{title}</h4>
      <div className="pin-targets" role="group" aria-label="落点">
        <button
          type="button"
          className="pin-target"
          aria-pressed={mode === 'entry'}
          onClick={() => setMode('entry')}
        >
          词条 · {entryLabel}
        </button>
        <button
          type="button"
          className="pin-target"
          aria-pressed={mode === 'article'}
          onClick={() => setMode('article')}
        >
          文章 · {articleLabel}
        </button>
        <button
          type="button"
          className="pin-target"
          aria-pressed={mode === 'unfiled'}
          onClick={() => setMode('unfiled')}
        >
          未归档
        </button>
      </div>

      {mode === 'entry' ? (
        entries === null ? (
          <p className="pin-dialog-hint">正在读词条…</p>
        ) : entries.length === 0 ? (
          <p className="pin-dialog-hint">还没有词条，先读一篇圈几个词。</p>
        ) : (
          <SearchableTargetPicker
            label="选择词条"
            targets={entryTargets}
            value={entryId}
            onChange={setEntryId}
            placeholder="搜索词条或已收变体…"
            emptyText="没有匹配的词条"
            autoFocus
          />
        )
      ) : null}

      {mode === 'article' ? (
        articles === null ? (
          <p className="pin-dialog-hint">正在读文章库…</p>
        ) : articles.length === 0 ? (
          <p className="pin-dialog-hint">文章库还是空的。</p>
        ) : (
          <SearchableTargetPicker
            label="选择文章"
            targets={articleTargets}
            value={articleId}
            onChange={setArticleId}
            placeholder="搜索文章篇名…"
            emptyText="没有匹配的文章"
            autoFocus
          />
        )
      ) : null}

      {mode === 'unfiled' ? (
        <p className="pin-dialog-hint">先放钉板里，归位前不算收集。</p>
      ) : null}

      <div className="pin-dialog-actions">
        <button
          type="button"
          className="button button-primary"
          disabled={!canConfirm}
          autoFocus
          onClick={confirm}
        >
          {busy ? '正在钉…' : confirmLabel}
        </button>
        <button type="button" className="button" onClick={onCancel}>
          取消
        </button>
        <span className="pin-dialog-esc">Enter 确认 · Esc 取消</span>
      </div>

      {error === null ? null : (
        <ErrorBlock
          message={error}
          actionLabel="重新读取"
          onAction={() => {
            setError(null)
            setReloadToken((token) => token + 1)
          }}
        />
      )}
    </div>
  )
}
