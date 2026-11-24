import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { expect, test } from '../fixtures/app'
import { clickAway, doubleClickWord, dragBetweenWords, openArticle, selectText } from '../fixtures/reading'

/**
 * 阅读选词心流：双击英文词直接收词，拖选自动吸附完整词边界并在原句内重新圈定。
 * 全部用真实鼠标位置触发，不直接改 Range。
 */

const articleTitle = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-selection-flow',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['A well-known author wrote this, quietly.'],
    ['Employers approach hiring differently.'],
    ['She read (quietly), then left.']
  ]
})

let corpusDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-selection-flow-'))
  writeCorpusDirectory(corpusDirectory, [article])
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

test.describe('双击与拖选', () => {
  test('双击非已收集的英文单词直接收词，并弹选词卡', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    await doubleClickWord(page, 1, 'approach')

    await expect(page.locator('.reading-selected')).toHaveText(['approach'])
    const panel = page.getByRole('complementary', { name: '选词结果' })
    await expect(panel).toBeVisible()
    await expect(panel.locator('.reading-panel-word')).toContainText('approach')

    await clickAway(page)
    await expect(page.locator('.reading-collected')).toHaveText(['approach'])
  })

  test('双击已收集的英文单词打开词条卡，不重复收词', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    await doubleClickWord(page, 1, 'approach')
    await clickAway(page)
    await expect(page.locator('.reading-collected')).toHaveText(['approach'])

    await doubleClickWord(page, 1, 'approach')

    await expect(page.getByRole('complementary', { name: '词条' })).toBeVisible()
    await expect(page.getByRole('complementary', { name: '选词结果' })).toHaveCount(0)
    await expect(page.locator('.reading-collected')).toHaveText(['approach'])
  })

  test('拖选落在英文词内部时向外吸附到完整词边界，连字符词整词算一个', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    await dragBetweenWords(page, 0, 'well-known', 'author')

    await expect(page.locator('.reading-selected')).toHaveText(['well-known author'])
    await expect(
      page.getByRole('complementary', { name: '选词结果' }).locator('.reading-panel-word')
    ).toContainText('well-known author')
  })

  test('选区两端带的括号与逗号在收词前剥掉', async ({ launch }) => {
    const { page } = await launch({ env: { CORPUS_DIRECTORY: corpusDirectory } })
    await openArticle(page, articleTitle)

    await selectText(page, 2, '(quietly),')

    await expect(page.locator('.reading-selected')).toHaveText(['quietly'])
    await clickAway(page)
    await expect(page.locator('.reading-collected')).toHaveText(['quietly'])
  })
})
