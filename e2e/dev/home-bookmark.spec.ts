import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries, type SeedPick } from '../fixtures/entries'

/**
 * #80 首页「继续阅读」书页卡：3px 琥珀书签竖线、衬线体上次原句、
 * 卡片底部速览本篇最近拾下的词条（最多 4 个，点一下直达词条）。
 */

const article = fixtureArticle({
  id: 'fixture-home-bookmark-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    [
      'Employers approach hiring differently.',
      'Context keeps the skill alive.',
      'A steady habit keeps the reading going.',
      'Patience pays off in the long run.',
      'Repeated words stick.'
    ]
  ]
})

const other = fixtureArticle({
  id: 'fixture-home-bookmark-2024-06-s2-b',
  year: 2024,
  month: 6,
  set: 2,
  sentences: [['A different article offers another perspective.']]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-home-bookmark-'))
  writeCorpusDirectory(corpusDirectory, [article, other])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

const picks: SeedPick[] = [
  { entry: article, paragraphIndex: 0, needle: 'Employers', at: '2026-11-18T08:00:00.000Z' },
  { entry: article, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:01:00.000Z' },
  { entry: article, paragraphIndex: 0, needle: 'hiring', at: '2026-11-18T08:02:00.000Z' },
  { entry: article, paragraphIndex: 0, needle: 'differently', at: '2026-11-18T08:03:00.000Z' },
  { entry: article, paragraphIndex: 0, needle: 'Context', at: '2026-11-18T08:04:00.000Z' },
  { entry: other, paragraphIndex: 0, needle: 'different', at: '2026-11-18T08:05:00.000Z' }
]

test('继续阅读卡带 3px 琥珀竖线与衬线原句，底部速览本篇最近 4 个词条', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  // 打开过才有续读卡；seedWordEntries 不写阅读位置，先经由首页进入再返回会留位置，
  // 所以这里直接在库里打开一篇。
  await page.evaluate(async (articleId) => {
    const api = (window as unknown as {
      api: { invoke(channel: string, payload: unknown): Promise<unknown> }
    }).api
    await api.invoke('reading:open', { articleId })
  }, article.id)
  await page.reload()

  const card = page.getByRole('region', { name: '继续阅读' })
  await expect(card).toBeVisible()

  const bookmark = await card.evaluate((element) => {
    const style = getComputedStyle(element, '::before')
    return { width: style.width, background: style.backgroundColor }
  })
  expect(bookmark.width).toBe('3px')
  expect(bookmark.background).toBe('rgb(143, 90, 26)')

  const sentence = card.locator('.home-sentence')
  await expect(sentence).toHaveText('Employers approach hiring differently.')
  const font = await sentence.evaluate((element) => getComputedStyle(element).fontFamily)
  expect(font.toLowerCase()).toContain('source serif')

  const chips = card.locator('.home-picked-chip')
  await expect(chips).toHaveCount(4)
  // 本篇最近拾下的 4 个：Context、differently、hiring、approach；另一篇的 different 不混入。
  await expect(chips).toHaveText(['Context', 'differently', 'hiring', 'approach'])
  await expect(card.getByText('different', { exact: true })).toHaveCount(0)

  await chips.filter({ hasText: 'Context' }).click()
  await expect(page.getByRole('heading', { name: '词条', level: 1 })).toBeVisible()
  await expect(
    page.getByRole('region', { name: '词条内容' }).getByRole('heading', { name: 'Context', level: 2 })
  ).toBeVisible()
})

test('本篇还没拾词时卡片照常出现，只是不摆空 chip 行', async ({
  launch,
  userDataDirectory
}) => {
  seedWordEntries(userDataDirectory, corpusDirectory, { picks: [] })
  const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
  await page.evaluate(async (articleId) => {
    const api = (window as unknown as {
      api: { invoke(channel: string, payload: unknown): Promise<unknown> }
    }).api
    await api.invoke('reading:open', { articleId })
  }, article.id)
  await page.reload()

  const card = page.getByRole('region', { name: '继续阅读' })
  await expect(card).toBeVisible()
  await expect(card.locator('.home-picked')).toHaveCount(0)
  await expect(card.getByRole('button', { name: '继续阅读' })).toBeVisible()
})
