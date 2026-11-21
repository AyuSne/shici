import { describe, expect, it } from 'vitest'
import type { ArticleDeletionPreview } from '../../../shared/library'
import { deletionImpactLines } from './impact'

const preview: ArticleDeletionPreview = {
  articleId: 'article-1',
  sentenceAssociationCount: 4,
  affectedEntryCount: 3,
  disappearingEntryCount: 2,
  survivingEntryCount: 1,
  disappearingLearningNoteCount: 5,
  articlePinCount: 2
}

describe('deletionImpactLines', () => {
  it('把原句关联、存活与消失词条、学习内容和钉住分开说清楚', () => {
    expect(deletionImpactLines(preview)).toEqual([
      '将删除 4 条原句关联。',
      '影响 3 个词条：1 个仍有别的原句、会保留，2 个会连同 5 条学习内容一起删除。',
      '2 条钉住会移到未归档，内容与出处仍可查看。'
    ])
  })

  it('没有词条或钉住时不编造数字', () => {
    expect(
      deletionImpactLines({
        ...preview,
        sentenceAssociationCount: 0,
        affectedEntryCount: 0,
        disappearingEntryCount: 0,
        survivingEntryCount: 0,
        disappearingLearningNoteCount: 0,
        articlePinCount: 0
      })
    ).toEqual(['还没有收过原句。', '没有词条受影响。', '没有挂在本篇的钉住。'])
  })
})
