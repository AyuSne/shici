import type {
  EntryListItem,
  EntrySearchMatch,
  EntrySentence,
  EntrySummary,
  LearningNote,
  LearningNoteSourcePin
} from '../../../shared/entries'
import { pinSourceIssueText } from '../chat/pin-text'
import { formatDay } from '../library/format'

/** 搜索命中类型的短标签；词条页左栏与之后的全局搜索共用同一套说法。 */
export const ENTRY_SEARCH_MATCH_LABELS: Record<EntrySearchMatch, string> = {
  'main-form': '主词形',
  sentence: '原句',
  'learning-note': '学习内容'
}

/** 左栏一行：「2 句 · 1 篇」。 */
export function entryListMetaText(
  entry: Pick<EntryListItem, 'sentenceCount' | 'articleCount'>
): string {
  return `${entry.sentenceCount} 句 · ${entry.articleCount} 篇`
}

/**
 * 原句出处：「段 D · 第 3 句 · 第 4 页」；仔细阅读是「第 2 段 · 第 1 句」。
 * 句序在库里从 0 数，写出来从 1 数。
 */
export function sentenceSourceText(
  sentence: Pick<
    EntrySentence,
    'paragraphLetter' | 'paragraphOrdinal' | 'sentenceOrdinal' | 'page'
  >
): string {
  const place =
    sentence.paragraphLetter === null
      ? `第 ${sentence.paragraphOrdinal} 段`
      : `段 ${sentence.paragraphLetter}`
  const parts = [place, `第 ${sentence.sentenceOrdinal + 1} 句`]
  if (sentence.page !== null) {
    parts.push(`第 ${sentence.page} 页`)
  }
  return parts.join(' · ')
}

/** 学习内容的来源行；钉住带进来的写清线程、轮次、模型与日期。 */
export function noteSourceText(
  note: Pick<LearningNote, 'source' | 'createdAt'> & {
    sourcePin?: LearningNoteSourcePin | null
  }
): string {
  if (note.source === 'pin' && note.sourcePin) {
    const pin = note.sourcePin
    const parts = [`来自 ${pin.threadTitle}`, `第 ${pin.turnIndex} 轮`]
    if (pin.model !== '') {
      parts.push(pin.model)
    }
    const day = formatDay(pin.capturedAt)
    if (day !== '') {
      parts.push(day)
    }
    const sourceIssue = pinSourceIssueText(pin.sourceStatus)
    if (sourceIssue !== null) parts.push(sourceIssue)
    return parts.join(' · ')
  }
  const origin = note.source === 'pin' ? '来自对话' : '词条内手写'
  const day = formatDay(note.createdAt)
  return day === '' ? origin : `${origin} · ${day}`
}

/** 选学习内容移动时的一行摘要：压掉换行，太长就截断。 */
export function noteExcerpt(body: string, limit = 28): string {
  const text = body.replace(/\s+/g, ' ').trim()
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/** 词条标题下的一行：「已收集 6 条原句 · 来自 3 篇 · 最近 2026-11-15」。 */
export function entryHeadlineText(
  entry: Pick<EntrySummary, 'sentenceCount' | 'articleCount' | 'lastCollectedAt'>
): string {
  const base = `已收集 ${entry.sentenceCount} 条原句 · 来自 ${entry.articleCount} 篇`
  const day = formatDay(entry.lastCollectedAt)
  return day === '' ? base : `${base} · 最近 ${day}`
}

/** 右栏没有学习内容时的空态：手写与钉住两条路都写在一句里。 */
export const EMPTY_LEARNING_NOTES_TEXT = '可以手写，也可以从对话里钉一段进来'

/**
 * 删最后一条原句的确认文案。没有学习内容时不能写「连同 0 条学习内容」，
 * 只说词条一起删除；有学习内容时说明连带删掉几条。
 */
export function deleteLastSentenceText(mainForm: string, noteCount: number): string {
  if (noteCount <= 0) {
    return `这是最后一条原句。删掉后「${mainForm}」词条也会一起删除。`
  }
  return `这是最后一条原句。删掉后「${mainForm}」词条连同 ${noteCount} 条学习内容也会一起删除。`
}
