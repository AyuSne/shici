import type { Pin, PinSourceStatus, PinTarget, PinTargetView } from '../../../shared/pins'
import { excerptText } from '../../../shared/excerpt'
import type { ThreadMain } from '../../../shared/threads'

/** 线程主对象决定默认落点：挂词条 / 原句 → 词条，挂文章 → 文章，空白 → 未归档。 */
export function defaultPinTarget(main: ThreadMain): PinTargetView {
  switch (main.kind) {
    case 'entry':
      return { kind: 'entry', entryId: main.entryId, label: main.mainForm }
    case 'sentence':
      return { kind: 'entry', entryId: main.entryId, label: main.mainForm }
    case 'article':
      return { kind: 'article', articleId: main.articleId, label: main.title }
    case 'none':
      return { kind: 'unfiled' }
  }
}

export function targetLabel(target: PinTargetView): string {
  if (target.kind === 'unfiled') {
    return '未归档'
  }
  return target.label
}

/** 「已钉到词条 lament」/「已放进未归档」；对话页与轻问抽屉共用同一句回执。 */
export function pinnedLabel(pin: Pick<Pin, 'target'>): string {
  if (pin.target.kind === 'unfiled') {
    return '已放进未归档'
  }
  return `已钉到${pin.target.kind === 'entry' ? '词条' : '文章'} ${pin.target.label}`
}

/** 移动时只把落点的种类与 id 发回主进程，标签留在本地显示。 */
export function targetFromView(target: PinTargetView): PinTarget {
  if (target.kind === 'entry') {
    return { kind: 'entry', entryId: target.entryId }
  }
  if (target.kind === 'article') {
    return { kind: 'article', articleId: target.articleId }
  }
  return { kind: 'unfiled' }
}

export function samePinTarget(left: PinTarget, right: PinTarget): boolean {
  if (left.kind !== right.kind) {
    return false
  }
  if (left.kind === 'entry' && right.kind === 'entry') {
    return left.entryId === right.entryId
  }
  if (left.kind === 'article' && right.kind === 'article') {
    return left.articleId === right.articleId
  }
  return true
}

function clockText(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

/** 钉住卡的出处行：「lament · 第 2 轮 · deepseek-flash · 09:05」。 */
export function pinProvenanceText(pin: Pick<Pin, 'provenance' | 'createdAt'>): string {
  const parts: string[] = []
  if (pin.provenance.threadTitle !== '') {
    parts.push(pin.provenance.threadTitle)
  }
  parts.push(`第 ${pin.provenance.turnIndex} 轮`)
  if (pin.provenance.model !== '') {
    parts.push(pin.provenance.model)
  }
  const clock = clockText(pin.createdAt)
  if (clock !== '') {
    parts.push(clock)
  }
  return parts.join(' · ')
}

/** 只有不可跳转的来源需要说明。 */
export function pinSourceIssueText(status: PinSourceStatus): string | null {
  if (status === 'thread-deleted') return '源对话已删除'
  if (status === 'answer-missing') return '原回答找不到'
  return null
}

/** 卡片摘录：压掉换行，太长截断；完整的正文留在快照里。 */
export function pinExcerpt(text: string, limit = 160): string {
  return excerptText(text, limit)
}
