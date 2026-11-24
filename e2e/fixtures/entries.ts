import { importCorpus } from '../../src/main/corpus/import'
import { openDatabase } from '../../src/main/db/database'
import { migrate } from '../../src/main/db/migrations'
import { collectSelection } from '../../src/main/entries/queries'
import { createLearningNote, pinLearningNote } from '../../src/main/entries/notes'
import type { FixtureEntry } from '../../src/testing/corpus-fixture'
import { databasePath } from './database'

/**
 * 直接在测试用的 userData 里建一本有词条的小库：迁移、导入语料、按段圈词。
 * 词条页的用例因此不必每次都先走一遍阅读页去收集。
 */
export type SeedPick = {
  entry: FixtureEntry
  paragraphIndex: number
  /** 段里要圈的表达，逐字出现。 */
  needle: string
  /** 收集时间；不写就按顺序往后排。 */
  at?: string
}

export type SeedNote = {
  entryMainForm: string
  body: string
  /** 阅读卡与悬停一瞥只展示置顶那条。 */
  pinned?: boolean
}

type JsonParagraph = {
  id: string
  text: string
  sentences: { ordinal: number; text: string; start: number; end: number }[]
}

function paragraphAt(entry: FixtureEntry, index: number): JsonParagraph {
  const paragraph = (entry.json.paragraphs as JsonParagraph[])[index]
  if (!paragraph) {
    throw new Error(`语料 ${entry.id} 没有第 ${index} 段`)
  }
  return paragraph
}

function requestOf(pick: SeedPick) {
  const paragraph = paragraphAt(pick.entry, pick.paragraphIndex)
  const start = paragraph.text.indexOf(pick.needle)
  if (start < 0) {
    throw new Error(`语料 ${pick.entry.id} 第 ${pick.paragraphIndex} 段没有 ${pick.needle}`)
  }
  const sentenceOrdinal = paragraph.sentences.findIndex(
    (candidate) => candidate.start <= start && start < candidate.end
  )
  return {
    articleId: pick.entry.id,
    paragraphId: paragraph.id,
    sentenceOrdinal,
    start,
    end: start + pick.needle.length
  }
}

export function seedWordEntries(
  userDataDirectory: string,
  corpusDirectory: string,
  options: { picks: readonly SeedPick[]; notes?: readonly SeedNote[] }
): void {
  const database = openDatabase(databasePath(userDataDirectory))
  try {
    migrate(database)
    importCorpus(database, { directory: corpusDirectory })

    options.picks.forEach((pick, index) => {
      const at =
        pick.at ?? new Date(Date.UTC(2026, 10, 18, 8, index * 5)).toISOString()
      const result = collectSelection(database, requestOf(pick), { now: at })
      if (result.status === 'rejected') {
        throw new Error(`圈 ${pick.needle} 被拒绝：${result.reason}`)
      }
    })

    for (const note of options.notes ?? []) {
      const entry = database
        .prepare('SELECT id FROM word_entry WHERE main_form = ?')
        .get(note.entryMainForm) as { id: string } | undefined
      if (!entry) {
        throw new Error(`没有词条 ${note.entryMainForm}`)
      }
      const created = createLearningNote(database, { entryId: entry.id, body: note.body })
      if (note.pinned === true) {
        if (created.status !== 'saved') {
          throw new Error(`学习内容没有写成：${note.entryMainForm}`)
        }
        pinLearningNote(database, { noteId: created.note.id, pinned: true })
      }
    }
  } finally {
    database.close()
  }
}
