import type { AppDatabase } from '../db/database'

/**
 * 「本篇已包含多少个学习者曾收过的词」。
 *
 * 口径不是「本篇收了多少条原句」，而是：学习者已经在别处收过的词里，
 * 有多少个在这篇正文里也出现了。一个词只在另一篇收过、正文里恰好出现，
 * 重读时也算「故人重逢」，必须计入。
 *
 * 匹配词条的主词形与已收变体（不分大小写、整词/整短语匹配），按词条去重；
 * 不做词形猜测，避免把没认识的词算成熟词。
 */

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function formPattern(form: string): RegExp {
  const pieces = form
    .trim()
    .split(/\s+/u)
    .filter((piece) => piece !== '')
    .map(escapeRegExp)
  return new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${pieces.join('\\s+')}(?:[^\\p{L}\\p{N}]|$)`,
    'iu'
  )
}

/** 本篇正文里出现的学习者已收词数（按词条去重）。 */
export function readArticlePreviouslyCollectedCount(
  database: AppDatabase,
  articleId: string
): number {
  const article = database
    .prepare('SELECT body_text FROM article WHERE id = ?')
    .get(articleId) as { body_text: string } | undefined
  if (!article) {
    return 0
  }

  const entries = database
    .prepare(
      `SELECT we.id, we.main_form
         FROM word_entry we
        WHERE EXISTS (SELECT 1 FROM entry_sentence es WHERE es.entry_id = we.id)`
    )
    .all() as { id: string; main_form: string }[]
  if (entries.length === 0) {
    return 0
  }

  const forms = new Map<string, Set<string>>()
  const surfaceRows = database
    .prepare('SELECT entry_id, surface FROM entry_sentence')
    .all() as { entry_id: string; surface: string }[]
  for (const row of surfaceRows) {
    const set = forms.get(row.entry_id) ?? new Set<string>()
    set.add(row.surface)
    forms.set(row.entry_id, set)
  }

  let known = 0
  for (const entry of entries) {
    const candidates = new Set<string>([entry.main_form, ...(forms.get(entry.id) ?? [])])
    for (const candidate of candidates) {
      const form = candidate.trim()
      if (form === '' || !formPattern(form).test(article.body_text)) {
        continue
      }
      known += 1
      break
    }
  }
  return known
}
