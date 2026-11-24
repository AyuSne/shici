import { describe, expect, it } from 'vitest'
import type { EntryListItem } from '../../../shared/entries'
import type { PinTargetView } from '../../../shared/pins'
import type { ThreadContextItem, ThreadMain } from '../../../shared/threads'
import {
  mainFingerprint,
  manualAfterChoice,
  resolvePinTarget,
  usableManualPreference
} from './pin-target-policy'

function entry(id: string, mainForm: string, variants: string[] = []): EntryListItem {
  return {
    id,
    mainForm,
    variants,
    sentenceCount: 1,
    articleCount: 1,
    noteCount: 0,
    lastCollectedAt: '2026-11-18T08:00:00.000Z'
  }
}

function word(entryId: string, label: string): ThreadContextItem {
  return { id: `word:${entryId}`, kind: 'word', label, text: label, source: '' }
}

const entries = [entry('e-alpha', 'alpha'), entry('e-bravo', 'bravo'), entry('e-charlie', 'charlie')]
const context = [word('e-alpha', 'alpha'), word('e-bravo', 'bravo')]
const noneMain: ThreadMain = { kind: 'none' }

const targetOf = (value: PinTargetView): string =>
  value.kind === 'entry' ? `entry:${value.entryId}` : value.kind === 'article' ? `article:${value.articleId}` : 'unfiled'

describe('resolvePinTarget', () => {
  it('没有手动偏好时按选中片段唯一命中的上下文词条预选', () => {
    expect(
      targetOf(resolvePinTarget({ manual: null, main: noneMain, context, entries, selectedText: 'alpha' }))
    ).toBe('entry:e-alpha')
    expect(
      targetOf(resolvePinTarget({ manual: null, main: noneMain, context, entries, selectedText: 'bravo' }))
    ).toBe('entry:e-bravo')
  })

  it('手动偏好优先于任何自动命中', () => {
    const manual: PinTargetView = { kind: 'entry', entryId: 'e-charlie', label: 'charlie' }
    expect(
      targetOf(resolvePinTarget({ manual, main: noneMain, context, entries, selectedText: 'alpha' }))
    ).toBe('entry:e-charlie')
  })

  it('没有命中时退回主对象推导的默认落点', () => {
    const articleMain: ThreadMain = {
      kind: 'article',
      articleId: 'a-1',
      title: '一篇文章',
      sessionLabel: '',
      setLabel: '',
      kindLabel: '',
      wordCount: 0
    }
    expect(
      targetOf(resolvePinTarget({ manual: null, main: articleMain, context, entries, selectedText: 'unknown' }))
    ).toBe('article:a-1')
  })
})

describe('manualAfterChoice', () => {
  const autoAlpha: PinTargetView = { kind: 'entry', entryId: 'e-alpha', label: 'alpha' }
  const manualBravo: PinTargetView = { kind: 'entry', entryId: 'e-bravo', label: 'bravo' }

  it('原样接受自动预选不写手动偏好', () => {
    expect(manualAfterChoice(null, autoAlpha, autoAlpha)).toBeNull()
  })

  it('从预选改选另一个落点才记手动偏好，并覆盖后续自动预选', () => {
    const stored = manualAfterChoice(null, autoAlpha, manualBravo)
    expect(stored).toEqual(manualBravo)
    expect(
      targetOf(resolvePinTarget({ manual: stored, main: noneMain, context, entries, selectedText: 'alpha' }))
    ).toBe('entry:e-bravo')
    expect(
      targetOf(resolvePinTarget({ manual: stored, main: noneMain, context, entries, selectedText: 'bravo' }))
    ).toBe('entry:e-bravo')
  })

  it('已有手动偏好时继续保持，不被自动预选替换', () => {
    expect(manualAfterChoice(manualBravo, manualBravo, manualBravo)).toEqual(manualBravo)
  })
})

describe('manual preference identity', () => {
  const manual: PinTargetView = { kind: 'unfiled' }

  it('同一主对象仍有效，主对象变了就丢弃旧偏好', () => {
    const stored = { target: manual, mainKey: mainFingerprint(noneMain) }
    expect(usableManualPreference(stored, mainFingerprint(noneMain))).toEqual(manual)
    const articleMain: ThreadMain = {
      kind: 'article',
      articleId: 'a-2',
      title: '另一篇',
      sessionLabel: '',
      setLabel: '',
      kindLabel: '',
      wordCount: 0
    }
    expect(usableManualPreference(stored, mainFingerprint(articleMain))).toBeNull()
  })
})
