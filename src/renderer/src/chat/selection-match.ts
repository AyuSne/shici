/**
 * 组词对话里「选中一段 AI 回答 → 钉住」的落点智能预选。
 *
 * 只按本机已收集的词形与变体做纯文本匹配：英文词边界、大小写不敏感、短语允许
 * 空白/换行。命中唯一词条时才返回它；同时命中多个词条（歧义）或一个都没有时返回
 * null，让用户自己选，绝不猜。
 */

export type EntryMatchCandidate = {
  entryId: string
  mainForm: string
  variants: readonly string[]
}

type Scored = { candidate: EntryMatchCandidate; score: number }

const WORD_CHAR = `[\\p{Script=Latin}\\p{Nd}']`

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 小写、折叠空白、统一撇号；两边空白没有意义。 */
function normalize(value: string): string {
  return value
    .replace(/[’‘]/g, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function formOf(value: string): string {
  return normalize(value)
}

function boundedPattern(form: string): RegExp {
  const body = form
    .split(' ')
    .map((part) => escapeRegex(part))
    .join('\\s+')
  return new RegExp(`(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})`, 'u')
}

/** 一条词形对选中片段的最高分：整段相等 3，按词边界出现 2，没出现 0。 */
function scoreOf(selection: string, form: string): number {
  if (form === '') return 0
  if (selection === form) return 3
  return boundedPattern(form).test(selection) ? 2 : 0
}

/**
 * 返回唯一命中的词条；上下文为空、没有命中或同分命中多个词条时返回 null。
 * 只使用 `mainForm` 与 `variants`，不读取任何界面/对话状态。
 */
export function matchSelectedEntry(
  selectedText: string,
  candidates: readonly EntryMatchCandidate[]
): EntryMatchCandidate | null {
  const selection = normalize(selectedText)
  if (selection === '' || candidates.length === 0) return null

  const scored: Scored[] = []
  for (const candidate of candidates) {
    const forms = [candidate.mainForm, ...candidate.variants]
    let best = 0
    for (const raw of forms) {
      best = Math.max(best, scoreOf(selection, formOf(raw)))
    }
    if (best > 0) {
      scored.push({ candidate, score: best })
    }
  }
  if (scored.length === 0) return null
  const top = Math.max(...scored.map((entry) => entry.score))
  const best = scored.filter((entry) => entry.score === top)
  return best.length === 1 ? best[0]!.candidate : null
}
