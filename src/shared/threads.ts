import type { ChatError } from './chat'

/**
 * 线程与它这一路的对话。线程挂一个主对象（词条 / 原句 / 文章 / 不挂），
 * 主对象决定默认钉住落点与上下文预填；对话本身是不可变条目日志，
 * 重新生成与改口都产生新条目，旧版本仍在库里。
 */

/** 继续生成时追加的一句要求；不落库，只进这一次请求。 */
export const CONTINUE_INSTRUCTION =
  '请接着上面最后一段继续写，不要重复已经写过的内容，也不要重新开头。'

export type ThreadMainKind = 'none' | 'entry' | 'sentence' | 'article'

/** 线程主对象。挂上之后，标题、上下文预填与默认落点都从它来。 */
export type ThreadMain =
  | { kind: 'none' }
  | {
      kind: 'entry'
      entryId: string
      mainForm: string
      sentenceCount: number
      articleCount: number
    }
  | {
      kind: 'sentence'
      entryId: string
      entrySentenceId: string
      mainForm: string
      surface: string
      sentenceText: string
      articleId: string
      articleTitle: string
      paragraphId: string
      paragraphOrdinal: number
      paragraphLetter: string | null
      sentenceOrdinal: number
    }
  | {
      kind: 'article'
      articleId: string
      title: string
      sessionLabel: string
      setLabel: string
      kindLabel: string
      wordCount: number
    }

export type ThreadContextKind = 'word' | 'sentence' | 'paragraph' | 'note' | 'article'

/**
 * 一条学习上下文。`text` 是真正交给模型的正文，`source` 是给人看的出处；
 * `label` 短到能放进取词块。同一线程内 `id` 唯一。
 */
export type ThreadContextItem = {
  id: string
  kind: ThreadContextKind
  label: string
  text: string
  source: string
}

/** 全文覆盖同篇段落；其他材料与其原有顺序保留。 */
export function deduplicateArticleContext(items: readonly ThreadContextItem[]): ThreadContextItem[] {
  const fullArticles = items.filter((item) => item.kind === 'article' && item.id.startsWith('article:'))
    .map((item) => `paragraph:${item.id.slice('article:'.length)}:`)
  return items.filter((item) => item.kind !== 'paragraph' || !fullArticles.some((prefix) => item.id.startsWith(prefix)))
}

/** `word:` 前缀只在这里解析一次；不是词或 id 为空时返回 null。 */
export function wordContextEntryId(
  item: Pick<ThreadContextItem, 'id' | 'kind'>
): string | null {
  if (item.kind !== 'word' || !item.id.startsWith('word:')) {
    return null
  }
  const entryId = item.id.slice('word:'.length)
  return entryId === '' ? null : entryId
}

/** 一条线程一次最多带多少个不同的词条；界面与主进程边界共用同一个数。 */
export const GROUP_WORD_LIMIT = 20

/** 输入框上方那行「N 个词 · M 条原句 · 约 K 字」；字数据正文的字数（码点）算。 */
export type ThreadContextSummary = {
  articleCount: number
  paragraphCount: number
  wordCount: number
  sentenceCount: number
  charCount: number
}

/** 根据实际携带的正文统计材料。 */
export function summarizeContextItems(items: readonly ThreadContextItem[]): ThreadContextSummary {
  let articleCount = 0, paragraphCount = 0, wordCount = 0, sentenceCount = 0, charCount = 0
  for (const item of items) {
    if (item.kind === 'article') articleCount++
    if (item.kind === 'paragraph') paragraphCount++
    if (item.kind === 'word') wordCount++
    if (item.kind === 'sentence') sentenceCount++
    charCount += Array.from(item.text).length
  }
  return { articleCount, paragraphCount, wordCount, sentenceCount, charCount }
}

/** 同一位置的候选版本：重新生成的回答、改口后的提问。 */
export type ThreadVersion = {
  id: string
  selected: boolean
}

/** 一条回答及其「继续生成」接出来的后续。 */
export type ThreadAnswer = {
  /** 回答版本的根条目；重新生成产生的新版本与它是兄弟。 */
  id: string
  /** 这一问的全部回答版本，按生成时间排。 */
  versions: ThreadVersion[]
  /** 根回答加上所有继续生成的内容。 */
  text: string
  /** 各段思考拼在一起，按出现顺序。 */
  thinking: string
  /** 思考用了多久（毫秒）；没有思维链时为 0。 */
  thinkingMs: number
  /** 最后一段的状态；继续生成中断时整条算未完成。 */
  phase: 'done' | 'stopped' | 'error'
  error: ChatError | null
  /** 生成这一版时用的模型名；旧数据没有时为空串。 */
  model: string
  createdAt: string
  /** 继续生成接出来的条目，按追加顺序。 */
  continuationIds: string[]
}

export type ThreadTurn = {
  question: {
    id: string
    text: string
    createdAt: string
    /**
     * 提这一问时上下文里带的词条数（保存回答那一刻的快照）。线程之后增删上下文
     * 不会改写它；「存为文章」只看这一份，界面也据此决定要不要给这个回答存文章。
     */
    wordCount: number
    /** 这一问的全部提问版本（改口产生）；按提出时间排。 */
    versions: ThreadVersion[]
  }
  /** 还没回答的提问为 null。 */
  answer: ThreadAnswer | null
}

export type ChatThreadView = {
  id: string
  title: string
  main: ThreadMain
  /** 原主对象已删除时保留其类型，避免误显示成空白线程。 */
  missingMain?: Exclude<ThreadMainKind, 'none'>
  /** 这一路对话当前带上的上下文，按加入顺序。 */
  context: ThreadContextItem[]
  contextSummary: ThreadContextSummary
  turns: ThreadTurn[]
  createdAt: string
  updatedAt: string
}

export type ThreadListItem = {
  id: string
  title: string
  mainKind: ThreadMainKind
  /** 「词条 lament」「文章 …」「未挂对象」一类的副标题。 */
  mainLabel: string
  turnCount: number
  createdAt: string
  updatedAt: string
}

export type ThreadListResult = {
  threads: ThreadListItem[]
}

export type DeleteThreadRequest = { threadId: string }

export type DeleteThreadResult =
  | { status: 'deleted' | 'missing' }
  | { status: 'busy' }

export type CreateThreadRequest = {
  main:
    | { kind: 'none' }
    | { kind: 'entry'; entryId: string }
    | { kind: 'sentence'; entrySentenceId: string }
    | { kind: 'article'; articleId: string }
}

export type CreateThreadResult =
  | { status: 'created'; thread: ChatThreadView }
  | { status: 'rejected'; reason: 'missing-main' }

/** 「用这些词学习」：一次选中一组词，开一条带词与各自原句的无主对象线程。 */
export type CreateGroupThreadRequest = { entryIds: string[] }

export type CreateGroupThreadResult =
  | { status: 'created'; thread: ChatThreadView }
  | { status: 'rejected'; reason: 'empty' | 'missing-word' | 'too-many-words' }

export type OpenThreadForMainRequest = CreateThreadRequest & {
  forceNew?: boolean
  /** 阅读页主动就所点词提问时，复用线程也应带上该词及原句。 */
  ensureSentenceContext?: boolean
}

export type OpenThreadForMainResult =
  | { status: 'created' | 'reused'; thread: ChatThreadView }
  | { status: 'rejected'; reason: 'missing-main' | 'context-full' }

export type AskThreadRequest = {
  threadId: string
  text: string
  /** 这一次要带上的上下文；不传时沿用线程里保存的。 */
  context?: ThreadContextItem[]
}

export type QuestionResult =
  | { status: 'asked'; questionId: string; thread: ChatThreadView }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'empty' | 'too-many-words' }

export type SaveAnswerRequest = {
  threadId: string
  questionId: string
  text: string
  thinking: string
  /** 这一段思考用了多久；没有思维链时不传。 */
  thinkingMs?: number
  phase: 'done' | 'stopped' | 'error'
  error?: ChatError | null
  /** 生成这一版时用的模型名，钉住出处要用。 */
  model?: string
}

export type SaveContinuationRequest = {
  threadId: string
  /** 回答版本的根条目；继续生成接在这一路的最后一段后面。 */
  answerId: string
  text: string
  thinking: string
  thinkingMs?: number
  phase: 'done' | 'stopped' | 'error'
  error?: ChatError | null
  model?: string
}

export type SaveAnswerResult =
  | { status: 'saved'; thread: ChatThreadView }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'question' | 'answer' }

export type UpdateThreadContextRequest = {
  threadId: string
  items: ThreadContextItem[]
}

export type UpdateThreadContextResult =
  | { status: 'saved'; thread: ChatThreadView }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'too-many-words' }

/** 还没进上下文、这次可以加进来的材料。 */
export type ThreadContextCandidates = {
  items: ThreadContextItem[]
  articles: { id: string; title: string }[]
  libraryItems: ThreadContextItem[]
}

export type ArticleContextMaterials = {
  article: ThreadContextItem | null
  paragraphs: ThreadContextItem[]
}

export type EditQuestionRequest = {
  threadId: string
  /** 正在改的那一问；新提问会成为它的兄弟，原来的回答整支保留。 */
  questionId: string
  text: string
  context?: ThreadContextItem[]
}

export type SwitchQuestionRequest = {
  threadId: string
  questionId: string
}

export type SwitchAnswerRequest = {
  threadId: string
  questionId: string
  answerId: string
}

export type SwitchThreadResult =
  | { status: 'switched'; thread: ChatThreadView }
  | { status: 'missing' }
  | { status: 'rejected'; reason: 'question' | 'answer' }

/** 把一条线程导出成 JSONL：文件不是真源，只求能读、能带走。 */
export type ExportThreadResult =
  | { status: 'saved'; file: string }
  | { status: 'cancelled' }
  | { status: 'missing' }
  | { status: 'failed' }
