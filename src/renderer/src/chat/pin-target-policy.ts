import type { EntryListItem } from '../../../shared/entries'
import type { PinTargetView } from '../../../shared/pins'
import type { ThreadContextItem, ThreadMain } from '../../../shared/threads'
import { wordContextEntryId } from '../../../shared/threads'
import { defaultPinTarget, samePinTarget } from './pin-text'
import { matchSelectedEntry } from './selection-match'

/**
 * 钉住落点的唯一策略：手动偏好 → 选中片段唯一命中的上下文词条 → 主对象默认。
 *
 * 关键区别：用户「原样接受」弹层自动预选的那一项，不算手动偏好；只有真正把落点
 * 改到别处才记下来。否则连续钉不同讲解时会一直落在第一次自动命中的词条上。
 * 偏好按线程保存，对话页与轻问抽屉共用同一条，不随呈现方式分叉。
 */

/** 主对象的稳定身份：同一条线程换了主对象，旧的手动落点必须作废。 */
export function mainFingerprint(main: ThreadMain): string {
  switch (main.kind) {
    case 'entry':
      return `entry:${main.entryId}`
    case 'sentence':
      return `sentence:${main.entryId}:${main.entrySentenceId}`
    case 'article':
      return `article:${main.articleId}`
    case 'none':
      return 'none'
  }
}

export type StoredManualPreference = {
  target: PinTargetView
  mainKey: string
}

/** 主对象没变才认这份手动偏好；变了就当作没有，绝不把旧落点带到新对象上。 */
export function usableManualPreference(
  stored: StoredManualPreference | null,
  mainKey: string
): PinTargetView | null {
  return stored !== null && stored.mainKey === mainKey ? stored.target : null
}

/** 这条线程里所有可能作为落点的词条 id（`word:` 前缀只在 shared 解析一次）。 */
export function contextWordEntryIds(context: readonly ThreadContextItem[]): string[] {
  const ids = new Set<string>()
  for (const item of context) {
    const entryId = wordContextEntryId(item)
    if (entryId !== null) ids.add(entryId)
  }
  return [...ids]
}

/**
 * 本次弹层的初始预选。手动偏好优先；否则按选中片段在上下文词条里找唯一命中；
 * 都没命中才退回主对象默认落点。
 */
export function resolvePinTarget(input: {
  manual: PinTargetView | null
  main: ThreadMain
  context: readonly ThreadContextItem[]
  entries: readonly EntryListItem[]
  selectedText: string
}): PinTargetView {
  if (input.manual !== null) return input.manual
  const wordIds = new Set(contextWordEntryIds(input.context))
  if (wordIds.size > 0) {
    const candidates = input.entries
      .filter((entry) => wordIds.has(entry.id))
      .map((entry) => ({
        entryId: entry.id,
        mainForm: entry.mainForm,
        variants: entry.variants
      }))
    const matched = matchSelectedEntry(input.selectedText, candidates)
    if (matched !== null) {
      return { kind: 'entry', entryId: matched.entryId, label: matched.mainForm }
    }
  }
  return defaultPinTarget(input.main)
}

/**
 * 用户确认落点后要不要记成手动偏好：和弹层预选完全一样就保持原状（包括原本没有），
 * 真正改选才写入新落点。
 */
export function manualAfterChoice(
  previous: PinTargetView | null,
  initial: PinTargetView,
  chosen: PinTargetView
): PinTargetView | null {
  if (samePinTarget(initial, chosen)) return previous
  return chosen
}
