import type { ArticleDeletionPreview } from '../../../shared/library'

/**
 * 删除确认弹层里的三行影响面。原句关联、词条（存活 / 消失）、学习内容与钉住
 * 分别说清楚，避免把「会消失」和「仍保留」混成一个数字。
 */
export function deletionImpactLines(preview: ArticleDeletionPreview): string[] {
  const sentenceLine =
    preview.sentenceAssociationCount === 0
      ? '还没有收过原句。'
      : `将删除 ${preview.sentenceAssociationCount} 条原句关联。`
  const entryLine =
    preview.affectedEntryCount === 0
      ? '没有词条受影响。'
      : `影响 ${preview.affectedEntryCount} 个词条：${preview.survivingEntryCount} 个仍有别的原句、会保留，${preview.disappearingEntryCount} 个会连同 ${preview.disappearingLearningNoteCount} 条学习内容一起删除。`
  const pinLine =
    preview.articlePinCount === 0
      ? '没有挂在本篇的钉住。'
      : `${preview.articlePinCount} 条钉住会移到未归档，内容与出处仍可查看。`
  return [sentenceLine, entryLine, pinLine]
}
