import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { writeDictionaryFixture } from '../../src/testing/dictionary-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'
import { clickAway, openArticle, selectText } from '../fixtures/reading'

/**
 * 阅读里的「故人重逢」与置顶学习内容：顶栏先数出本篇已包含多少个
 * 学习者在别处收过的词；选词卡与词条卡再带出置顶摘要与一条别篇原句。
 */

const currentTitle = '2026年6月 · 第1套 · 仔细阅读 Passage One'
const otherTitle = '2023年12月 · 第2套 · 仔细阅读 Passage One'

const currentArticle = fixtureArticle({
  id: 'fixture-enrich-current',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.'],
    ['Approaching a new desk takes patience.']
  ]
})

const otherArticle = fixtureArticle({
  id: 'fixture-enrich-other',
  year: 2023,
  month: 12,
  set: 2,
  sentences: [['She approached the counter quietly.']]
})

const pinnedBody = 'approach 常考「着手处理」，不是单纯的「接近」。'

let corpusDirectory: string
let dictionaryDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-enrichment-'))
  writeCorpusDirectory(corpusDirectory, [currentArticle, otherArticle])

  dictionaryDirectory = await mkdtemp(join(tmpdir(), 'english-learning-enrichment-dict-'))
  writeDictionaryFixture(join(dictionaryDirectory, 'ecdict.db'), {
    entries: [
      {
        word: 'approach',
        phonetic: "ә'prәutʃ",
        translation: 'n. 方法, 途径\\nvt. 接近, 着手处理',
        exchange: 'p:approached/d:approached/i:approaching/3:approaches'
      }
    ],
    lemmas: [
      { form: 'approached', lemma: 'approach' },
      { form: 'approaching', lemma: 'approach' }
    ]
  })
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  await rm(dictionaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function environment(): Record<string, string> {
  return {
    CORPUS_DIRECTORY: corpusDirectory,
    DICTIONARY_DIRECTORY: dictionaryDirectory
  }
}

function seedOtherArticle(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [{ entry: otherArticle, paragraphIndex: 0, needle: 'approach' }],
    notes: [{ entryMainForm: 'approach', body: pinnedBody, pinned: true }]
  })
}

test.describe('阅读里的故人重逢与置顶学习内容', () => {
  test('顶栏元信息数的是本篇包含的已收词，包括只在别篇收过、这篇正文里出现的词', async ({
    launch,
    userDataDirectory
  }) => {
    seedOtherArticle(userDataDirectory)
    const { page } = await launch({ env: environment() })
    await openArticle(page, currentTitle)

    await expect(page.locator('.reading-bar-meta')).toHaveText('本篇已拾 1 个词')
  })

  test('选词卡词头不再重复，同行给音标，并带出置顶摘要与一条别篇原句', async ({
    launch,
    userDataDirectory
  }) => {
    seedOtherArticle(userDataDirectory)
    const { page } = await launch({ env: environment() })
    await openArticle(page, currentTitle)

    await selectText(page, 0, 'approach')

    const panel = page.getByRole('complementary', { name: '选词结果' })
    await expect(panel).toBeVisible()
    const head = panel.locator('.reading-panel-word')
    await expect(head).toContainText('approach')
    await expect(panel.locator('.reading-panel-phonetic')).toHaveText('/əˈprəutʃ/')
    // 词形与主词形相同时，词头只印这一次，不再连续重复「词条 approach」。
    await expect(panel.locator('.dictionary-word')).toHaveCount(0)
    await expect(panel.locator('.reading-panel-entry')).toHaveText('已收进词条')
    await expect(panel.locator('.reading-panel-entry')).not.toContainText('approach')

    const pinned = panel.locator('.reading-panel-pinned')
    await expect(pinned).toContainText('置顶学习内容')
    await expect(pinned).toContainText(pinnedBody)

    const encounter = panel.locator('.reading-panel-encounter')
    await expect(encounter).toContainText('故人重逢')
    await expect(encounter).toContainText(otherTitle)
    await expect(encounter).toContainText('She approached the counter quietly.')
  })

  test('词形与主词形不同才标归入关系；词条卡首屏给置顶内容与故人重逢', async ({
    launch,
    userDataDirectory
  }) => {
    seedOtherArticle(userDataDirectory)
    const { page } = await launch({ env: environment() })
    await openArticle(page, currentTitle)

    await selectText(page, 0, 'approach')
    await clickAway(page)
    await selectText(page, 1, 'Approaching')

    const panel = page.getByRole('complementary', { name: '选词结果' })
    await expect(panel.locator('.reading-panel-word')).toContainText('Approaching')
    await expect(panel.locator('.reading-panel-entry')).toHaveText('归入词条 approach')
    await expect(panel.locator('.dictionary-word')).toHaveCount(0)

    await clickAway(page)
    await page.locator('.reading-collected').filter({ hasText: 'Approaching' }).click()

    const card = page.getByRole('complementary', { name: '词条' })
    await expect(card).toBeVisible()
    await expect(card.locator('.reading-panel-pinned')).toContainText(pinnedBody)
    await expect(card.locator('.reading-panel-encounter')).toContainText(
      'She approached the counter quietly.'
    )

    const pinnedBox = await card.locator('.reading-panel-pinned').boundingBox()
    const firstSentenceBox = await card.locator('.reading-panel-sentence-row').first().boundingBox()
    expect(pinnedBox?.y ?? 0).toBeLessThan(firstSentenceBox?.y ?? 0)
  })
})
