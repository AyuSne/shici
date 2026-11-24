/**
 * 文章库与首页「继续阅读」的跨层类型。渲染层只读这些结构，不自己拼 SQL。
 */

import type { EntryListItem } from './entries'

export type ArticleKind = 'long_match' | 'careful_reading'

/**
 * 文章来源：随包真题与保存下来的生成文章。它与 `ArticleKind` 是两个概念——
 * 生成文章仍然是一种阅读文章（kind 按正文形态取仔细阅读，因此不显示段字母），
 * 来源只决定分组、标识与详情里显不显示来源词。旧库里的文章没有来源列，读作真题。
 */
export type ArticleSourceType = 'exam' | 'ai'

/**
 * 生成文章的一条来源词。`mainForm` 是读详情时词条的当前主词形；
 * 词条后来被删掉时为 null——界面显示成不可点的「词条已删除」，不做死链接。
 */
export type ArticleSourceWord = {
  entryId: string
  mainForm: string | null
}

/** 篇名上限：服务端校验与输入框的 maxLength 共用这一份。 */
export const ARTICLE_TITLE_MAX_LENGTH = 200

/**
 * 阅读进度：没打开过是 unread；打开过就按已到的句子算百分比；进入「本篇选词」
 * 时发出的显式完成命令会写完成时间，给 completed 与 100%。读到末句也只停在 99%——
 * 「读完」只由那条命令写，查询本身不写。
 */
export type ReadingProgress = {
  state: 'unread' | 'reading' | 'completed'
  /** 0–100；unread 时为 0，reading 为 1–99，completed 为 100。 */
  percent: number
}

/**
 * 显式标记「读完」的结果。这条命令只写完成时间、只写一次；返回 `changed` 让调用方
 * 知道这次是否真的落库，但界面仍以重新读出的文章进度为准，不做乐观的假 100%。
 */
export type MarkArticleCompletedResult =
  | { status: 'completed'; articleId: string; completedAt: string; changed: boolean }
  | { status: 'missing' }

export type LibraryArticle = {
  id: string
  /** 完整篇名，形如「2024年6月 · 第1套 · 仔细阅读 Passage One」。 */
  title: string
  kind: ArticleKind
  /** 真题还是保存下来的生成文章。 */
  sourceType: ArticleSourceType
  /** 题型文字：长篇匹配 / 仔细阅读 Passage One / 仔细阅读 Passage Two / AI 生成。 */
  kindLabel: string
  sessionLabel: string
  setLabel: string
  wordCount: number
  progress: ReadingProgress
  /** ISO 8601 UTC，形如 2026-11-18T08:00:00.000Z。 */
  lastOpenedAt: string | null
}

export type LibrarySet = {
  id: number
  label: string
  articles: LibraryArticle[]
}

export type LibrarySession = {
  /** 场次键，形如 2024-06。 */
  id: string
  label: string
  sets: LibrarySet[]
}

export type LibrarySize = {
  articleCount: number
  sessionCount: number
}

export type LibraryListing = LibrarySize & {
  /** 真题按场次分组；生成文章不占场次。 */
  sessions: LibrarySession[]
  /** 保存下来的生成文章，最近保存的在前；不进入 sessions，也不增加场次数。 */
  aiArticles: LibraryArticle[]
}

export type LibrarySearchResult = {
  article: LibraryArticle
  matched: 'title' | 'body'
  /** 命中处前后一小段正文；命中篇名时就是篇名。 */
  snippet: string
}

export type LibrarySearchResults = {
  query: string
  results: LibrarySearchResult[]
}

export type ArticleDetail = LibraryArticle & {
  paragraphCount: number
  sentenceCount: number
  /** 这一篇收下的不同词条数（不是原句条数）。 */
  wordEntryCount: number
  /** 这一篇收下的原句条数。 */
  collectedSentenceCount: number
  /** 形如「第 7–8 页」；没有页码时为空串。 */
  pages: string
  /** 生成文章保存时的来源词；真题为空数组。词条删掉后 mainForm 为 null。 */
  sourceWords: ArticleSourceWord[]
}

/**
 * 「存为文章」：只传线程、当前显示的回答版本与可选篇名，正文与来源都由主进程
 * 从已存条目日志读，不接受渲染层传来的任意正文。保存整次回答（根回答 + 继续生成），
 * 不含思维链；重复保存每次新建一篇。
 */
export type SaveGeneratedArticleRequest = {
  threadId: string
  /** 用户眼前这一版回答的根条目 id；继续生成接在它后面。 */
  answerId: string
  /** 不传时按来源词起一个默认篇名。 */
  title?: string
}

export type SaveGeneratedArticleResult =
  | { status: 'saved'; article: ArticleDetail }
  | { status: 'missing' }
  | {
      status: 'rejected'
      /** incomplete：回答未完成（停止/出错）；empty：正文为空；no-word-context：这一问没带词。 */
      reason: 'incomplete' | 'empty' | 'no-word-context' | 'too-long'
    }

/**
 * 删除一篇文章前的影响面。原句数指该篇的 entry_sentence 关联条数；
 * 受影响词条按去重后的词条计，并区分删完仍有其他原句的与真正会消失的。
 * 只有会消失的词条才连带删除学习内容；挂在本篇的钉住全部保留为未归档。
 */
export type ArticleDeletionPreview = {
  articleId: string
  /** 该篇的已收集原句关联条数。 */
  sentenceAssociationCount: number
  /** 这些原句涉及的、去重后的词条总数（含存活与消失）。 */
  affectedEntryCount: number
  /** 删除后一条原句都不剩、词条连同学习内容一起消失的数量。 */
  disappearingEntryCount: number
  /** 删除后仍有其他文章原句、继续保留的数量。 */
  survivingEntryCount: number
  /** 随消失词条一起删除的学习内容条数。 */
  disappearingLearningNoteCount: number
  /** 落点正是这篇文章的钉住数；删除后保留快照并转为未归档。 */
  articlePinCount: number
}

export type RenameArticleRequest = {
  articleId: string
  title: string
}

export type RenameArticleResult =
  | { status: 'renamed'; articleId: string; title: string }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'empty' | 'too-long' }

export type DeleteArticleRequest = {
  articleId: string
  /**
   * 用户在确认弹层里看到的那份影响面。主进程在事务里重新算一遍；只要有一项对不上
   * 就整体拒绝删除，带回最新一份让界面重新确认，绝不按旧数字悄悄删。
   */
  confirmed: ArticleDeletionPreview
}

export type DeleteArticleResult =
  | {
      status: 'deleted'
      articleId: string
      /** 删除时算的影响面，与确认弹层看到的是同一份。 */
      preview: ArticleDeletionPreview
    }
  | { status: 'missing' }
  | {
      /** 影响面在预览之后变了：这次什么都没删，`preview` 是最新的一份。 */
      status: 'stale'
      articleId: string
      preview: ArticleDeletionPreview
    }

/** 上次停下的那一句：段与句都从 1 数，方便直接写进界面。 */
export type ReadingPoint = {
  paragraphId: string
  paragraphOrdinal: number
  sentenceOrdinal: number
  sentenceText: string
}

/** 首页「继续阅读」卡片底部速览：本篇最近拾下的一个词条，点一下直达词条。 */
export type HomeArticleEntry = {
  entryId: string
  mainForm: string
}

export type ContinueReading = {
  article: LibraryArticle
  lastReadPoint: ReadingPoint | null
  /**
   * 当前续读篇目里最近拾下的词条，最多 `HOME_ARTICLE_ENTRY_LIMIT` 个；
   * 只认这一篇的 entry_sentence，其他文章的收集不混进来。
   */
  articleEntries: HomeArticleEntry[]
}

/** 首页「最近收集」的一个词条 chip：复用词条列表那一行，只取 chip 需要的字段。 */
export type HomeEntryChip = Pick<
  EntryListItem,
  'id' | 'mainForm' | 'sentenceCount' | 'articleCount' | 'lastCollectedAt'
>

/**
 * 首页「稍后看」的一行。只带词条与标记时间：不算进最近收集，
 * 也不显示原句数、笔记数这些收集侧的规模。
 */
export type HomeLaterEntry = {
  entryId: string
  /** 词条当前的主词形。 */
  mainForm: string
  /** 标记「稍后看」的时间，ISO 8601 UTC；列表按它倒序。 */
  markedAt: string
}

export type HomeSummary = {
  library: LibrarySize
  continueReading: ContinueReading | null
  /**
   * 已读完的篇数。没有未读完的篇目时，首页靠它区分「第一次来」与「都读完了」，
   * 只数真正标过完成的篇目，不拿文章库总数冒充已读。
   */
  completedArticleCount: number
  /** 真实的词条按最近收集时间倒序；没有词条时为空数组。 */
  recentEntries: HomeEntryChip[]
  /** 标了「稍后看」的词条，按标记时间倒序；没有时为空数组。 */
  laterEntries: HomeLaterEntry[]
}

export type ImportFailure = {
  id: string
  reason: string
}

/**
 * 一次语料导入的结果。失败项逐条带原因，界面据此提示，不静默跳过。
 */
export type ImportReport = {
  total: number
  imported: number
  updated: number
  skipped: number
  failed: readonly ImportFailure[]
}
