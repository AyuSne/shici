import { describe, expect, it } from 'vitest'
import { matchSelectedEntry } from './selection-match'

const approach = { entryId: 'e-approach', mainForm: 'approach', variants: ['approached', 'approaches'] }
const approachable = { entryId: 'e-approachable', mainForm: 'approachable', variants: [] }
const issue = { entryId: 'e-issue', mainForm: 'issue', variants: [] }
const takeOff = { entryId: 'e-take-off', mainForm: 'take off', variants: [] }

describe('matchSelectedEntry', () => {
  it('选中片段里出现唯一词条的主词形时命中，忽略大小写和首尾标点', () => {
    expect(matchSelectedEntry('（Approach）', [approach, issue])?.entryId).toBe('e-approach')
  })

  it('按已收集变体命中，而不是只认主词形', () => {
    expect(matchSelectedEntry('he approaches the issue', [approach])?.entryId).toBe(
      'e-approach'
    )
  })

  it('按英文词边界判断，长词里不误命中短词', () => {
    expect(matchSelectedEntry('an approachable clerk', [approach])).toBeNull()
    expect(
      matchSelectedEntry('an approachable clerk', [approach, approachable])?.entryId
    ).toBe('e-approachable')
  })

  it('多个词条的词形同时出现时不猜，交给用户手动选', () => {
    expect(matchSelectedEntry('approach the issue', [approach, issue])).toBeNull()
  })

  it('同一词形属于多个词条时也不猜', () => {
    const other = { entryId: 'e-other', mainForm: 'approach', variants: [] }
    expect(matchSelectedEntry('approach', [approach, other])).toBeNull()
  })

  it('多词短语允许中间换行或连续空白', () => {
    expect(matchSelectedEntry('they take\n  off quickly', [takeOff])?.entryId).toBe(
      'e-take-off'
    )
  })

  it('变体整段命中时压过只作为前缀的另一词条主词形', () => {
    const variantOwner = {
      entryId: 'e-variant',
      mainForm: 'approach',
      variants: ['approaches']
    }
    expect(
      matchSelectedEntry('he approaches it', [
        { entryId: 'e-plain', mainForm: 'approach', variants: [] },
        variantOwner
      ])?.entryId
    ).toBe('e-variant')
  })

  it('没有词条上下文或没有命中时返回 null', () => {
    expect(matchSelectedEntry('approach', [])).toBeNull()
    expect(matchSelectedEntry('zebra', [approach])).toBeNull()
    expect(matchSelectedEntry('   ', [approach])).toBeNull()
  })
})
