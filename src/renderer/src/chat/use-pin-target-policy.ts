import { useEffect, useState } from 'react'
import type { EntryListItem } from '../../../shared/entries'
import type { PinTargetView } from '../../../shared/pins'
import type { ThreadContextItem, ThreadMain } from '../../../shared/threads'
import { loadEntryList } from '../api'
import { defaultPinTarget } from './pin-text'
import {
  contextWordEntryIds,
  mainFingerprint,
  manualAfterChoice,
  resolvePinTarget,
  usableManualPreference,
  type StoredManualPreference
} from './pin-target-policy'

/**
 * 同一条线程的手动落点。放在模块级而不是组件里：轻问抽屉关掉重开、
 * 或展开成完整对话页时，用户改过的落点仍然算数。
 */
const manualByThread = new Map<string, StoredManualPreference>()

export function clearPinTargetPreference(threadId: string): void {
  manualByThread.delete(threadId)
}

export type PinTargetPolicy = {
  /** 这次划选要打开的弹层预选落点。 */
  initialTargetForSelection: (selectedText: string) => PinTargetView
  /** 没有划选时（例如全部归位）沿着同一份手动偏好走的默认落点。 */
  defaultTarget: PinTargetView
  /** 用户确认弹层后调用；原样接受自动预选不会记成手动偏好。 */
  rememberChoice: (initial: PinTargetView, chosen: PinTargetView) => void
}

/**
 * 对话页与轻问抽屉共用的落点策略。上下文里有词时才去读词条列表，
 * 读回来的主词形与已收变体就是自动预选的依据；其余判断都在纯策略模块里。
 */
export function usePinTargetPolicy(input: {
  threadId: string | null
  main: ThreadMain | null
  context: readonly ThreadContextItem[]
}): PinTargetPolicy {
  const [entries, setEntries] = useState<readonly EntryListItem[]>([])
  const contextKey = contextWordEntryIds(input.context).sort().join('|')

  useEffect(() => {
    if (contextKey === '') {
      setEntries([])
      return
    }
    let active = true
    loadEntryList({}).then(
      (listing) => {
        if (active) setEntries(listing.entries)
      },
      () => {
        if (active) setEntries([])
      }
    )
    return () => {
      active = false
    }
  }, [contextKey])

  const threadId = input.threadId
  const main = input.main ?? ({ kind: 'none' } as const)
  const mainKey = mainFingerprint(main)

  function readManual(): PinTargetView | null {
    if (threadId === null) return null
    const stored = manualByThread.get(threadId) ?? null
    const usable = usableManualPreference(stored, mainKey)
    if (stored !== null && usable === null) manualByThread.delete(threadId)
    return usable
  }

  return {
    initialTargetForSelection: (selectedText: string) =>
      resolvePinTarget({
        manual: readManual(),
        main,
        context: input.context,
        entries,
        selectedText
      }),
    defaultTarget: readManual() ?? defaultPinTarget(main),
    rememberChoice: (initial: PinTargetView, chosen: PinTargetView) => {
      if (threadId === null) return
      const next = manualAfterChoice(readManual(), initial, chosen)
      if (next === null) {
        manualByThread.delete(threadId)
        return
      }
      manualByThread.set(threadId, { target: next, mainKey })
    }
  }
}
