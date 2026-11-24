import type { Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureArticle, writeCorpusDirectory } from '../../src/testing/corpus-fixture'
import { writeDictionaryFixture } from '../../src/testing/dictionary-fixture'
import { startSseStub, type SseStub } from '../../src/testing/sse-stub'
import { expect, test } from '../fixtures/app'
import { selectAnswerText } from '../fixtures/answer-selection'
import { seedWordEntries } from '../fixtures/entries'
import { clickAway, openArticle, selectText } from '../fixtures/reading'

/**
 * 内置词典：阅读划词卡、词条页右栏、对话划词浮卡三处都要能离线查，
 * 查不到时明说，一条释义能起草学习内容但不自动保存。
 *
 * 词典用小 fixture 库，语料也是 fixture，不依赖真实 ECDICT 的裁剪结果。
 */

const articleTitle = '2026年6月 · 第1套 · 仔细阅读 Passage One'

const article = fixtureArticle({
  id: 'fixture-2026-06-s1-c1',
  year: 2026,
  month: 6,
  set: 1,
  sentences: [
    [
      'Employers approach hiring differently.',
      'Approaching a new desk takes patience and a little nerve.'
    ],
    ['She approached the counter quietly.', 'Practice keeps the skill alive over time.']
  ]
})

const dictionary = {
  entries: [
    {
      word: 'approach',
      phonetic: "ә'prәutʃ",
      translation:
        'n. 方法, 途径\\nvt. 接近, 着手处理\\nvi. 靠近\\na. 可接近的\\nadv. 接近地',
      exchange: 'p:approached/d:approached/i:approaching/3:approaches'
    },
    {
      word: 'hire',
      phonetic: "'haiә",
      translation: 'vt. 雇请, 出租\\nn. 租金',
      exchange: 'p:hired/d:hired/i:hiring/3:hires'
    },
    {
      word: 'counter',
      phonetic: "'kauntә",
      translation: 'n. 柜台\\nv. 反驳'
    }
  ],
  lemmas: [
    { form: 'approached', lemma: 'approach' },
    { form: 'approaching', lemma: 'approach' },
    { form: 'approaches', lemma: 'approach' },
    { form: 'hiring', lemma: 'hire' }
  ]
}

const stubs: SseStub[] = []
let corpusDirectory: string
let dictionaryDirectory: string

test.beforeAll(async () => {
  corpusDirectory = await mkdtemp(join(tmpdir(), 'english-learning-dictionary-corpus-'))
  writeCorpusDirectory(corpusDirectory, [article])

  dictionaryDirectory = await mkdtemp(join(tmpdir(), 'english-learning-dictionary-db-'))
  writeDictionaryFixture(join(dictionaryDirectory, 'ecdict.db'), dictionary)
})

test.afterEach(async () => {
  await Promise.all(stubs.splice(0).map((stub) => stub.close()))
})

test.afterAll(async () => {
  await rm(corpusDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  await rm(dictionaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function environment(extra: Record<string, string> = {}): Record<string, string> {
  return {
    CORPUS_DIRECTORY: corpusDirectory,
    DICTIONARY_DIRECTORY: dictionaryDirectory,
    ...extra
  }
}

async function selectInReading(page: Page, paragraphIndex: number, text: string) {
  await selectText(page, paragraphIndex, text)
  return page.getByRole('complementary', { name: '选词结果' })
}

test.describe('内置词典', () => {
  test('阅读划词卡首屏给音标与词性释义，前三条展开、其余折叠，且不碰模型', async ({
    launch
  }) => {
    const stub = await startSseStub({ kind: 'stream', text: ['不会用到。'] })
    stubs.push(stub)
    const { page } = await launch({
      env: environment({
        DEEPSEEK_BASE_URL: stub.baseUrl,
        DEEPSEEK_API_KEY: 'e2e-test-key',
        DEEPSEEK_MODEL: 'deepseek-flash'
      })
    })
    await openArticle(page, articleTitle)

    const panel = await selectInReading(page, 0, 'approach')
    // 卡头已把词形与音标并排展示，词典块不再重复印一遍词头。
    await expect(panel.locator('.reading-panel-word')).toHaveText('approach')
    await expect(panel.locator('.reading-panel-phonetic')).toHaveText('/əˈprəutʃ/')
    await expect(panel.locator('.dictionary-word')).toHaveCount(0)
    const block = panel.locator('.dictionary')
    await expect(block.locator('.dictionary-sense')).toHaveCount(3)
    await expect(block.locator('.dictionary-pos')).toHaveText(['n.', 'vt.', 'vi.'])
    await expect(block.getByRole('button', { name: '展开其余 2 条' })).toBeVisible()

    await block.getByRole('button', { name: '展开其余 2 条' }).click()
    await expect(block.locator('.dictionary-sense')).toHaveCount(5)
    await expect(block.getByRole('button', { name: '收起' })).toBeVisible()

    // 词形变化回退到原形，音标与释义来自原形。
    await clickAway(page)
    const second = await selectInReading(page, 0, 'hiring')
    await expect(second.locator('.reading-panel-word')).toHaveText('hiring')
    await expect(second.locator('.reading-panel-phonetic')).toHaveText('/ˈhaiə/')
    const hire = second.locator('.dictionary')
    await expect(hire.locator('.dictionary-lemma')).toHaveText('由 hiring 归到原形')
    await expect(hire.locator('.dictionary-sense-text').first()).toContainText('雇请')

    // 查词全程没有向模型服务发过请求。
    expect(stub.requests).toHaveLength(0)
  })

  test('查不到时明说没收录', async ({ launch }) => {
    const { page } = await launch({ env: environment() })
    await openArticle(page, articleTitle)

    const panel = await selectInReading(page, 0, 'patience')
    await expect(panel.locator('.dictionary-status')).toHaveText('没收录 · 去问 LLM')
  })

  test('词条页右栏能查词典，一条释义起草到编辑框但不自动保存', async ({
    launch,
    userDataDirectory
  }) => {
    seedWordEntries(userDataDirectory, corpusDirectory, {
      picks: [{ entry: article, paragraphIndex: 0, needle: 'approach' }]
    })
    const { page } = await launch({ env: environment() })

    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '词条' })
      .click()
    await page.locator('.entries-row').first().click()
    await page.getByRole('button', { name: '展开学习内容' }).click()

    const rail = page.locator('.entries-rail-open')
    const block = rail.getByRole('group', { name: '词典' })
    await expect(block.locator('.dictionary-word')).toHaveText('approach')
    await expect(block.locator('.dictionary-phonetic')).toHaveText('/əˈprəutʃ/')

    await block.getByRole('button', { name: '用这条起草' }).first().click()
    const editor = rail.getByRole('textbox', { name: '写学习内容' })
    await expect(editor).toHaveValue('approach /əˈprəutʃ/\nn. 方法, 途径')

    // 只是草稿：还没有学习内容，也没有替用户点保存。
    await expect(rail.locator('.entry-note')).toHaveCount(0)
    await expect(rail.getByText('可以手写，也可以从对话里钉一段进来')).toBeVisible()

    // 学习者显式保存后才入库。
    await rail.getByRole('button', { name: '保存学习内容' }).click()
    await expect(rail.locator('.entry-note-body')).toContainText('方法, 途径')
  })

  test('对话里选中片段只浮出钉住/追问/复制三项，不带词典释义', async ({ launch }) => {
    const stub = await startSseStub({ kind: 'stream', text: ['Approach matters here.'] })
    stubs.push(stub)
    const { page } = await launch({
      env: environment({
        DEEPSEEK_BASE_URL: stub.baseUrl,
        DEEPSEEK_API_KEY: 'e2e-test-key',
        DEEPSEEK_MODEL: 'deepseek-flash'
      })
    })

    await page
      .getByRole('navigation', { name: '全局导航' })
      .getByRole('button', { name: '对话' })
      .click()
    await expect(page.getByRole('heading', { name: '新的学习', level: 1 })).toBeVisible()
    await page.getByRole('textbox', { name: '输入问题' }).fill('这个词怎么用？')
    await page.getByRole('button', { name: '发送' }).click()
    await expect(page.locator('.assistant-text')).toContainText('Approach matters here.')

    // 选中单词或短语都只有统一的三个动作；离线词典只在词条右栏查。
    await selectAnswerWord(page, 'Approach')
    const capsule = page.locator('.selection-capsule')
    await expect(capsule.getByRole('button')).toHaveText(['钉住', '追问', '复制'])
    await expect(capsule.getByRole('button', { name: '释义' })).toHaveCount(0)

    await selectAnswerWord(page, 'Approach matters')
    await expect(capsule.getByRole('button')).toHaveText(['钉住', '追问', '复制'])
  })
})

/** 在第一条回答里选中一小段文字，模拟鼠标松开后浮出划词胶囊。 */
async function selectAnswerWord(page: Page, needle: string): Promise<void> {
  await selectAnswerText(page, needle)
  await expect(page.locator('.selection-capsule')).toBeVisible()
}
