import { describe, expect, it } from 'vitest'
import type { ChatStartResult, ChatStopResult } from '../../shared/chat'
import type { DictionaryLookup } from '../../shared/dictionary'
import type {
  ChangeMainFormResult,
  CollectSelectionResult,
  DeleteEntrySentenceResult,
  EntryListResult,
  EntryPage,
  EntrySentenceTarget,
  LearningNoteResult,
  MergeEntriesResult,
  MoveEntrySentenceResult,
  ReselectEntrySentenceResult,
  SetEntryLaterResult,
  WordEntryCard
} from '../../shared/entries'
import type { GlobalSearchResults } from '../../shared/global-search'
import type {
  ArticleDeletionPreview,
  ArticleDetail,
  DeleteArticleResult,
  HomeSummary,
  ImportReport,
  LibraryListing,
  LibrarySearchResults,
  MarkArticleCompletedResult,
  RenameArticleResult,
  SaveGeneratedArticleResult
} from '../../shared/library'
import type {
  LearningInstructionList,
  LearningInstructionResult
} from '../../shared/learning-instructions'
import type {
  CreatePinResult,
  DeletePinResult,
  FileAllUnfiledResult,
  PinBoard,
  PinResult,
  PinSourceResult,
  RestorePinsResult
} from '../../shared/pins'
import type {
  ReadingProgressResult,
  ReadingSettingsResult,
  ReadingView
} from '../../shared/reading'
import type { SettingsOverview } from '../../shared/settings'
import type {
  ChatThreadView,
  CreateGroupThreadResult,
  CreateThreadResult,
  ExportThreadResult,
  QuestionResult,
  SaveAnswerResult,
  SwitchThreadResult,
  ThreadContextCandidates,
  ThreadListResult,
  UpdateThreadContextResult
} from '../../shared/threads'
import type { AppBootstrap } from '../../shared/types'
import type { ArticleWordsView } from '../../shared/article-words'
import type { NavCounts } from '../../shared/counts'
import { IPC_CHANNELS } from '../../shared/ipc-contract'
import {
  registerIpcHandlers,
  type IpcHandlers,
  type IpcInvokeEvent,
  type IpcMainLike
} from './register'

const bootstrap: AppBootstrap = {
  appVersion: '0.1.0',
  isPackaged: false,
  schemaVersion: 3,
  theme: 'light',
  sidebarCollapsed: false,
  chatModel: 'deepseek-flash',
  corpusImport: { total: 0, imported: 0, updated: 0, skipped: 0, failed: [] }
}

function fakeIpcMain(): {
  ipc: IpcMainLike
  registered: Map<string, (event: unknown, payload: unknown) => unknown>
} {
  const registered = new Map<string, (event: unknown, payload: unknown) => unknown>()
  const ipc: IpcMainLike = {
    handle(channel, listener) {
      registered.set(channel, listener)
    }
  }
  return { ipc, registered }
}

function chatHandlers() {
  const missingQuestion = (): QuestionResult => ({ status: 'missing' })
  return {
    'chat:start': (): ChatStartResult => ({ accepted: true }),
    'chat:stop': (): ChatStopResult => ({ stopped: false }),
    'chat:list': (): ThreadListResult => ({ threads: [] }),
    'chat:thread': (): ChatThreadView | null => null,
    'chat:create': (): CreateThreadResult => ({ status: 'rejected', reason: 'missing-main' }),
    'chat:create-group': (): CreateGroupThreadResult => ({
      status: 'rejected',
      reason: 'empty'
    }),
    'chat:delete': () => ({ status: 'missing' as const }),
    'chat:find-for-main': (): ChatThreadView | null => null,
    'chat:open-for-main': (): CreateThreadResult => ({ status: 'rejected', reason: 'missing-main' }),
    'chat:ask': missingQuestion,
    'chat:edit-question': missingQuestion,
    'chat:answer': (): SaveAnswerResult => ({ status: 'missing' }),
    'chat:continue': (): SaveAnswerResult => ({ status: 'missing' }),
    'chat:context': (): UpdateThreadContextResult => ({ status: 'missing' }),
    'chat:candidates': (): ThreadContextCandidates => ({ items: [], articles: [], libraryItems: [] }),
    'chat:article-context': () => ({ article: null, paragraphs: [] }),
    'chat:switch-question': (): SwitchThreadResult => ({ status: 'missing' }),
    'chat:switch-answer': (): SwitchThreadResult => ({ status: 'missing' }),
    'chat:export-jsonl': (): ExportThreadResult => ({ status: 'missing' })
  }
}

function libraryHandlers() {
  return {
    'home:summary': (): HomeSummary => ({
      library: { articleCount: 0, sessionCount: 0 },
      continueReading: null,
      completedArticleCount: 0,
      recentEntries: [],
      laterEntries: []
    }),
    'library:list': (): LibraryListing => ({
      articleCount: 0,
      sessionCount: 0,
      sessions: [],
      aiArticles: []
    }),
    'library:reimport': (): ImportReport => ({
      total: 0,
      imported: 0,
      updated: 0,
      skipped: 0,
      failed: []
    }),
    'library:detail': (): ArticleDetail | null => null,
    'library:search': (payload: { query: string }): LibrarySearchResults => ({
      query: payload.query,
      results: []
    }),
    'library:rename': (payload: { articleId: string; title: string }): RenameArticleResult => ({
      status: 'renamed',
      articleId: payload.articleId,
      title: payload.title
    }),
    'library:delete-preview': (): ArticleDeletionPreview | null => null,
    'library:delete': (): DeleteArticleResult => ({ status: 'missing' }),
    'library:save-generated': (): SaveGeneratedArticleResult => ({ status: 'missing' })
  }
}

function searchHandlers() {
  return {
    'search:global': (payload: { query: string }): GlobalSearchResults => ({
      query: payload.query,
      entries: [],
      articles: []
    }),
    'search:shortcuts': () => ({ recentArticles: [], recentEntries: [] })
  }
}

function readingHandlers() {
  return {
    'reading:open': (): ReadingView | null => null,
    'reading:words': (): ArticleWordsView | null => null,
    'reading:complete': (): MarkArticleCompletedResult => ({ status: 'missing' }),
    'reading:progress': (): ReadingProgressResult => ({ saved: false }),
    'reading:settings': (): ReadingSettingsResult | null => null,
    'reading:collect': (): CollectSelectionResult => ({
      status: 'rejected',
      reason: 'article'
    })
  }
}

function entriesHandlers() {
  const missingNote = (): LearningNoteResult => ({ status: 'missing' })
  return {
    'entries:card': (): WordEntryCard | null => null,
    'entries:delete-sentence': (): DeleteEntrySentenceResult => ({ status: 'missing' }),
    'entries:list': (): EntryListResult => ({ total: 0, entries: [] }),
    'entries:page': (): EntryPage | null => null,
    'entries:sentence': (): EntrySentenceTarget | null => null,
    'entries:merge': (): MergeEntriesResult => ({ status: 'missing' }),
    'entries:main-form': (): ChangeMainFormResult => ({ status: 'missing' }),
    'entries:move-sentence': (): MoveEntrySentenceResult => ({ status: 'missing' }),
    'entries:reselect-sentence': (): ReselectEntrySentenceResult => ({ status: 'missing' }),
    'entries:later': (): SetEntryLaterResult => ({ status: 'missing' }),
    'entries:create-note': missingNote,
    'entries:update-note': missingNote,
    'entries:pin-note': missingNote,
    'entries:delete-note': missingNote,
    'entries:move-note': missingNote
  }
}

function instructionsHandlers() {
  return {
    'instructions:list': (): LearningInstructionList => ({ instructions: [] }),
    'instructions:create': (): LearningInstructionResult => ({
      status: 'rejected',
      reason: 'empty-name'
    }),
    'instructions:update': (): LearningInstructionResult => ({ status: 'missing' }),
    'instructions:copy': (): LearningInstructionResult => ({ status: 'missing' }),
    'instructions:delete': (): LearningInstructionResult => ({ status: 'missing' })
  }
}

function dictionaryHandlers() {
  return {
    'dictionary:lookup': (payload: { word: string }): DictionaryLookup => ({
      status: 'missing',
      query: payload.word.toLowerCase()
    })
  }
}

function pinsHandlers() {
  return {
    'pins:create': (): CreatePinResult => ({ status: 'rejected', reason: 'thread' }),
    'pins:board': (): PinBoard => ({
      threadId: null,
      threadPins: [],
      unfiledPins: [],
      unfiledCount: 0
    }),
    'pins:move': (): PinResult => ({ status: 'missing' }),
    'pins:delete': (): DeletePinResult => ({ status: 'missing' }),
    'pins:file-all': (): FileAllUnfiledResult => ({ status: 'filed', filed: [] }),
    'pins:restore': (): RestorePinsResult => ({ status: 'restored', pins: [] }),
    'pins:source': (): PinSourceResult => null
  }
}

const settingsOverview: SettingsOverview = {
  providers: [],
  activeProviderId: null,
  defaultModelRowId: null,
  activeModel: '',
  reading: {
    fontSize: 20,
    lineHeight: 1.8,
    annotationsVisible: true,
    weakHighlight: true
  },
  theme: 'light',
  appVersion: '0.1.0',
  electronVersion: '45.0.0',
  dataDirectory: 'C:/data',
  lastBackup: null,
  lastSnapshot: null,
  backupDirectory: 'C:/data/backups',
  snapshotDirectory: 'C:/data/snapshots'
}

function uiHandlers() {
  return {
    'ui:preferences': () => ({ sidebarCollapsed: false }),
    'ui:sidebar': (payload: { collapsed: boolean }) => ({
      saved: true,
      collapsed: payload.collapsed
    })
  }
}

function settingsHandlers() {
  return {
    'settings:overview': (): SettingsOverview => settingsOverview,
    'settings:provider-add': () => ({
      status: 'saved' as const,
      providerId: 'provider-1',
      providerKey: 'deepseek'
    }),
    'settings:provider-create': () => ({
      status: 'saved' as const,
      providerId: 'provider-2',
      providerKey: 'my-relay'
    }),
    'settings:provider-update': () => ({ status: 'saved' as const }),
    'settings:provider-model-add': () => ({ status: 'saved' as const }),
    'settings:provider-model-update': () => ({ status: 'saved' as const }),
    'settings:provider-model-delete': () => ({ status: 'deleted' as const }),
    'settings:provider-model-reorder': () => ({ status: 'saved' as const }),
    'settings:provider-default-model': () => ({
      status: 'saved' as const,
      defaultModelRowId: 'model-1'
    }),
    'settings:provider-activate': () => ({
      status: 'activated' as const,
      activeProviderId: 'provider-1'
    }),
    'settings:provider-delete': () => ({
      status: 'deleted' as const,
      activeCleared: false
    }),
    'settings:provider-credential': () => ({
      status: 'saved' as const,
      authMode: 'stored' as const,
      clearedStored: false
    }),
    'settings:provider-models-fetch': () => ({
      status: 'fetched' as const,
      candidates: []
    }),
    'settings:provider-test': () => ({
      status: 'verified' as const,
      checkedAt: '2026-11-21T00:00:00.000Z',
      persisted: true
    }),
    'settings:reading-save': () => ({
      saved: true,
      preferences: settingsOverview.reading
    }),
    'settings:theme-save': () => ({ saved: true, theme: 'light' as const }),
    'settings:backup-create': () => ({
      status: 'cancelled' as const,
      overview: settingsOverview
    }),
    'settings:restore-pick': () => ({ status: 'cancelled' as const }),
    'settings:restore': () => ({
      status: 'rejected' as const,
      reason: 'missing' as const,
      overview: settingsOverview
    }),
    'settings:open-data-directory': () => ({ opened: true, path: 'C:/data' })
  }
}

describe('registerIpcHandlers', () => {
  it('按契约注册每个 channel，调用时转给对应处理函数并传入调用事件', () => {
    const { ipc, registered } = fakeIpcMain()
    const received: unknown[] = []
    const events: IpcInvokeEvent[] = []

    registerIpcHandlers(ipc, {
      ...chatHandlers(),
      ...libraryHandlers(),
      ...searchHandlers(),
      ...readingHandlers(),
      ...entriesHandlers(),
      ...instructionsHandlers(),
      ...pinsHandlers(),
      ...dictionaryHandlers(),
      ...settingsHandlers(),
      ...uiHandlers(),
      'app:bootstrap': (payload, event) => {
        received.push(payload)
        events.push(event)
        return bootstrap
      },
      'counts:summary': (): NavCounts => ({ entries: 0, articles: 0, unfiled: 0 })
    })

    expect([...registered.keys()].sort()).toEqual([...IPC_CHANNELS].sort())
    const listener = registered.get('app:bootstrap')
    expect(listener).toBeDefined()
    const event: IpcInvokeEvent = { sender: { send() {} } }
    expect(listener?.(event, undefined)).toEqual(bootstrap)
    expect(received).toEqual([undefined])
    expect(events).toEqual([event])
  })

  it('模型服务写入只走 provider 表：自定义创建与模型 CRUD 都在契约里；获取模型与显式测试连接都已接入', () => {
    expect(IPC_CHANNELS).toContain('settings:overview')
    expect(IPC_CHANNELS).toEqual(
      expect.arrayContaining([
        'settings:provider-add',
        'settings:provider-create',
        'settings:provider-update',
        'settings:provider-model-add',
        'settings:provider-model-update',
        'settings:provider-model-delete',
        'settings:provider-model-reorder',
        'settings:provider-default-model',
        'settings:provider-activate',
        'settings:provider-delete',
        'settings:provider-credential',
        'settings:provider-models-fetch',
        'settings:provider-test'
      ])
    )
    expect(
      IPC_CHANNELS.filter((channel) => channel.startsWith('settings:profile-'))
    ).toEqual([])
  })

  it('界面偏好读写进入契约，启动值带侧栏折叠状态', () => {
    expect(IPC_CHANNELS).toEqual(
      expect.arrayContaining(['ui:preferences', 'ui:sidebar', 'search:shortcuts'])
    )
    expect(bootstrap.sidebarCollapsed).toBe(false)
  })

  it('契约里的 channel 没有处理函数时启动即报错', () => {    const { ipc } = fakeIpcMain()

    expect(() =>
      registerIpcHandlers(ipc, { ...chatHandlers() } as unknown as IpcHandlers)
    ).toThrow(/app:bootstrap/)
  })

  it('出现契约之外的 channel 时启动即报错', () => {
    const { ipc } = fakeIpcMain()
    const handlers = {
      ...chatHandlers(),
      ...libraryHandlers(),
      ...searchHandlers(),
      ...readingHandlers(),
      ...entriesHandlers(),
      ...instructionsHandlers(),
      ...pinsHandlers(),
      ...dictionaryHandlers(),
      ...settingsHandlers(),
      ...uiHandlers(),
      'app:bootstrap': () => bootstrap,
      'counts:summary': (): NavCounts => ({ entries: 0, articles: 0, unfiled: 0 }),
      'app:not-in-contract': () => bootstrap
    } as unknown as IpcHandlers

    expect(() => registerIpcHandlers(ipc, handlers)).toThrow(/app:not-in-contract/)
  })
})
