import type { ThreadContextItem } from '../../../shared/threads'

/**
 * 划词胶囊的「追问」：把选中片段作为一条摘录上下文放回当前对话。
 * 对话页与轻问抽屉共用同一份 id 形态、来源与回执文案。
 */
export function followUpContextItem(text: string): ThreadContextItem {
  return {
    id: `excerpt:${crypto.randomUUID()}`,
    kind: 'excerpt',
    label: '追问',
    text,
    source: '来自当前回答'
  }
}

export const FOLLOW_UP_SENT_TEXT = '已把这段放进追问，写下你的问题。'
