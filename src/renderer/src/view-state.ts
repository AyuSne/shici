import type { EntryFilter, EntrySort } from './entries/entry-list'

/** 浏览状态只属于当前窗口；刷新后由地址恢复对象，不恢复草稿。 */
type ThreadViewState = {
  draft: string
  scrollTop: number | null
  thinkingOpen: boolean | null
}

const threadStates = new Map<string | null, ThreadViewState>()
type EntriesViewState = {
  query: string
  sort: EntrySort
  filter: EntryFilter
  listScrollTop: number
}

let entriesState: EntriesViewState = {
  query: '',
  sort: 'recent',
  filter: 'all',
  listScrollTop: 0
}
const entryScrollTops = new Map<string | null, number>()
let libraryState: { query: string; scrollTop: number; expandedSessions: string[] | null; expandedSets: string[]; aiExpanded: boolean } = { query: '', scrollTop: 0, expandedSessions: null, expandedSets: [], aiExpanded: false }
export type SettingsSection = 'model' | 'reading' | 'appearance' | 'data' | 'about'
let settingsSection: SettingsSection = 'model'

export function threadViewState(threadId: string | null): ThreadViewState {
  return threadStates.get(threadId) ?? { draft: '', scrollTop: null, thinkingOpen: null }
}

export function updateThreadViewState(
  threadId: string | null,
  patch: Partial<ThreadViewState>
): void {
  threadStates.set(threadId, { ...threadViewState(threadId), ...patch })
}

export function clearThreadViewState(threadId: string | null): void {
  threadStates.delete(threadId)
}

export function entriesViewState(): EntriesViewState {
  return entriesState
}

export function updateEntriesViewState(patch: Partial<EntriesViewState>): void {
  entriesState = { ...entriesState, ...patch }
}

export function entryScrollTop(entryId: string | null): number {
  return entryScrollTops.get(entryId) ?? 0
}

export function updateEntryScrollTop(entryId: string | null, scrollTop: number): void {
  entryScrollTops.set(entryId, scrollTop)
}

export function libraryViewState(): Readonly<typeof libraryState> {
  return libraryState
}

export function updateLibraryViewState(patch: Partial<typeof libraryState>): void {
  libraryState = { ...libraryState, ...patch }
}

export function settingsViewSection(): SettingsSection {
  return settingsSection
}

export function updateSettingsViewSection(section: SettingsSection): void {
  settingsSection = section
}
