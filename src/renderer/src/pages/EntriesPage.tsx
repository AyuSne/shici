import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { EntryListResult, EntryPage, EntrySentence } from '../../../shared/entries'
import { deleteEntrySentence, loadEntryList, loadEntryPage } from '../api'
import { getChatStore, openGroupThread, openThreadForMain } from '../chat/store'
import { ErrorBlock } from '../components/error-block'
import { EntryList, type EntryFilter, type EntrySort } from '../entries/entry-list'
import { deleteLastSentenceText, entryHeadlineText } from '../entries/format'
import { entryLayoutForWidth, type EntryLayout } from '../entries/layout'
import { NoteRail } from '../entries/note-rail'
import {
  selectionBlockedText,
  toggleEntrySelection
} from '../entries/selection'
import { SentenceRow } from '../entries/sentence-row'
import { failureText } from '../errors'
import { laterToggleLabel } from '../later/format'
import { useLaterMark } from '../later/use-later-mark'
import { navigate, replaceRoute } from '../navigate'
import {
  entriesViewState,
  entryScrollTop,
  updateEntriesViewState,
  updateEntryScrollTop
} from '../view-state'

const LEARNING_RAIL_ID = 'entries-learning-rail'

/**
 * 词条页：左列表、中原句、右学习内容。打开词条先看到原句，右栏默认收窄。
 * 原句按文章分组，组内按句序；每条能回到原文、重新圈定、拆到别的词条或删除。
 */
export function EntriesPage({
  entryId,
  entrySentenceId,
  noteId = null,
  focusRevision = 0
}: {
  entryId: string | null
  entrySentenceId: string | null
  /** 从全局搜索点进来的学习内容：打开右栏并定位到那一条。 */
  noteId?: string | null
  /** 显式点搜索结果时递增；同 hash 时也用它重新打开右栏、滚回目标。 */
  focusRevision?: number
}) {
  const [listing, setListing] = useState<EntryListResult | null>(null)
  const [allEntries, setAllEntries] = useState<EntryListResult | null>(null)
  // 选中的词条只有路由这一个真源：左栏点击与全局搜索跳转都先改地址，
  // 再由 entryId 决定打开哪一条，避免页面内再维护一份会互相写回的 selectedId。
  const selectedId = entryId
  const [page, setPage] = useState<EntryPage | null>(null)
  const [query, setQuery] = useState(() => entriesViewState().query)
  const [sort, setSort] = useState<EntrySort>(() => entriesViewState().sort)
  const [filter, setFilter] = useState<EntryFilter>(() => entriesViewState().filter)
  const [railOpen, setRailOpen] = useState(false)
  // 先按抽屉渲染；首帧布局后按真实容器宽度决定是否内联，避免宽窗口闪一下覆盖层。
  const [layout, setLayout] = useState<EntryLayout>('drawer')
  const [listError, setListError] = useState<string | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<EntrySentence | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  // 多选只是这一页的临时动作，不写进浏览状态仓：取消或离开页面就没了。
  const [selectedEntryIds, setSelectedEntryIds] = useState<readonly string[]>([])
  const [selectionHint, setSelectionHint] = useState<string | null>(null)
  const [startingGroup, setStartingGroup] = useState(false)
  const later = useLaterMark()

  const listRequest = useRef(0)
  const pageRequest = useRef(0)
  /** 这一页发起的组词请求；取消选择或离开页面时中止它的界面生命周期。 */
  const groupRequest = useRef<AbortController | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const restoredScroll = useRef(false)
  /**
   * 这次搜索定位已经执行过；用户自己收起后，普通刷新不重新弹开。
   * 点同一条结果会带新的 focusRevision，才允许再执行一次。
   */
  const lastNoteFocus = useRef<{ noteId: string; revision: number } | null>(null)
  const selectedIdRef = useRef(selectedId)
  selectedIdRef.current = selectedId
  const mountedRef = useRef(true)

  /** 迟到的异步回复只有在页面还挂着、且用户仍停在发起操作的词条上才改界面。 */
  function isCurrentEntry(id: string): boolean {
    return mountedRef.current && selectedIdRef.current === id
  }

  // 只看这一页真实拿到的容器宽度：全局栏、页面留白与滚动条都已经扣掉。
  // 容器变宽到三栏预算才内联，否则右栏是覆盖抽屉，绝不再把中栏挤窄。
  useLayoutEffect(() => {
    const node = rootRef.current
    if (node === null) return
    const apply = (availableWidth: number): void => {
      setLayout(entryLayoutForWidth(availableWidth))
    }
    apply(node.clientWidth)
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) apply(entry.contentRect.width)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const toggleRail = useCallback((): void => {
    setRailOpen((open) => !open)
  }, [])
  const closeRail = useCallback((): void => {
    setRailOpen(false)
  }, [])

  useLayoutEffect(() => {
    const node = rootRef.current?.closest('main')
    if (!node) return
    restoredScroll.current = false
    const remember = (): void => {
      if (restoredScroll.current) updateEntryScrollTop(selectedId, node.scrollTop)
    }
    node.addEventListener('scroll', remember)
    return () => {
      remember()
      node.removeEventListener('scroll', remember)
    }
  }, [selectedId])

  useLayoutEffect(() => {
    if (restoredScroll.current) return
    if (selectedId !== null && page?.entry.id !== selectedId) return
    // 带原句的跳转应定位该句，不能让稍后返回的列表再覆盖这个位置。
    if (selectedId === entryId && entrySentenceId !== null) {
      restoredScroll.current = true
      return
    }
    if (listing === null) return
    const node = rootRef.current?.closest('main')
    if (!node) return
    node.scrollTop = entryScrollTop(selectedId)
    restoredScroll.current = true
  }, [entryId, entrySentenceId, listing, page, selectedId])

  // 从全局搜索点学习内容命中：右栏（窄屏是覆盖抽屉）自动打开并定位到那一条。
  // 同一条结果再点一次也带新的 focusRevision：收起后要重新打开，不能因为 hash 没变就失效。
  useEffect(() => {
    if (noteId === null) {
      lastNoteFocus.current = null
      return
    }
    if (page === null || page.entry.id !== entryId) return
    if (!page.notes.some((note) => note.id === noteId)) return
    const previous = lastNoteFocus.current
    if (previous?.noteId === noteId && previous.revision === focusRevision) return
    lastNoteFocus.current = { noteId, revision: focusRevision }
    setRailOpen(true)
  }, [noteId, entryId, page, focusRevision])

  useEffect(() => {
    const sequence = listRequest.current + 1
    listRequest.current = sequence
    setListError(null)
    loadEntryList({ query, sort, filter }).then(
      (value) => {
        if (sequence !== listRequest.current) return
        setListing(value)
        setListError(null)
      },
      (error: unknown) => {
        if (sequence === listRequest.current) {
          setListError(failureText(error, '词条列表没有读出来。'))
        }
      }
    )
  }, [query, sort, filter, reloadToken])

  useEffect(() => {
    let active = true
    loadEntryList({}).then(
      (value) => {
        if (active) setAllEntries(value)
      },
      () => undefined
    )
    return () => {
      active = false
    }
  }, [reloadToken])

  // 打开当前路由指向的词条。地址是唯一真源，这里不再回写路由：
  // 左栏点击先 replace 到新词条，页面级搜索跳转保留自己的历史，两边都不会互相改写。
  useEffect(() => {
    if (selectedId === null) {
      pageRequest.current += 1
      setPage(null)
      setPageError(null)
      return
    }
    const sequence = pageRequest.current + 1
    pageRequest.current = sequence
    setPageError(null)
    loadEntryPage(selectedId).then(
      (value) => {
        if (sequence !== pageRequest.current) return
        if (value === null) {
          setPage(null)
          setPageError('这个词条已经不在了。')
          return
        }
        setPage(value)
      },
      (error: unknown) => {
        if (sequence === pageRequest.current) {
          setPage(null)
          setPageError(failureText(error, '这个词条没有读出来。'))
        }
      }
    )
  }, [selectedId, reloadToken])

  useEffect(() => {
    if (page === null || page.entry.id !== entryId || entrySentenceId === null) return
    const frame = window.requestAnimationFrame(() => {
      const row = Array.from(document.querySelectorAll<HTMLElement>('.entry-sentence'))
        .find((item) => item.dataset.entrySentenceId === entrySentenceId)
      row?.scrollIntoView({ block: 'center' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [page, entryId, entrySentenceId, focusRevision])

  useEffect(() => {
    if (hint === null) return
    const timer = window.setTimeout(() => setHint(null), 4000)
    return () => window.clearTimeout(timer)
  }, [hint])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      groupRequest.current?.abort()
      groupRequest.current = null
    }
  }, [])

  function refresh(message?: string): void {
    setActionError(null)
    setReloadToken((token) => token + 1)
    if (message !== undefined) {
      setHint(message)
    }
  }

  function selectEntry(id: string): void {
    // 左栏选择是页面内换对象：替换地址，不新增历史。
    replaceRoute('entries', { entryId: id })
    setRailOpen(false)
    setActionError(null)
    setConfirmDelete(null)
  }

  /** 多选按词条 id 记；第 21 个被拦下时留一句明确提示，已选内容不动。 */
  function toggleSelected(id: string): void {
    const next = toggleEntrySelection(selectedEntryIds, id)
    if (next.blocked) {
      setSelectionHint(selectionBlockedText())
      return
    }
    setSelectedEntryIds(next.ids)
    setSelectionHint(null)
  }

  function clearSelection(): void {
    // 取消选择同时作废还在等主进程回复的组词请求；用户可以立刻重新选词开始。
    groupRequest.current?.abort()
    groupRequest.current = null
    setStartingGroup(false)
    setSelectedEntryIds([])
    setSelectionHint(null)
  }

  /** 「用这些词学习」：一次新开一条对话，不复用已有的空白或组词对话。 */
  async function startGroup(): Promise<void> {
    if (selectedEntryIds.length === 0 || startingGroup) return
    const controller = new AbortController()
    groupRequest.current?.abort()
    groupRequest.current = controller
    setStartingGroup(true)
    setActionError(null)
    setSelectionHint(null)
    const opened = await openGroupThread(selectedEntryIds, { signal: controller.signal })
    // 取消、离开或后来的尝试已经接管了这次动作：旧回复连页面状态都不碰。
    if (groupRequest.current !== controller) return
    groupRequest.current = null
    if (!controller.signal.aborted && opened === null) {
      setSelectionHint(getChatStore().error ?? '没能用这些词开对话，再试一次。')
    }
    if (!controller.signal.aborted) setStartingGroup(false)
  }

  function openReading(sentence: EntrySentence, reselect: boolean): void {
    navigate('reading', {
      articleId: sentence.articleId,
      entrySentenceId: sentence.id,
      readingFrom: 'entries',
      reselect
    })
  }

  async function removeSentence(sentence: EntrySentence): Promise<void> {
    if (deleting) return
    // 删除已发出后用户可能切页或切词条；迟到的成功回复只更新仍相关的那一页。
    const entryId = page?.entry.id ?? null
    const mainForm = page?.entry.mainForm ?? '这个词条'
    setDeleting(true)
    setActionError(null)
    try {
      const result = await deleteEntrySentence(sentence.id)
      const stillHere = entryId !== null && isCurrentEntry(entryId)
      if (result.status === 'missing') {
        if (stillHere) {
          setActionError('这条原句已经不在了。')
          setConfirmDelete(null)
          refresh()
        }
        return
      }
      if (result.entryDeleted || result.entry === null) {
        if (stillHere) {
          setHint(`原句与「${mainForm}」已删除。`)
          setConfirmDelete(null)
          setPage(null)
          setRailOpen(false)
          replaceRoute('entries')
          refresh()
        } else if (mountedRef.current) {
          // 用户已经选了另一条词条：只刷新列表，不把地址或选中拉回空页。
          refresh()
        }
        return
      }
      if (stillHere) {
        setConfirmDelete(null)
        refresh('原句已删除。')
      } else if (mountedRef.current) {
        refresh()
      }
    } catch (error) {
      if (entryId === null || isCurrentEntry(entryId)) setActionError(failureText(error))
    } finally {
      setDeleting(false)
    }
  }

  function requestDelete(sentence: EntrySentence): void {
    if (page === null) return
    if (page.entry.sentenceCount <= 1) {
      setConfirmDelete(sentence)
      return
    }
    void removeSentence(sentence)
  }

  /** 当前词条已不存在：还停在它上面才退回空词条页；已经切走就只刷新列表。 */
  function entryGone(entryId: string): void {
    if (!mountedRef.current) return
    if (selectedIdRef.current !== entryId) {
      refresh()
      return
    }
    setPage(null)
    setRailOpen(false)
    replaceRoute('entries')
    refresh()
  }

  /** 词条页上的「稍后看」：状态只改独立标记，原句、学习内容与收集时间都不动。 */
  function toggleLater(): void {
    if (page === null) return
    const { id, mainForm, laterMarkedAt } = page.entry
    const next = laterMarkedAt === null
    void later.setLater(
      { entryId: id, mainForm, later: next },
      {
        failureMessage: '稍后看没有改成功，再试一次。',
        onSettled: ({ entryId, markedAt, notice }) => {
          setPage((current) =>
            current !== null && current.entry.id === entryId
              ? { ...current, entry: { ...current.entry, laterMarkedAt: markedAt } }
              : current
          )
          // 只在用户还停在这条词条上时给反馈；切走后晚到的结果不打扰当前页。
          if (selectedIdRef.current === entryId) setHint(notice)
        },
        onMissing: (entryId) => {
          if (selectedIdRef.current !== entryId) return
          refresh()
          setActionError('这个词条已经不在了。')
        },
        onError: ({ entryId, message }) => {
          if (selectedIdRef.current === entryId) setActionError(message)
        }
      }
    )
  }

  async function askAboutEntry(forceNew = false): Promise<void> {
    if (page === null) return
    setActionError(null)
    const opened = await openThreadForMain({ kind: 'entry', entryId: page.entry.id }, { forceNew })
    if (opened === null) setActionError(getChatStore().error ?? '没能打开对话，请刷新词条后再试。')
  }

  async function askAboutSentence(sentence: EntrySentence, forceNew = false): Promise<void> {
    setActionError(null)
    const opened = await openThreadForMain({
      kind: 'sentence',
      entrySentenceId: sentence.id
    }, { forceNew })
    if (opened === null) setActionError(getChatStore().error ?? '没能打开对话，请刷新词条后再试。')
  }

  const overlay = layout === 'drawer' && railOpen && page !== null

  return (
    <div
      ref={rootRef}
      className="entries-page"
      data-rail={railOpen ? 'open' : 'closed'}
      data-layout={layout}
    >
      <EntryList
        listing={listing}
        selectedId={selectedId}
        query={query}
        sort={sort}
        filter={filter}
        selectedEntryIds={selectedEntryIds}
        selectionHint={selectionHint}
        startingGroup={startingGroup}
        onQuery={(value) => {
          setQuery(value)
          updateEntriesViewState({ query: value })
        }}
        onSort={(value) => {
          setSort(value)
          updateEntriesViewState({ sort: value })
        }}
        onFilter={(value) => {
          setFilter(value)
          updateEntriesViewState({ filter: value })
        }}
        onSelect={selectEntry}
        onToggleSelect={toggleSelected}
        onStartGroup={() => void startGroup()}
        onClearSelection={clearSelection}
      />

      <section className="entries-main" aria-label="词条内容">
        {listError === null ? null : (
          <ErrorBlock message={listError} onAction={() => refresh()} />
        )}

        {page !== null ? (
          <>
            <header className="entries-main-head">
              <div className="entries-main-title">
                <p className="eyebrow">词条</p>
                <h2 className="entries-title">{page.entry.mainForm}</h2>
                <p className="entries-meta">{entryHeadlineText(page.entry)}</p>
              </div>
              <div className="entries-main-actions">
                <button
                  type="button"
                  className="button"
                  onClick={() => void askAboutEntry()}
                >
                  开始对话
                </button>
                <button type="button" className="button" onClick={() => void askAboutEntry(true)}>
                  新开一条
                </button>
                <button
                  type="button"
                  className="button"
                  aria-pressed={page.entry.laterMarkedAt !== null}
                  disabled={later.busyEntryId !== null}
                  onClick={toggleLater}
                >
                  {laterToggleLabel(page.entry.laterMarkedAt !== null)}
                </button>
                <button
                  type="button"
                  className="button"
                  aria-expanded={railOpen}
                  aria-controls={LEARNING_RAIL_ID}
                  onClick={() => setRailOpen(true)}
                >
                  学习内容 {page.entry.noteCount}
                </button>
              </div>
            </header>

            {actionError === null ? null : (
              <ErrorBlock
                message={actionError}
                actionLabel="刷新列表"
                onAction={() => refresh()}
              />
            )}

            {page.groups.length === 0 ? (
              <p className="empty-line">这个词条还没有原句。</p>
            ) : (
              page.groups.map((group) => (
                <section
                  className="entry-group"
                  key={group.articleId}
                  aria-label={`${group.articleTitle} 的原句`}
                >
                  <h3 className="entry-group-head">
                    <span>{group.articleTitle}</span>
                    <span className="entry-group-count">{group.sentences.length} 句</span>
                  </h3>
                  <ul className="entry-sentences">
                    {group.sentences.map((sentence) => (
                      <SentenceRow
                        key={sentence.id}
                        sentence={sentence}
                        focused={page.entry.id === entryId && sentence.id === entrySentenceId}
                        busy={deleting}
                        onBack={() => openReading(sentence, false)}
                        onReselect={() => openReading(sentence, true)}
                        onAsk={() => void askAboutSentence(sentence)}
                        onAskNew={() => void askAboutSentence(sentence, true)}
                        onRequestDelete={() => requestDelete(sentence)}
                      />
                    ))}
                  </ul>
                </section>
              ))
            )}

            {confirmDelete === null ? null : (
              <div className="entry-confirm" role="alertdialog" aria-label="删除最后一条原句">
                <p>{deleteLastSentenceText(page.entry.mainForm, page.entry.noteCount)}</p>
                <div className="entries-main-actions">
                  <button
                    type="button"
                    className="button"
                    disabled={deleting}
                    onClick={() => setConfirmDelete(null)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="button entry-action-danger"
                    disabled={deleting}
                    onClick={() => void removeSentence(confirmDelete)}
                  >
                    删除词条与原句
                  </button>
                </div>
              </div>
            )}
          </>
        ) : pageError !== null ? (
          <ErrorBlock message={pageError} onAction={() => refresh()} />
        ) : listing !== null && listing.total === 0 ? (
          <div className="entries-main-empty">
            <p className="eyebrow">还没有词条</p>
            <h2 className="entries-title">先读一篇</h2>
            <p className="empty-line">读的时候圈一个词，它就会出现在这里。</p>
            <button
              type="button"
              className="button button-primary"
              onClick={() => navigate('library')}
            >
              去文章库
            </button>
          </div>
        ) : (
          <p className="empty-line">在左边选一个词条。</p>
        )}
      </section>

      {overlay ? (
        <div
          className="entries-rail-backdrop"
          aria-hidden="true"
          onClick={closeRail}
        />
      ) : null}

      {page === null ? null : (
        <NoteRail
          key={page.entry.id}
          id={LEARNING_RAIL_ID}
          page={page}
          entries={allEntries?.entries ?? []}
          open={railOpen}
          overlay={overlay}
          focusedNoteId={page.entry.id === entryId ? noteId : null}
          focusRevision={focusRevision}
          onToggle={toggleRail}
          onClose={closeRail}
          onChanged={(message) => refresh(message)}
          onEntryGone={entryGone}
        />
      )}

      {hint === null ? null : (
        <p className="entries-toast" role="status">
          {hint}
        </p>
      )}
    </div>
  )
}
