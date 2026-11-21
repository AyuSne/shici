import type { DictionaryLookup } from '../../shared/dictionary'
import type { ArticleWordsView } from '../../shared/article-words'
import type { GlobalSearchResults } from '../../shared/global-search'
import type {
  ArticleDeletionPreview,
  ArticleDetail,
  DeleteArticleRequest,
  DeleteArticleResult,
  HomeSummary,
  ImportReport,
  LibraryListing,
  LibrarySearchResults,
  MarkArticleCompletedResult,
  RenameArticleRequest,
  RenameArticleResult,
  SaveGeneratedArticleRequest,
  SaveGeneratedArticleResult
} from '../../shared/library'
import type {
  CopyLearningInstructionRequest,
  CreateLearningInstructionRequest,
  DeleteLearningInstructionRequest,
  LearningInstructionList,
  LearningInstructionResult,
  UpdateLearningInstructionRequest
} from '../../shared/learning-instructions'
import type {
  ChangeMainFormRequest,
  ChangeMainFormResult,
  CollectSelectionRequest,
  CollectSelectionResult,
  CreateLearningNoteRequest,
  DeleteEntrySentenceResult,
  EntryListRequest,
  EntryListResult,
  EntryPage,
  EntrySentenceTarget,
  LearningNoteResult,
  MergeEntriesRequest,
  MergeEntriesResult,
  MoveEntrySentenceRequest,
  MoveEntrySentenceResult,
  MoveLearningNoteRequest,
  PinLearningNoteRequest,
  ReselectEntrySentenceRequest,
  ReselectEntrySentenceResult,
  SetEntryLaterRequest,
  SetEntryLaterResult,
  UpdateLearningNoteRequest,
  WordEntryCard
} from '../../shared/entries'
import type {
  CreatePinRequest,
  CreatePinResult,
  DeletePinResult,
  FileAllUnfiledRequest,
  FileAllUnfiledResult,
  MovePinRequest,
  PinBoard,
  PinResult,
  PinSourceResult,
  RestorePinsRequest,
  RestorePinsResult
} from '../../shared/pins'
import type {
  ReadingPreferences,
  ReadingProgressRequest,
  ReadingProgressResult,
  ReadingPreferencesResult,
  ReadingSettingsRequest,
  ReadingSettingsResult,
  ReadingView
} from '../../shared/reading'
import type {
  CreateBackupResult,
  OpenDataDirectoryResult,
  PickRestoreResult,
  RestoreBackupResult,
  SaveThemeResult,
  SettingsOverview
} from '../../shared/settings'
import type {
  ActivateProviderRequest,
  ActivateProviderResult,
  AddBuiltinProviderRequest,
  AddBuiltinProviderResult,
  AddProviderModelRequest,
  CreateCustomProviderRequest,
  CreateCustomProviderResult,
  DeleteProviderModelRequest,
  DeleteProviderRequest,
  DeleteProviderResult,
  ProviderModelWriteResult,
  ReorderProviderModelsRequest,
  SetDefaultProviderModelRequest,
  SetDefaultProviderModelResult,
  UpdateProviderModelRequest,
  UpdateProviderRequest,
  UpdateProviderResult
} from '../../shared/model-providers'
import type {
  UpdateProviderCredentialRequest,
  UpdateProviderCredentialResult
} from '../../shared/provider-credentials'
import type {
  FetchProviderModelsRequest,
  FetchProviderModelsResult
} from '../../shared/model-discovery'
import type {
  ProviderTestRequest,
  ProviderTestResult
} from '../../shared/provider-test'
import type {
  AskThreadRequest,
  ChatThreadView,
  CreateThreadRequest,
  CreateThreadResult,
  DeleteThreadResult,
  EditQuestionRequest,
  ExportThreadResult,
  OpenThreadForMainRequest,
  OpenThreadForMainResult,
  QuestionResult,
  SaveAnswerRequest,
  SaveAnswerResult,
  SaveContinuationRequest,
  SwitchAnswerRequest,
  SwitchQuestionRequest,
  SwitchThreadResult,
  ThreadContextCandidates,
  ThreadListResult,
  UpdateThreadContextRequest,
  UpdateThreadContextResult
} from '../../shared/threads'
import type {
  CreateGroupThreadRequest,
  CreateGroupThreadResult
} from '../../shared/threads'
import type { AppBootstrap, ThemePreference } from '../../shared/types'
import type { IpcChannel, IpcContract } from '../../shared/ipc-contract'
import { affectsNavCounts, type NavCounts } from '../../shared/counts'
import { notifyNavCountsChanged } from './nav-counts/invalidation'

/**
 * 渲染层访问主进程的统一边界。会改变全局栏计数的写操作在成功返回后
 * 发一次失效信号；读操作、失败的写都不发。计数自己的读取也走这里，
 * 但它不在失效表里，所以不会自激重查。
 */
async function invoke<C extends IpcChannel>(
  channel: C,
  payload?: IpcContract[C]['payload']
): Promise<IpcContract[C]['result']> {
  const result = await window.api.invoke(channel, payload)
  if (affectsNavCounts(channel)) notifyNavCountsChanged()
  return result
}

export function loadBootstrap(): Promise<AppBootstrap> {
  return invoke('app:bootstrap')
}

/**
 * 左侧全局栏的词条数、文章数与未归档数。独立一条轻查询：
 * 首屏与导航不 await 它，读回来之前界面不显示数字。
 */
export function loadNavCounts(): Promise<NavCounts> {
  return invoke('counts:summary')
}

export function loadHomeSummary(): Promise<HomeSummary> {
  return invoke('home:summary')
}

export function loadLibrary(): Promise<LibraryListing> {
  return invoke('library:list')
}

/** 再对一遍随包语料：失败的那几篇修好后不必重启应用。 */
export function reimportCorpus(): Promise<ImportReport> {
  return invoke('library:reimport')
}

export function loadArticleDetail(articleId: string): Promise<ArticleDetail | null> {
  return invoke('library:detail', { articleId })
}

export function searchLibrary(query: string): Promise<LibrarySearchResults> {
  return invoke('library:search', { query })
}

/** 全局搜索：一次查询同时给出词条与文章两组命中；只读，不触发全局栏计数失效。 */
export function searchEverything(query: string): Promise<GlobalSearchResults> {
  return invoke('search:global', { query })
}

/** 只改文章显示名；语料刷新后仍沿用这个名字。 */
export function renameArticle(request: RenameArticleRequest): Promise<RenameArticleResult> {
  return invoke('library:rename', request)
}

/** 删除前的影响面：原句关联、受影响/消失词条、学习内容与挂在本篇的钉住。 */
export function loadArticleDeletionPreview(
  articleId: string
): Promise<ArticleDeletionPreview | null> {
  return invoke('library:delete-preview', { articleId })
}

/** 删除文章；请求带上确认弹层看到的那份影响面，变了主进程会拒绝并带回最新一份。 */
export function deleteArticle(request: DeleteArticleRequest): Promise<DeleteArticleResult> {
  return invoke('library:delete', request)
}

/** 存为文章：把当前这一版已完成的回答存成生成文章，正文与来源由主进程读。 */
export function saveGeneratedArticle(
  request: SaveGeneratedArticleRequest
): Promise<SaveGeneratedArticleResult> {
  return invoke('library:save-generated', request)
}

/** 打开一篇文章：换回正文、生效设置与上次读到的位置，同时记下「最近打开」。 */
export function openReadingView(articleId: string): Promise<ReadingView | null> {
  return invoke('reading:open', { articleId })
}

/**
 * 一篇文章的「本篇选词」：按段落列出实际收下的词条与原句。
 * 纯查询，不写完成时间、不记最近打开、不改阅读位置与本篇阅读设置。
 */
export function loadArticleWords(articleId: string): Promise<ArticleWordsView | null> {
  return invoke('reading:words', { articleId })
}

/**
 * 显式标记这一篇已读完：只写完成时间、只写一次。进入本篇选词的页面先发这条命令，
 * 再读视图；命令失败就报错重试，不拿乐观的 100% 冒充已读完。
 */
export function completeArticleReading(
  articleId: string
): Promise<MarkArticleCompletedResult> {
  return invoke('reading:complete', { articleId })
}

/** 记下读到哪一段、哪一句。 */
export function saveReadingPoint(request: ReadingProgressRequest): Promise<ReadingProgressResult> {
  return invoke('reading:progress', request)
}

/** 记住这一篇的字号、行距与注释开关。 */
export function saveReadingSettings(
  request: ReadingSettingsRequest
): Promise<ReadingSettingsResult | null> {
  return invoke('reading:settings', request)
}

/** 收下一次选词：当场建原句、归词条，并拿回这一篇最新的标记。 */
export function collectSelection(
  request: CollectSelectionRequest
): Promise<CollectSelectionResult> {
  return invoke('reading:collect', request)
}

/** 查内置离线词典：不联网、不调用模型。 */
export function lookupDictionary(word: string): Promise<DictionaryLookup> {
  return invoke('dictionary:lookup', { word })
}

/** 点开一个已收集的词，读它的词条卡与原句。 */
export function loadWordEntryCard(entryId: string): Promise<WordEntryCard | null> {
  return invoke('entries:card', { entryId })
}

/** 删掉一条原句；词条只剩这一条时连词条一起删。 */
export function deleteEntrySentence(entrySentenceId: string): Promise<DeleteEntrySentenceResult> {
  return invoke('entries:delete-sentence', { entrySentenceId })
}

/** 词条页左栏：计数、搜索、排序与筛选。 */
export function loadEntryList(request: EntryListRequest): Promise<EntryListResult> {
  return invoke('entries:list', request)
}

/** 词条页的一整页：主词形、按文章分组的原句与学习内容。 */
export function loadEntryPage(entryId: string): Promise<EntryPage | null> {
  return invoke('entries:page', { entryId })
}

/** 阅读页从词条跳过来时要定位的原句。 */
export function loadEntrySentenceTarget(
  entrySentenceId: string
): Promise<EntrySentenceTarget | null> {
  return invoke('entries:sentence', { entrySentenceId })
}

/** 合并两个词条，源词条的原句与学习内容迁到目标。 */
export function mergeEntries(request: MergeEntriesRequest): Promise<MergeEntriesResult> {
  return invoke('entries:merge', request)
}

/** 换主词形，只能从已收集的词形里选。 */
export function changeEntryMainForm(
  request: ChangeMainFormRequest
): Promise<ChangeMainFormResult> {
  return invoke('entries:main-form', request)
}

/** 把一条原句拆到别的词条或新词条。 */
export function moveEntrySentence(
  request: MoveEntrySentenceRequest
): Promise<MoveEntrySentenceResult> {
  return invoke('entries:move-sentence', request)
}

/** 重新圈定原句范围。 */
export function reselectEntrySentence(
  request: ReselectEntrySentenceRequest
): Promise<ReselectEntrySentenceResult> {
  return invoke('entries:reselect-sentence', request)
}

/** 标记或取消「稍后看」；只改独立标记，不新建词条、不动收集。 */
export function setEntryLater(
  request: SetEntryLaterRequest
): Promise<SetEntryLaterResult> {
  return invoke('entries:later', request)
}

export function createLearningNote(
  request: CreateLearningNoteRequest
): Promise<LearningNoteResult> {
  return invoke('entries:create-note', request)
}

export function updateLearningNote(
  request: UpdateLearningNoteRequest
): Promise<LearningNoteResult> {
  return invoke('entries:update-note', request)
}

export function pinLearningNote(request: PinLearningNoteRequest): Promise<LearningNoteResult> {
  return invoke('entries:pin-note', request)
}

export function deleteLearningNote(noteId: string): Promise<LearningNoteResult> {
  return invoke('entries:delete-note', { noteId })
}

export function moveLearningNote(request: MoveLearningNoteRequest): Promise<LearningNoteResult> {
  return invoke('entries:move-note', request)
}

/** 已保存的学习指令，按更新时间倒序；六条内置示例不走这张表。 */
export function loadLearningInstructions(): Promise<LearningInstructionList> {
  return invoke('instructions:list')
}

/** 把当前输入存成一条命名指令。 */
export function createLearningInstruction(
  request: CreateLearningInstructionRequest
): Promise<LearningInstructionResult> {
  return invoke('instructions:create', request)
}

/** 同时改名称与正文；创建时间不动。 */
export function updateLearningInstruction(
  request: UpdateLearningInstructionRequest
): Promise<LearningInstructionResult> {
  return invoke('instructions:update', request)
}

/** 复制成一条独立的新指令，之后互不影响。 */
export function copyLearningInstruction(
  request: CopyLearningInstructionRequest
): Promise<LearningInstructionResult> {
  return invoke('instructions:copy', request)
}

/** 真删一条自己保存的指令。 */
export function deleteLearningInstruction(
  request: DeleteLearningInstructionRequest
): Promise<LearningInstructionResult> {
  return invoke('instructions:delete', request)
}

/** 左栏线程列表。 */
export function loadThreads(): Promise<ThreadListResult> {
  return invoke('chat:list')
}

/** 打开一条线程：主对象、上下文与这一路的对话。 */
export function loadThread(threadId: string): Promise<ChatThreadView | null> {
  return invoke('chat:thread', { threadId })
}

export function deleteThread(threadId: string): Promise<DeleteThreadResult> {
  return invoke('chat:delete', { threadId })
}

/** 按主对象开一条线程：词条 / 原句 / 文章 / 不挂。 */
export function createThread(request: CreateThreadRequest): Promise<CreateThreadResult> {
  return invoke('chat:create', request)
}

/** 「用这些词学习」：一次选中的词开一条新线程，主对象为空。 */
export function createGroupThread(
  request: CreateGroupThreadRequest
): Promise<CreateGroupThreadResult> {
  return invoke('chat:create-group', request)
}

/** 按主对象复用最近线程，或明确新开一条。 */
export function openThreadForMainRequest(request: OpenThreadForMainRequest): Promise<OpenThreadForMainResult> {
  return invoke('chat:open-for-main', request)
}

/** 提一个新问题，回答稍后由 chat:answer 落库。 */
export function askThread(request: AskThreadRequest): Promise<QuestionResult> {
  return invoke('chat:ask', request)
}

/** 改上一条提问：新提问走新分支，旧回答保留可切回。 */
export function editThreadQuestion(request: EditQuestionRequest): Promise<QuestionResult> {
  return invoke('chat:edit-question', request)
}

/** 一次生成结束时把回答写成新版本。 */
export function saveThreadAnswer(request: SaveAnswerRequest): Promise<SaveAnswerResult> {
  return invoke('chat:answer', request)
}

/** 继续生成接在当前回答这一路的最后一段后面。 */
export function saveThreadContinuation(
  request: SaveContinuationRequest
): Promise<SaveAnswerResult> {
  return invoke('chat:continue', request)
}

/** 整体替换这一路对话带上的学习上下文。 */
export function updateThreadContext(
  request: UpdateThreadContextRequest
): Promise<UpdateThreadContextResult> {
  return invoke('chat:context', request)
}

/** 这次还能往上下文里加什么。 */
export function loadThreadContextCandidates(
  threadId: string
): Promise<ThreadContextCandidates> {
  return invoke('chat:candidates', { threadId })
}

/** 切到另一提问版本，整支回答跟着换。 */
export function switchThreadQuestion(
  request: SwitchQuestionRequest
): Promise<SwitchThreadResult> {
  return invoke('chat:switch-question', request)
}

/** 切到另一回答版本。 */
export function switchThreadAnswer(request: SwitchAnswerRequest): Promise<SwitchThreadResult> {
  return invoke('chat:switch-answer', request)
}

/** 把一条线程导出成 JSONL；主进程弹保存对话框并写文件。 */
export function exportThreadJsonl(threadId: string): Promise<ExportThreadResult> {
  return invoke('chat:export-jsonl', { threadId })
}

/* ---------- 钉住与钉板 ---------- */

/** 选中一段回答钉住；落点来自主对象推导或用户手动改过。 */
export function createPin(request: CreatePinRequest): Promise<CreatePinResult> {
  return invoke('pins:create', request)
}

/** 钉板：这条线程已归位的 + 全局未归档。 */
export function loadPinBoard(threadId: string | null): Promise<PinBoard> {
  return invoke('pins:board', { threadId })
}

/** 改一条钉住的落点（移动，不复制）。 */
export function movePin(request: MovePinRequest): Promise<PinResult> {
  return invoke('pins:move', request)
}

/** 真删一条钉住；落到词条时连学习内容一起删。 */
export function deletePin(pinId: string): Promise<DeletePinResult> {
  return invoke('pins:delete', { pinId })
}

/** 未归档全部归到一个落点。 */
export function fileAllUnfiled(request: FileAllUnfiledRequest): Promise<FileAllUnfiledResult> {
  return invoke('pins:file-all', request)
}

/** 撤销丢弃：按快照把钉住放回去。 */
export function restorePins(request: RestorePinsRequest): Promise<RestorePinsResult> {
  return invoke('pins:restore', request)
}

/** 从学习内容点「来源」：拿到线程与这条回答在不在当前分支。 */
export function loadPinSource(pinId: string): Promise<PinSourceResult> {
  return invoke('pins:source', { pinId })
}

/* ---------- 设置 ---------- */

/** 设置页一次读全：只读 provider 列表、阅读默认、主题、版本与数据目录。 */
export function loadSettingsOverview(): Promise<SettingsOverview> {
  return invoke('settings:overview')
}

/** 从内置目录添加一套提供商；保存不联网，密钥只写不读。 */
export function addBuiltinProvider(
  request: AddBuiltinProviderRequest
): Promise<AddBuiltinProviderResult> {
  return invoke('settings:provider-add', request)
}

/** 从「自定义 API」入口创建一套 provider；至少要带一个模型。 */
export function createCustomProvider(
  request: CreateCustomProviderRequest
): Promise<CreateCustomProviderResult> {
  return invoke('settings:provider-create', request)
}

/** 只改显示名与地址；Provider ID 与协议创建后不可改。 */
export function updateProvider(
  request: UpdateProviderRequest
): Promise<UpdateProviderResult> {
  return invoke('settings:provider-update', request)
}

/** 手加一条模型行；目录外的 ID 也允许。 */
export function addProviderModel(
  request: AddProviderModelRequest
): Promise<ProviderModelWriteResult> {
  return invoke('settings:provider-model-add', request)
}

/** 改模型行的 ID、显示名与容量。 */
export function updateProviderModel(
  request: UpdateProviderModelRequest
): Promise<ProviderModelWriteResult> {
  return invoke('settings:provider-model-update', request)
}

/** 删一条模型行：默认模型与最后一条会被主进程拒绝。 */
export function deleteProviderModel(
  request: DeleteProviderModelRequest
): Promise<ProviderModelWriteResult> {
  return invoke('settings:provider-model-delete', request)
}

/** 保存完整模型顺序；缺行或过期顺序会被拒绝。 */
export function reorderProviderModels(
  request: ReorderProviderModelsRequest
): Promise<ProviderModelWriteResult> {
  return invoke('settings:provider-model-reorder', request)
}

/** 选这个 provider 的默认模型；模型行的增删改由上面的独立 channel 处理。 */
export function setDefaultProviderModel(
  request: SetDefaultProviderModelRequest
): Promise<SetDefaultProviderModelResult> {
  return invoke('settings:provider-default-model', request)
}

/** 切换使用中的提供商：只写选择，之后的调用才用它。 */
export function activateProvider(
  request: ActivateProviderRequest
): Promise<ActivateProviderResult> {
  return invoke('settings:provider-activate', request)
}

/** 删除提供商；删到使用中的那套时选择会被明确清空。 */
export function deleteProvider(
  request: DeleteProviderRequest
): Promise<DeleteProviderResult> {
  return invoke('settings:provider-delete', request)
}

/**
 * 编辑一套 provider 的密钥来源：本机 / 环境变量、变量名、新密钥，
 * 以及从本机切到环境时清除已存密文的显式确认。
 */
export function updateProviderCredential(
  request: UpdateProviderCredentialRequest
): Promise<UpdateProviderCredentialResult> {
  return invoke('settings:provider-credential', request)
}

/**
 * 获取可用模型：请求带表单当前地址/协议/凭据草稿，只读返回候选。
 * 内置目录身份零 HTTP；勾选结果由调用方自己保存，本调用不写库。
 */
export function fetchProviderModels(
  request: FetchProviderModelsRequest
): Promise<FetchProviderModelsResult> {
  return invoke('settings:provider-models-fetch', request)
}

/**
 * 显式的「测试连接」：按 provider 自己的协议发一次最小请求。
 * 成功转已验证；失败保留原配置与原密钥，并带回原因与 request id。
 */
export function testProviderConnection(
  request: ProviderTestRequest
): Promise<ProviderTestResult> {
  return invoke('settings:provider-test', request)
}

/** 改全局阅读默认；单篇覆盖不受影响。 */
export function saveReadingPreferences(
  preferences: ReadingPreferences
): Promise<ReadingPreferencesResult> {
  return invoke('settings:reading-save', { preferences })
}

/** 浅色 / 深色 / 跟随系统。 */
export function saveTheme(theme: ThemePreference): Promise<SaveThemeResult> {
  return invoke('settings:theme-save', { theme })
}

export function openDataDirectory(): Promise<OpenDataDirectoryResult> {
  return invoke('settings:open-data-directory')
}

/** 一键备份：主进程弹保存对话框，把整库副本写到选定位置。 */
export function createBackup(): Promise<CreateBackupResult> {
  return invoke('settings:backup-create')
}

/** 从备份恢复第一步：选文件，并看清版本与时间。 */
export function pickRestoreFile(): Promise<PickRestoreResult> {
  return invoke('settings:restore-pick')
}

/** 从备份恢复第二步：确认后整体替换，替换前自动留快照。 */
export function restoreBackup(file: string): Promise<RestoreBackupResult> {
  return invoke('settings:restore', { file })
}
