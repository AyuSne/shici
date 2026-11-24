import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { writeDictionaryFixture } from '../../src/testing/dictionary-fixture'
import { expect, test } from '../fixtures/app'
import { seedWordEntries } from '../fixtures/entries'
import { openArticle } from '../fixtures/reading'

/**
 * 重读时悬停已收集词约 250ms 的「悬停一瞥」：独立浮层，不重排正文；
 * 有置顶学习内容就展示它，没有才回退到离线词典首义。
 */

const articleTitle = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-glance-hover',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    ['Employers approach hiring differently.'],
    ['Practice keeps the skill alive over time.']
  ]
})

const pinnedBody = 'approach 常考「着手处理」，不是单纯的「接近」。'

let corpusDirectory: string
let dictionaryDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-glance-hover-'))
  writeCorpusDirectory(corpusDirectory, [article])

  dictionaryDirectory = await mkdtemp(join(tmpdir(), 'english-learning-glance-dict-'))
  writeDictionaryFixture(join(dictionaryDirectory, 'ecdict.db'), {
    entries: [
      {
        word: 'approach',
        phonetic: "ә'prәutʃ",
        translation: 'n. 方法, 途径\\nvt. 接近, 着手处理',
        exchange: 'i:approaching'
      },
      {
        word: 'hire',
        phonetic: 'haɪə',
        translation: 'vt. 雇请, 出租\\nn. 租金',
        exchange: 'i:hiring'
      }
    ],
    lemmas: [
      { form: 'approaching', lemma: 'approach' },
      { form: 'hiring', lemma: 'hire' }
    ]
  })
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  await rm(dictionaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function seed(userDataDirectory: string): void {
  seedWordEntries(userDataDirectory, corpusDirectory, {
    picks: [
      { entry: article, paragraphIndex: 0, needle: 'approach', at: '2026-11-18T08:00:00.000Z' },
      { entry: article, paragraphIndex: 0, needle: 'hiring', at: '2026-11-18T08:05:00.000Z' }
    ],
    notes: [{ entryMainForm: 'approach', body: pinnedBody, pinned: true }]
  })
}

test.describe('悬停一瞥', () => {
  test('悬停约 250ms 才浮出音标与置顶内容，不重排正文；无置顶时回退词典首义', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    const { page } = await launch({
      env: { CORPUS_DIRECTORY: corpusDirectory, DICTIONARY_DIRECTORY: dictionaryDirectory }
    })
    await openArticle(page, articleTitle)

    const paragraph = page.locator('.reading-paragraph').first()
    const boxBefore = await paragraph.boundingBox()
    const scrollBefore = await page
      .locator('.reading-scroll')
      .evaluate((element) => element.scrollTop)

    await page.locator('.reading-collected').filter({ hasText: 'approach' }).hover()
    await expect(page.locator('.reading-glance')).toHaveCount(0)

    await page.waitForTimeout(400)
    const glance = page.locator('.reading-glance')
    await expect(glance).toBeVisible()
    await expect(glance.locator('.reading-glance-phonetic')).toHaveText('/əˈprəutʃ/')
    await expect(glance).toContainText(pinnedBody)

    // 浮层不参与正文布局：段落位置与滚动都没动。
    expect(await paragraph.boundingBox()).toEqual(boxBefore)
    expect(
      await page.locator('.reading-scroll').evaluate((element) => element.scrollTop)
    ).toBe(scrollBefore)

    await page.mouse.move(2, 2)
    await expect(page.locator('.reading-glance')).toHaveCount(0)

    // 没有置顶内容时回退词典首义。
    await page.locator('.reading-collected').filter({ hasText: 'hiring' }).hover()
    await expect(glance).toBeVisible()
    await expect(glance.locator('.reading-glance-phonetic')).toHaveText('/haɪə/')
    await expect(glance).toContainText('雇请')

    // 打开词条卡时收起一瞥，不留在卡旁边。
    await page.locator('.reading-collected').filter({ hasText: 'approach' }).click()
    await expect(glance).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: '词条' })).toBeVisible()
  })

  test('悬停中途换词时只浮出新词，不被上一个词的迟到结果劫持', async ({
    launch,
    userDataDirectory
  }) => {
    seed(userDataDirectory)
    const { page } = await launch({
      env: { CORPUS_DIRECTORY: corpusDirectory, DICTIONARY_DIRECTORY: dictionaryDirectory }
    })
    await openArticle(page, articleTitle)

    await page.locator('.reading-collected').filter({ hasText: 'approach' }).hover()
    await page.waitForTimeout(100)
    await page.locator('.reading-collected').filter({ hasText: 'hiring' }).hover()
    await page.waitForTimeout(400)

    const glance = page.locator('.reading-glance')
    await expect(glance).toBeVisible()
    await expect(glance.locator('.reading-glance-phonetic')).toHaveText('/haɪə/')
    await expect(glance).toContainText('雇请')
    await expect(glance).not.toContainText(pinnedBody)
  })
})
