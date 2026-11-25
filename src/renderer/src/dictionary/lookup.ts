import { useEffect, useState } from 'react'
import type { DictionaryLookup } from '../../../shared/dictionary'
import { lookupDictionary } from '../api'

/**
 * 三处入口共用的查词状态。词典调用失败（IPC 出错）时按「不可用」显示，
 * 界面不会停在「正在查词典…」；换一个词就作废旧结果。
 */

export type DictionaryLookupState = {
  lookup: DictionaryLookup | null
  loading: boolean
}

export type TrackedDictionaryLookupState = DictionaryLookupState & {
  /** 本次状态对应的原始查询词，用于确认当前词条是否已查完。 */
  word: string | null
}

/** 当前词条的词典查询是否已稳定落定（加载完成且对应当前主词形）。 */
export function isDictionarySettled(
  state: TrackedDictionaryLookupState,
  targetWord: string | null
): boolean {
  if (targetWord === null) return true
  return !state.loading && state.lookup !== null && state.word === targetWord
}

export function unavailableLookup(query: string): DictionaryLookup {
  return { status: 'unavailable', query }
}

/** 查一次词；失败也落到「词典不可用」，不把异常抛给界面。 */
export function lookupDictionaryOrUnavailable(word: string): Promise<DictionaryLookup> {
  return lookupDictionary(word).catch(() => unavailableLookup(word))
}

/** 按词查词典；word 为 null 时表示这次不需要查。 */
export function useDictionaryLookup(word: string | null): TrackedDictionaryLookupState {
  const [state, setState] = useState<TrackedDictionaryLookupState>({
    lookup: null,
    loading: false,
    word: null
  })

  useEffect(() => {
    if (word === null) {
      setState({ lookup: null, loading: false, word: null })
      return
    }
    let active = true
    setState({ lookup: null, loading: true, word })
    lookupDictionaryOrUnavailable(word).then((lookup) => {
      if (active) {
        setState({ lookup, loading: false, word })
      }
    })
    return () => {
      active = false
    }
  }, [word])

  return state
}
