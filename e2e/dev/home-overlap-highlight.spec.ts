import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'

/**
 * F2：同一句里收了一个词与包含它的短语（两个不同词条键），首页续读原句
 * 必须按权威区间的并集高亮完整短语，不能因为短区间先到就丢掉长短语后半段。
 */

const article = fixtureArticle({
  id: 'fixture-home-overlap',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [['Readers approach new methods.'], ['A second paragraph keeps the card readable.']]
})

const picks: SeedPick[] = [
  { entry: article, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
  { entry: article, paragraphIndex: 0, needle: 'approach new', at: '2026-11-18T08:05:00.000Z' }
]

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-home-overlap-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test('同句词 + 短语的区间并集完整高亮短语，原文不变', async ({ launch, userDataDirectory }) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.evaluate(async (articleId) => {
    const api = (window as unknown as {
      api: { invoke(channel: string, payload: unknown): Promise<unknown> }
    }).api
    await api.invoke('reading:open', { articleId })
  }, article.id)
  await page.reload()

  const card = page.getByRole('region', { name: '继续阅读' })
  const sentence = card.locator('.home-sentence')
  await expect(sentence).toHaveText('Readers approach new methods.')
  const marks = sentence.locator('.home-sentence-collected')
  await expect(marks).toHaveCount(1)
  await expect(marks).toHaveText(['approach new'])
  // 并集之外仍是普通文本，没有重复印字。
  await expect(sentence.locator('mark')).toHaveCount(1)
  const plain = await sentence.evaluate((element) => element.textContent)
  expect(plain).toBe('Readers approach new methods.')
})
