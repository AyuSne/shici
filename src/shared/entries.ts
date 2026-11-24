import type { PinSourceStatus } from './pins'
import type { SearchSnippet } from './search'

/**
 * 词条与已收集原句的跨层类型。阅读页只认这些结构：谁被收集了、落在哪一句、
 * 词条现在有几条原句；点开词条卡时再取整条词条的明细。
 */

/**
 * 跨篇「故人重逢」：同一个词条在别的文章里收过的一条原句。
 * 阅读视图排除当前篇，词条卡与选词结果同样只给非本篇的一条。
 */
export type ReadingEncounter = {
  entrySentenceId: string
  articleId: string
  articleTitle: string
  /** 段序，1 起，和原句出处同一种写法。 */
  paragraphOrdinal: number
  sentenceText: string
  surface: string
}

/** 阅读里随手可看的两样：置顶学习内容摘要与一条跨篇故人重逢原句。 */
export type EntryLearningGlance = {
  pinnedNote: { id: string; excerpt: string } | null
  encounter: ReadingEncounter | null
}

/**
 * 正文里的一处已收集标记。`start` / `end` 是段内字符区间，和句子的区间同一套坐标，
 * 渲染层据此把琥珀色标回正文。
 */
export type ReadingCollectionMark = {
  /** entry_sentence 的 id，删除时用它。 */
  id: string
  entryId: string
  /** 词条当前的主词形。 */
  entryMainForm: string
  /** 当时圈下的词形，原样保留。 */
  surface: string
  paragraphId: string
  /** 段内句序，0 起。 */
  sentenceOrdinal: number
  start: number
  end: number
  /** 置顶学习内容摘要与跨篇故人重逢；阅读页与悬停一瞥直接用。 */
  glance: EntryLearningGlance
}

/** 词条的规模与词形，词条卡顶部与删除提示用。 */
export type EntrySummary = {
  id: string
  mainForm: string
  /** 除主词形外，已收集到的其他词形，按首次收集时间排。 */
  variants: string[]
  sentenceCount: number
  articleCount: number
  noteCount: number
  /** ISO 8601 UTC。 */
  lastCollectedAt: string
  /** 「稍后看」的标记时间；没标时为 null。与收集时间、计数互不影响。 */
  laterMarkedAt: string | null
}

/** 词条下的一条原句：选中词形、原句文字与出处。 */
export type EntrySentence = {
  id: string
  surface: string
  articleId: string
  articleTitle: string
  paragraphId: string
  /** 段序，1 起，直接可写进界面。 */
  paragraphOrdinal: number
  /** 长篇匹配的原卷段落字母；仔细阅读为 null。 */
  paragraphLetter: string | null
  /** 段内句序，0 起。 */
  sentenceOrdinal: number
  sentenceText: string
  /** 段内字符区间。 */
  start: number
  end: number
  /** 选中的词形在句内的起始位置，界面据此把原词标出来。 */
  surfaceOffset: number
  /** 原 PDF 页码；语料没给时为 null。 */
  page: number | null
  /** 同一篇里的上一句 / 下一句，词条页展开前后句用；没有时为 null。 */
  previousSentence: string | null
  nextSentence: string | null
  /** 这个词形能不能单独拆成新词条；已经属于本词条时为 false。 */
  canSplitToNew: boolean
  collectedAt: string
}

/** 阅读页点开一个已收集的词时看到的词条卡。 */
export type WordEntryCard = {
  entry: EntrySummary
  /** 按最近收集在前。 */
  sentences: EntrySentence[]
  /** 阅读卡首屏要先摆出来的置顶学习内容与故人重逢。 */
  glance: EntryLearningGlance
}

export type CollectSelectionRequest = {
  articleId: string
  paragraphId: string
  /** 段内句序，0 起。 */
  sentenceOrdinal: number
  /** 段内字符区间。 */
  start: number
  end: number
}

export type CollectRejection = 'article' | 'paragraph' | 'sentence' | 'range' | 'empty'

export type CollectSelectionResult =
  | {
      status: 'collected'
      entry: EntrySummary
      sentence: EntrySentence
      /** 这一篇最新的已收集标记，渲染层直接换上。 */
      marks: ReadingCollectionMark[]
      /** 词条的置顶学习内容与跨篇故人重逢，选词卡首屏直接用。 */
      glance: EntryLearningGlance
      /** 这次写之后本篇含多少个「曾在任何一篇收过、正文里也出现」的词。 */
      knownWordCount: number
    }
  | {
      /** 同篇同句同一个词条已经收过，不新增关联。 */
      status: 'duplicate'
      entry: EntrySummary
      sentence: EntrySentence
      marks: ReadingCollectionMark[]
      glance: EntryLearningGlance
      knownWordCount: number
    }
  | {
      status: 'rejected'
      reason: CollectRejection
    }

/**
 * 一条被删原句的不可变快照。只用于非最后一条原句的 5 秒撤销：
 * 恢复时原样写回 id、句锚点、词形与收集时间，不重新解析选区，也不新建词条。
 */
export type EntrySentenceSnapshot = {
  id: string
  entryId: string
  articleId: string
  paragraphId: string
  /** 段内句序，0 起。 */
  sentenceOrdinal: number
  surface: string
  /** 段内字符区间，与原句在原文里的位置一致。 */
  start: number
  end: number
  /** ISO 8601 UTC；恢复后仍是这个时间。 */
  collectedAt: string
}

export type DeleteEntrySentenceResult =
  | {
      status: 'deleted'
      /** 删的是这个词条的最后一条原句，词条本身也没了。 */
      entryDeleted: boolean
      entry: EntrySummary | null
      /** 被删原句所在的那一篇；`marks` 只属于这一篇。 */
      articleId: string
      marks: ReadingCollectionMark[]
      /** 删除后这一篇含多少个曾收词；界面用它即时刷新顶栏。 */
      knownWordCount: number
      /**
       * 非最后一条原句才给撤销快照；最后一条会连词条与学习内容一起删，
       * 走显式危险确认，不提供恢复。旧记录没有这个字段。
       */
      snapshot?: EntrySentenceSnapshot
    }
  | {
      status: 'missing'
    }

/** 撤销删除：只按快照恢复，不复活已删的文章 / 原句 / 词条，也不覆盖后来改动。 */
export type RestoreEntrySentenceResult =
  | {
      status: 'restored'
      entry: EntrySummary
      sentence: EntrySentence
      articleId: string
      marks: ReadingCollectionMark[]
      knownWordCount: number
    }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'source' | 'entry' | 'conflict' }

/** 词条页左栏的一行。 */
export type EntryListItem = {
  id: string
  mainForm: string
  /** 已收集到的其他词形，按首次收集时间排；不含主词形。 */
  variants: string[]
  sentenceCount: number
  articleCount: number
  noteCount: number
  lastCollectedAt: string
  /**
   * 有搜索词时给出「为什么命中」：命中类型、高亮片段与定位 id。
   * 空查询时没有这个字段；全局搜索（#55）复用同一份 EntrySearchHit 契约。
   */
  hit?: EntrySearchHit
}

/** 词条搜索的命中类型：主词形、已收原句、学习内容正文。 */
export type EntrySearchMatch = EntrySearchHit['match']

/**
 * 词条列表的一处命中。定位字段与命中类型绑定：主词形只带词条 id，
 * 原句命中带原句关联 id，学习内容命中带那一条 id，不会留下「有 articleId 却
 * 没有 paragraphId」这类无效组合。片段与高亮区间仍复用 shared/search.ts。
 */
export type EntrySearchHit =
  | {
      match: 'main-form'
      snippet: SearchSnippet
      entryId: string
    }
  | {
      match: 'sentence'
      snippet: SearchSnippet
      entryId: string
      /** 词条里命中的原句关联 id；跳回原文并定位原句时用。 */
      entrySentenceId: string
    }
  | {
      match: 'learning-note'
      snippet: SearchSnippet
      entryId: string
      /** 命中的学习内容 id。 */
      noteId: string
    }

/** 左栏的排序与筛选；搜索同时匹配主词形、已收原句与学习内容正文。 */
export type EntryListRequest = {
  query?: string
  sort?: 'recent' | 'alpha'
  filter?: 'all' | 'has-notes' | 'no-notes'
}

export type EntryListResult = {
  /** 库里的词条总数，不受搜索与筛选影响。 */
  total: number
  entries: EntryListItem[]
}

/** 学习内容：词条下的一段材料，只保留最终稿，不存历史版本。 */
export type LearningNote = {
  id: string
  entryId: string
  body: string
  pinned: boolean
  /** 来源：词条内就地手写，或从对话钉进来。 */
  source: 'manual' | 'pin'
  /** 钉住来源的 id；手写时为 null。 */
  sourcePinId: string | null
  /** 钉住带进来的出处；手写内容与来源已失效时为 null。 */
  sourcePin: LearningNoteSourcePin | null
  createdAt: string
  updatedAt: string
}

/** 学习内容卡底部那行出处：线程、轮次、模型、时间，以及原回答能否跳转。 */
export type LearningNoteSourcePin = {
  id: string
  threadId: string
  threadTitle: string
  /** 第几轮，1 起。 */
  turnIndex: number
  model: string
  capturedAt: string
  sourceStatus: PinSourceStatus
}

/** 词条页里按文章分组的一组原句。 */
export type EntrySentenceGroup = {
  articleId: string
  articleTitle: string
  sessionLabel: string
  setLabel: string
  /** 这一组里最新收集的时间，组间按它倒序。 */
  latestCollectedAt: string
  /** 组内按段序、句序。 */
  sentences: EntrySentence[]
}

/** 词条页中栏与右栏要的全部内容。 */
export type EntryPage = {
  entry: EntrySummary
  groups: EntrySentenceGroup[]
  /** 置顶的在前，其余按写下的时间倒序。 */
  notes: LearningNote[]
}

/** 合并两个词条：source 的原句与学习内容迁到 target，source 消失。 */
export type MergeEntriesRequest = {
  sourceEntryId: string
  targetEntryId: string
  /** 合并后用的主词形；缺省沿用 target 的。 */
  mainForm?: string
}

export type MergeEntriesResult =
  | {
      status: 'merged'
      entry: EntrySummary
      /** 迁过来的原句条数。 */
      movedSentences: number
      /** 目标词条里已有同篇同句，合并成一条的条数。 */
      repeatedSentences: number
      movedNotes: number
    }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'same-entry' | 'main-form' }

/** 换主词形：只能从已收集的词形里选。 */
export type ChangeMainFormRequest = {
  entryId: string
  mainForm: string
}

export type ChangeMainFormResult =
  | { status: 'changed'; entry: EntrySummary }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'unknown-form' }

/** 把一条原句拆到另一个已有词条，或按它的词形新建一个词条。 */
export type MoveEntrySentenceRequest = {
  entrySentenceId: string
  target: { kind: 'entry'; entryId: string } | { kind: 'new' }
}

export type MoveEntrySentenceResult =
  | {
      status: 'moved'
      /** 源词条；拆走最后一条原句时它连学习内容一起删掉，为 null。 */
      from: EntrySummary | null
      to: EntrySummary
    }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'same-entry' | 'duplicate' }

/** 重新圈定：只在原句所在的那一句里换范围。 */
export type ReselectEntrySentenceRequest = {
  entrySentenceId: string
  start: number
  end: number
}

export type ReselectEntrySentenceResult =
  | {
      status: 'resaved'
      entry: EntrySummary
      sentence: EntrySentence
      articleId: string
      marks: ReadingCollectionMark[]
    }
  | { status: 'missing' }
  | { status: 'rejected'; reason: CollectRejection }

export type CreateLearningNoteRequest = {
  entryId: string
  body: string
}

export type UpdateLearningNoteRequest = {
  noteId: string
  body: string
}

export type PinLearningNoteRequest = {
  noteId: string
  pinned: boolean
}

export type MoveLearningNoteRequest = {
  noteId: string
  entryId: string
}

/** 学习内容的增改、置顶、移动与删除共用一种结果。 */
export type LearningNoteResult =
  | { status: 'saved'; note: LearningNote }
  | { status: 'deleted' }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'empty' | 'entry' | 'same-entry' }

/** 阅读页从词条跳过来时要定位的原句。 */
export type EntrySentenceTarget = {
  entry: EntrySummary
  sentence: EntrySentence
}

/** 设置或取消一个词条的「稍后看」标记。 */
export type SetEntryLaterRequest = {
  entryId: string
  /** true = 加入稍后看；false = 取消。 */
  later: boolean
}

/**
 * 稍后看只改独立标记：`marked` 带回标记时间（重复标记保持第一次），
 * `unmarked` 是取消后的状态，词条不存在时 `missing`，这时不会新建词条。
 */
export type SetEntryLaterResult =
  | { status: 'marked'; markedAt: string }
  | { status: 'unmarked' }
  | { status: 'missing' }
