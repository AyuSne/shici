import { useLayoutEffect, useRef } from 'react'
import type { EntryListResult } from '../../../shared/entries'
import { SearchSnippetText } from '../search/snippet-text'
import { entriesViewState, updateEntriesViewState } from '../view-state'
import { ENTRY_SEARCH_MATCH_LABELS, entryListMetaText } from './format'
import { selectionCountText } from './selection'

export type EntrySort = 'recent' | 'alpha'
export type EntryFilter = 'all' | 'has-notes' | 'no-notes'

const FILTERS: readonly { value: EntryFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'has-notes', label: '有学习内容' },
  { value: 'no-notes', label: '没有学习内容' }
]

/** 词条页左栏：词条列表、搜索、排序与「有/无学习内容」筛选，以及多选后的一组词动作。 */
export function EntryList({
  listing,
  selectedId,
  query,
  sort,
  filter,
  selectedEntryIds,
  selectionHint,
  startingGroup,
  onQuery,
  onSort,
  onFilter,
  onSelect,
  onToggleSelect,
  onStartGroup,
  onClearSelection
}: {
  listing: EntryListResult | null
  selectedId: string | null
  query: string
  sort: EntrySort
  filter: EntryFilter
  selectedEntryIds: readonly string[]
  selectionHint: string | null
  startingGroup: boolean
  onQuery: (query: string) => void
  onSort: (sort: EntrySort) => void
  onFilter: (filter: EntryFilter) => void
  onSelect: (entryId: string) => void
  onToggleSelect: (entryId: string) => void
  onStartGroup: () => void
  onClearSelection: () => void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const restoredScroll = useRef(false)

  useLayoutEffect(() => {
    if (restoredScroll.current || listing === null || listRef.current === null) return
    const node = listRef.current
    node.scrollTop = entriesViewState().listScrollTop
    restoredScroll.current = true
  }, [listing])

  useLayoutEffect(() => () => {
    if (restoredScroll.current && listRef.current !== null) {
      updateEntriesViewState({ listScrollTop: listRef.current.scrollTop })
    }
  }, [])

  return (
    <aside className="entries-list" aria-label="词条列表">
      <header className="entries-list-head">
        <h1 className="page-title">词条</h1>
        <span className="entries-total">{listing === null ? '…' : listing.total}</span>
      </header>

      <label className="entries-search">
        <input
          type="search"
          aria-label="搜词条名、原句或学习内容"
          placeholder="搜词条名、原句或学习内容"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
        />
        {query === '' ? null : (
          <button
            type="button"
            className="entries-search-clear"
            aria-label="清空搜索"
            onClick={() => onQuery('')}
          >
            清空
          </button>
        )}
      </label>

      <div className="entries-toolbar">
        <div className="entries-segments" role="group" aria-label="词条排序">
          <button
            type="button"
            className="entries-segment"
            aria-pressed={sort === 'recent'}
            onClick={() => onSort('recent')}
          >
            最近收集
          </button>
          <button
            type="button"
            className="entries-segment"
            aria-pressed={sort === 'alpha'}
            onClick={() => onSort('alpha')}
          >
            字母
          </button>
        </div>
        <label className="entries-filter">
          <span className="entries-filter-label">筛选</span>
          <select
            aria-label="按学习内容筛选"
            value={filter}
            onChange={(event) => onFilter(event.target.value as EntryFilter)}
          >
            {FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {selectedEntryIds.length === 0 ? null : (
        <div className="entries-selection" role="group" aria-label="已选词条">
          <p className="entries-selection-count">
            {selectionCountText(selectedEntryIds.length)}
          </p>
          <div className="entries-selection-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={startingGroup}
              onClick={onStartGroup}
            >
              用这些词学习
            </button>
            <button type="button" className="button" onClick={onClearSelection}>
              取消选择
            </button>
          </div>
        </div>
      )}

      {selectionHint === null ? null : (
        <p className="entries-selection-hint" role="status">
          {selectionHint}
        </p>
      )}

      {listing !== null && listing.entries.length === 0 ? (
        <p className="empty-line entries-empty">
          {listing.total === 0
            ? '还没有词条。读的时候圈一个词，它就会出现在这里。'
            : query.trim() !== ''
              ? filter === 'all'
                ? `没有搜到「${query.trim()}」。换个词试试。`
                : `没有搜到「${query.trim()}」。换个词，或把筛选放回全部。`
              : '没有对上的词条。把筛选放回全部试试。'}
        </p>
      ) : (
        <ul
          className="entries-rows"
          ref={listRef}
          onScroll={(event) => {
            if (restoredScroll.current) {
              updateEntriesViewState({ listScrollTop: event.currentTarget.scrollTop })
            }
          }}
        >
          {(listing?.entries ?? []).map((entry) => {
            const checked = selectedEntryIds.includes(entry.id)
            return (
              <li
                key={entry.id}
                className="entries-row-item"
                data-selected={checked ? 'true' : 'false'}
              >
                <input
                  type="checkbox"
                  className="entries-row-check"
                  aria-label={`选择词条：${entry.mainForm}`}
                  checked={checked}
                  onChange={() => onToggleSelect(entry.id)}
                />
                <button
                  type="button"
                  className="entries-row"
                  data-entry-row-id={entry.id}
                  aria-current={entry.id === selectedId ? 'true' : undefined}
                  onClick={() => onSelect(entry.id)}
                >
                  <span className="entries-row-name">{entry.mainForm}</span>
                  <span className="entries-row-meta">{entryListMetaText(entry)}</span>
                  {entry.hit === undefined ? null : (
                    <span className="entries-row-hit" data-match={entry.hit.match}>
                      <span className="entries-row-hit-kind">
                        {ENTRY_SEARCH_MATCH_LABELS[entry.hit.match]}
                      </span>
                      <span className="entries-row-hit-snippet">
                        <SearchSnippetText snippet={entry.hit.snippet} />
                      </span>
                    </span>
                  )}
                  {entry.noteCount > 0 ? (
                    <span className="entries-row-notes">学习 {entry.noteCount}</span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}
