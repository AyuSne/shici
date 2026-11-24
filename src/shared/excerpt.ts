/**
 * 界面摘要文本的唯一截断规则：压掉换行与多余空白，按字符（码点）截断，
 * 超长用省略号收尾。词条卡摘要、学习内容摘要与钉住摘录共用同一套行为。
 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

export function excerptText(text: string, limit: number): string {
  const flat = collapseWhitespace(text)
  const characters = Array.from(flat)
  return characters.length <= limit ? flat : `${characters.slice(0, limit).join('')}…`
}
