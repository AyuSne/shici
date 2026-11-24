/**
 * 回答的未完成状态。对话页与轻问抽屉必须说同一句话：停止是「已停止 · 未完成」，
 * 出错但有半截正文是「未完成」。正常完成不显示任何角标。
 */
export function answerStatusLabel(answer: {
  phase: 'done' | 'stopped' | 'error'
  text: string
}): string | null {
  if (answer.phase === 'stopped') return '已停止 · 未完成'
  if (answer.phase === 'error' && answer.text.trim() !== '') return '未完成'
  return null
}
