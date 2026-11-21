import type { ChatTurn } from '../../../shared/chat'
import {
  CONTINUE_INSTRUCTION,
  summarizeContextItems,
  type ChatThreadView,
  type ThreadAnswer,
  type ThreadContextItem,
  type ThreadContextKind,
  type ThreadContextSummary,
  type ThreadTurn,
  type ThreadVersion
} from '../../../shared/threads'

export { CONTINUE_INSTRUCTION }

/**
 * 这一路对话怎么变成一次模型请求：系统前言放这次带上的材料，
 * 历史只放已经写出来的问答；重新生成截到那一问，继续生成把已写出的部分带上。
 */

export type GenerationMode =
  | { kind: 'answer' }
  | { kind: 'regenerate'; questionId: string }
  | { kind: 'continue' }

/** 空线程的副标题；页头与「新的学习」共用一句。 */
export const BLANK_THREAD_SUBTITLE = '未挂任何对象 · 从词或文章开始'

/** 上下文种类在芯片与 system 前言里的叫法。 */
export const CONTEXT_KIND_LABEL: Record<ThreadContextKind, string> = {
  word: '词',
  sentence: '原句',
  paragraph: '段落',
  note: '学习内容',
  article: '文章',
  excerpt: '摘录'
}

export function contextSummaryText(summary: ThreadContextSummary): string {
  const parts: string[] = []
  if (summary.articleCount) parts.push(`${summary.articleCount} 篇全文`)
  if (summary.paragraphCount) parts.push(`${summary.paragraphCount} 段`)
  if (summary.sentenceCount) parts.push(`${summary.sentenceCount} 条原句`)
  if (summary.excerptCount) parts.push(`${summary.excerptCount} 条摘录`)
  if (summary.wordCount) parts.push(`${summary.wordCount} 个词`)
  parts.push(`约 ${summary.charCount} 字`)
  return parts.join(' · ')
}

export const summarizeContext = summarizeContextItems

/** 学习上下文写成一段 system 前言；没有材料时返回 null，请求里就不带 system 消息。 */
export function threadSystemPrompt(items: readonly ThreadContextItem[]): string | null {
  if (items.length === 0) {
    return null
  }
  const lines = items.map((item) => {
    const tag = CONTEXT_KIND_LABEL[item.kind]
    const source = item.source === '' ? '' : ` —— ${item.source}`
    return `[${tag}] ${item.text}${source}`
  })
  return [
    '以下是学习者这次带来的材料，回答时可以引用其中的原句与出处：',
    '',
    ...lines
  ].join('\n')
}

export function lastTurn(view: ChatThreadView): ThreadTurn | null {
  return view.turns.length === 0 ? null : (view.turns[view.turns.length - 1] as ThreadTurn)
}

/** 选中版本在列表里的位置，从 1 起；没有版本时为 0。 */
export function selectedVersionIndex(versions: readonly ThreadVersion[]): number {
  return versions.findIndex((version) => version.selected) + 1
}

function isWritten(answer: ThreadAnswer): boolean {
  return answer.text.trim() !== ''
}

/**
 * 一次请求的历史。`answer` 用整条路径；`regenerate` 截到目标那一问之前再补上那一问；
 * `continue` 把当前回答已经写出的部分作为 assistant 消息带上，再接一句继续的要求。
 */
export function buildMessages(view: ChatThreadView, mode: GenerationMode): ChatTurn[] {
  const messages: ChatTurn[] = []
  const turns = view.turns

  const pushTurn = (turn: ThreadTurn): void => {
    messages.push({ role: 'user', content: turn.question.text })
    if (turn.answer !== null && isWritten(turn.answer)) {
      messages.push({ role: 'assistant', content: turn.answer.text })
    }
  }

  if (mode.kind === 'answer') {
    for (const turn of turns) pushTurn(turn)
    return messages
  }

  if (mode.kind === 'regenerate') {
    for (const turn of turns) {
      if (turn.question.id === mode.questionId) {
        messages.push({ role: 'user', content: turn.question.text })
        return messages
      }
      pushTurn(turn)
    }
    // 目标不在这一支上：退回完整历史，至少不要发出半截请求。
    for (const turn of turns) pushTurn(turn)
    return messages
  }

  for (const turn of turns) pushTurn(turn)
  messages.push({ role: 'user', content: CONTINUE_INSTRUCTION })
  return messages
}

/**
 * 「存为文章」按钮的显示条件：这一问带词上下文、当前这版回答已完成且有正文，
 * 并且此刻没有在生成 / 忙别的。生成中不把保存旧回答的按钮留在眼前。
 */
export function canSaveAnswerAsArticle(
  question: ThreadTurn['question'],
  answer: ThreadAnswer | null,
  disabled: boolean
): boolean {
  return (
    !disabled &&
    answer !== null &&
    answer.phase === 'done' &&
    answer.error === null &&
    answer.text.trim() !== '' &&
    question.wordCount > 0
  )
}

/** 页头副标题：挂什么对象就说清是什么，空白线程给一句说明。 */
export function threadHeaderText(view: ChatThreadView): string {
  if (view.missingMain) return '主对象已不存在'
  const main = view.main
  switch (main.kind) {
    case 'none':
      return BLANK_THREAD_SUBTITLE
    case 'entry':
      return `词条 ${main.mainForm} · ${main.sentenceCount} 条原句 · ${main.articleCount} 篇`
    case 'sentence':
      return `${main.articleTitle} · 段 ${main.paragraphLetter ?? main.paragraphOrdinal} · 第 ${
        main.sentenceOrdinal + 1
      } 句`
    case 'article': {
      // 生成文章没有场次与套数：空的那几项不拼进去，绝不编年份。
      const parts = [
        main.sessionLabel,
        main.setLabel,
        main.kindLabel,
        `${main.wordCount} 词`
      ].filter((part) => part.trim() !== '')
      return parts.join(' · ')
    }
  }
}
