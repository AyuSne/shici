import { useEffect, useState } from 'react'
import type { HomeLaterEntry, HomeSummary } from '../../../shared/library'
import { loadHomeSummary } from '../api'
import { ErrorBlock } from '../components/error-block'
import { failureText } from '../errors'
import {
  continueReadingDisplay,
  finishedReadingDisplay,
  homeEntryMeta,
  homeReadingState
} from '../home/format'
import { HOME_LATER_EMPTY, laterRemoveLabel } from '../later/format'
import { useLaterMark } from '../later/use-later-mark'
import { formatDay, readingPointText } from '../library/format'
import { homeSentenceSegments } from '../home/highlight'
import { navigate } from '../navigate'

/**
 * 首页：继续阅读是最近读过的一篇；最近收集列出真实的词条，点一下进词条；
 * 稍后看单列显示标过的词条，可以进词条或就地移除。
 */
export function HomePage() {
  const [summary, setSummary] = useState<HomeSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const [laterNotice, setLaterNotice] = useState<string | null>(null)
  const [laterError, setLaterError] = useState<string | null>(null)
  const later = useLaterMark()

  useEffect(() => {
    let active = true
    setError(null)
    loadHomeSummary().then(
      (value) => {
        if (active) setSummary(value)
      },
      (reason: unknown) => {
        if (active) setError(failureText(reason, '首页没有读出来。'))
      }
    )
    return () => {
      active = false
    }
  }, [reloadToken])

  const current = summary?.continueReading ?? null
  const readingState = homeReadingState(summary)
  const display = current === null ? null : continueReadingDisplay(current.article)
  const finished =
    readingState === 'finished' && summary !== null
      ? finishedReadingDisplay(summary.completedArticleCount)
      : null

  function continueReading(articleId: string): void {
    navigate('reading', { articleId, readingFrom: 'home' })
  }

  function openEntry(entryId: string): void {
    navigate('entries', { entryId })
  }

  /** 从首页移除：立刻把这一行拿掉，并给一句看得见、读得出的「已移除」。 */
  function removeLater(entry: HomeLaterEntry): void {
    setLaterNotice(null)
    setLaterError(null)
    void later.setLater(
      { entryId: entry.entryId, mainForm: entry.mainForm, later: false },
      {
        failureMessage: '这条稍后看没有移除。',
        // 词条已经不在了也按移除处理：首页不该继续留着一条打不开的稍后看。
        missingAsSettled: true,
        onSettled: ({ entryId, notice }) => {
          setSummary((current) =>
            current === null
              ? current
              : {
                  ...current,
                  laterEntries: current.laterEntries.filter(
                    (item) => item.entryId !== entryId
                  )
                }
          )
          setLaterNotice(notice)
        },
        onError: ({ message }) => setLaterError(message)
      }
    )
  }

  const recentEntries = summary?.recentEntries ?? null
  const laterEntries = summary?.laterEntries ?? null

  return (
    <div className="page home">
      {finished !== null ? (
        // 读过并完成了，但没有读到一半的篇目：明确说「没有读到一半的文章了」，
        // 不把已读完的那篇再当成「继续阅读」端出来，也不暗示整个文章库都读过了。
        <section className="home-finished" aria-label="已读完">
          <p className="eyebrow">{finished.eyebrow}</p>
          <h1 className="home-title">{finished.title}</h1>
          <p className="home-lede">{finished.lede}</p>
          <div className="home-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => navigate('library')}
            >
              从文章库挑一篇
            </button>
            <button type="button" className="button" onClick={() => navigate('chat')}>
              用一组词生成
            </button>
          </div>
        </section>
      ) : current === null ? (
        <>
          <p className="eyebrow">还没有开始读</p>
          <h1 className="home-title">先读一篇</h1>
          <p className="home-lede">挑一篇真题开始读，圈下的词会出现在这里。</p>
          <div className="home-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => navigate('library')}
            >
              从文章库挑一篇
            </button>
            <button type="button" className="button" onClick={() => navigate('chat')}>
              用一组词生成
            </button>
          </div>
        </>
      ) : (
        <section className="home-continue" aria-label="继续阅读">
          <p className="eyebrow">{display?.eyebrow}</p>
          <h1 className="home-title">{display?.title}</h1>
          <p className="home-meta">{display?.meta}</p>
          {current.lastReadPoint === null ? (
            <p className="home-position">刚打开，还没开始读。</p>
          ) : (
            <>
              <p className="home-position">上次停在 {readingPointText(current.lastReadPoint)}</p>
              <p className="home-sentence">
                {homeSentenceSegments(
                  current.lastReadPoint.sentenceText,
                  current.lastReadPointHighlights
                ).map((segment, index) =>
                  segment.entryId === null ? (
                    <span key={index}>{segment.text}</span>
                  ) : (
                    <mark
                      key={index}
                      className="home-sentence-collected"
                      data-entry-id={segment.entryId}
                    >
                      {segment.text}
                    </mark>
                  )
                )}
              </p>
            </>
          )}
          {current.articleEntries.length === 0 ? null : (
            <div className="home-picked" aria-label="本篇已拾词">
              <span className="home-picked-label">本篇已拾</span>
              {current.articleEntries.map((entry) => (
                <button
                  key={entry.entryId}
                  type="button"
                  className="home-picked-chip"
                  onClick={() => openEntry(entry.entryId)}
                >
                  {entry.mainForm}
                </button>
              ))}
            </div>
          )}
          <div className="home-actions">
            <button
              type="button"
              className="button button-primary"
              onClick={() => continueReading(current.article.id)}
            >
              继续阅读
            </button>
          </div>
        </section>
      )}

      {error === null ? null : (
        <ErrorBlock
          message={error}
          onAction={() => setReloadToken((token) => token + 1)}
        />
      )}

      <section className="home-section">
        <h2 className="section-label">最近收集</h2>
        {recentEntries === null ? null : recentEntries.length === 0 ? (
          <p className="empty-line">还没有词条。读的时候圈一个词，它就会出现在这里。</p>
        ) : (
          <div className="home-entries" aria-label="最近收集的词条">
            {recentEntries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="home-entry"
                onClick={() => openEntry(entry.id)}
              >
                <span className="home-entry-form">{entry.mainForm}</span>
                <span className="home-entry-meta">{homeEntryMeta(entry)}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      <section className="home-section" aria-label="稍后看">
        <h2 className="section-label">稍后看</h2>
        {laterEntries === null ? null : laterEntries.length === 0 ? (
          <p className="empty-line">{HOME_LATER_EMPTY}</p>
        ) : (
          <ul className="home-later" aria-label="稍后看的词条">
            {laterEntries.map((entry) => (
              <li className="home-later-row" key={entry.entryId}>
                <button
                  type="button"
                  className="home-later-open"
                  onClick={() => openEntry(entry.entryId)}
                >
                  <span className="home-later-form">{entry.mainForm}</span>
                  <span className="home-later-meta">
                    标记于 {formatDay(entry.markedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="home-later-remove"
                  aria-label={laterRemoveLabel(entry.mainForm)}
                  disabled={later.busyEntryId === entry.entryId}
                  onClick={() => removeLater(entry)}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
        {laterError === null ? null : (
          <p className="home-later-error" role="alert">
            {laterError}
          </p>
        )}
        {laterNotice === null ? null : (
          <p className="home-later-notice" role="status">
            {laterNotice}
          </p>
        )}
      </section>
      <section className="home-section">
        <h2 className="section-label">文章库</h2>
        <button type="button" className="home-library" onClick={() => navigate('library')}>
          {summary === null
            ? '文章库'
            : `${summary.library.articleCount} 篇 · ${summary.library.sessionCount} 个场次`}
        </button>
      </section>
    </div>
  )
}
