import type {
  EntrySentenceSnapshot,
  RestoreEntrySentenceResult
} from '../../shared/entries'
import type { AppDatabase } from '../db/database'
import { refreshLastCollected } from './entry-state'
import {
  readArticleCollections,
  readEntrySentence,
  readEntrySummary
} from './queries'

/**
 * 单条原句删除后的撤销恢复。快照只由删除结果给出，且只覆盖非最后一条：
 * 最后一条删除会连词条与学习内容一起删掉，仍走显式危险确认，不走这条恢复路径。
 *
 * 恢复按快照原样写回同一条关联，不重新解析选区、不改主词形、不新建词条；
 * 原文 / 段落 / 句子或词条已经不存在时明确拒绝，不复活已删内容。
 * 同一个 id 重复恢复是幂等的；同一句锚点已被后来的收集占用时拒绝，绝不覆盖。
 */
export function restoreEntrySentence(
  database: AppDatabase,
  snapshot: EntrySentenceSnapshot
): RestoreEntrySentenceResult {
  const stored = database
    .prepare('SELECT id, entry_id, article_id, paragraph_id, sentence_ordinal FROM entry_sentence WHERE id = ?')
    .get(snapshot.id) as
    | {
        id: string
        entry_id: string
        article_id: string
        paragraph_id: string
        sentence_ordinal: number
      }
    | undefined

  if (stored) {
    // 同一 id 已经在：只有完全同一条关联才算重复恢复；被挪到别处或被改写时不覆盖。
    if (
      stored.entry_id !== snapshot.entryId ||
      stored.article_id !== snapshot.articleId ||
      stored.paragraph_id !== snapshot.paragraphId ||
      stored.sentence_ordinal !== snapshot.sentenceOrdinal
    ) {
      return { status: 'rejected', reason: 'conflict' }
    }
    return readRestored(database, snapshot)
  }

  const entry = readEntrySummary(database, snapshot.entryId)
  if (!entry) {
    return { status: 'rejected', reason: 'entry' }
  }

  const source = readSource(database, snapshot)
  if (source === null) {
    return { status: 'rejected', reason: 'source' }
  }

  const occupied = database
    .prepare(
      `SELECT id FROM entry_sentence
        WHERE entry_id = ? AND article_id = ? AND paragraph_id = ? AND sentence_ordinal = ?`
    )
    .get(
      snapshot.entryId,
      snapshot.articleId,
      snapshot.paragraphId,
      snapshot.sentenceOrdinal
    ) as { id: string } | undefined
  if (occupied) {
    // 删除之后用户又在同一句里收了同一个词：保留后来的那条，不覆盖。
    return { status: 'rejected', reason: 'conflict' }
  }

  const written = database.transaction((): boolean => {
    database
      .prepare(
        `INSERT INTO entry_sentence (
           id, entry_id, article_id, paragraph_id, sentence_ordinal,
           surface, char_start, char_end, collected_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        snapshot.id,
        snapshot.entryId,
        snapshot.articleId,
        snapshot.paragraphId,
        snapshot.sentenceOrdinal,
        snapshot.surface,
        snapshot.start,
        snapshot.end,
        snapshot.collectedAt
      )
    // 收集时间可能早于后来收的词；refresh 取剩余原句的最大值，不会倒拨。
    refreshLastCollected(database, snapshot.entryId)
    return true
  })()

  return written ? readRestored(database, snapshot) : { status: 'missing' }
}

type SourceRange = { sentenceStart: number; sentenceEnd: number; text: string }

/** 原文、段落与句子都还在，且快照的区间与当时的词形逐字对应时才算可恢复。 */
function readSource(
  database: AppDatabase,
  snapshot: EntrySentenceSnapshot
): SourceRange | null {
  const article = database
    .prepare('SELECT id FROM article WHERE id = ?')
    .get(snapshot.articleId) as { id: string } | undefined
  if (!article) return null
  const paragraph = database
    .prepare('SELECT text FROM paragraph WHERE article_id = ? AND id = ?')
    .get(snapshot.articleId, snapshot.paragraphId) as { text: string } | undefined
  if (!paragraph) return null
  const sentence = database
    .prepare(
      `SELECT char_start, char_end FROM sentence
        WHERE article_id = ? AND paragraph_id = ? AND ordinal = ?`
    )
    .get(snapshot.articleId, snapshot.paragraphId, snapshot.sentenceOrdinal) as
    | { char_start: number; char_end: number }
    | undefined
  if (!sentence) return null
  if (
    snapshot.start < sentence.char_start ||
    snapshot.end > sentence.char_end ||
    snapshot.start >= snapshot.end
  ) {
    return null
  }
  if (paragraph.text.slice(snapshot.start, snapshot.end) !== snapshot.surface) {
    return null
  }
  return {
    sentenceStart: sentence.char_start,
    sentenceEnd: sentence.char_end,
    text: paragraph.text
  }
}

/** 恢复后的读回；entry 或 sentence 在并发删除中消失时按 missing 处理。 */
function readRestored(
  database: AppDatabase,
  snapshot: EntrySentenceSnapshot
): RestoreEntrySentenceResult {
  const entry = readEntrySummary(database, snapshot.entryId)
  const sentence = readEntrySentence(database, snapshot.id)
  if (!entry || !sentence) {
    return { status: 'missing' }
  }
  return {
    status: 'restored',
    entry,
    sentence,
    articleId: snapshot.articleId,
    marks: readArticleCollections(database, snapshot.articleId)
  }
}
