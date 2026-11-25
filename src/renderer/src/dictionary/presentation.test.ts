import { describe, expect, it } from 'vitest'
import type { DictionaryEntry, DictionaryLookup, DictionarySense } from '../../../shared/dictionary'
import {
  dictionaryGlanceOf,
  draftFromSense,
  formText,
  lemmaText,
  phoneticText,
  posLabel,
  singleWordOf,
  statusText,
  visibleSenses
} from './presentation'
import { isDictionarySettled } from './lookup'

const senses: DictionarySense[] = [
  { pos: 'n.', text: '方法, 途径' },
  { pos: 'vt.', text: '接近, 着手处理' },
  { pos: 'vi.', text: '靠近' },
  { pos: 'a.', text: '可接近的' }
]

const entry: DictionaryEntry = {
  word: 'approach',
  phonetic: 'əˈprəʊtʃ',
  senses,
  forms: [
    { form: 'approached', kinds: ['past', 'past-participle'] },
    { form: 'approaching', kinds: ['present-participle'] },
    { form: 'approaches', kinds: ['third-person'] }
  ]
}

describe('visibleSenses', () => {
  it('收起时最多露出前三条，其余折起来并报出条数', () => {
    expect(visibleSenses(senses, false)).toEqual({
      shown: senses.slice(0, 3),
      hidden: 1
    })
    expect(visibleSenses(senses.slice(0, 2), false)).toEqual({
      shown: senses.slice(0, 2),
      hidden: 0
    })
  })

  it('展开后全部露出', () => {
    expect(visibleSenses(senses, true)).toEqual({ shown: senses, hidden: 0 })
  })
})

describe('posLabel', () => {
  it('把 ECDICT 的 a. / ad. 换成学习者更熟悉的 adj. / adv.', () => {
    expect(posLabel('a.')).toBe('adj.')
    expect(posLabel('ad.')).toBe('adv.')
    expect(posLabel('n.')).toBe('n.')
    expect(posLabel('')).toBe('')
  })
})

describe('phoneticText', () => {
  it('音标加了斜杠，没有音标就什么都不显示', () => {
    expect(phoneticText('əˈprəʊtʃ')).toBe('/əˈprəʊtʃ/')
    expect(phoneticText('')).toBe('')
  })
})

describe('draftFromSense', () => {
  it('把词形、音标与选中的那条释义拼成草稿', () => {
    expect(
      draftFromSense({ word: 'approach', phonetic: entry.phonetic, sense: senses[0] })
    ).toBe('approach /əˈprəʊtʃ/\nn. 方法, 途径')
  })

  it('没有音标时只写词形；没有词性时只写释义', () => {
    expect(draftFromSense({ word: 'flask', phonetic: '', sense: { pos: '', text: '[化] 烧瓶' } })).toBe(
      'flask\n[化] 烧瓶'
    )
  })
})

describe('formText', () => {
  it('同形多类合在一起说，按固定顺序列', () => {
    expect(formText(entry.forms)).toBe(
      '过去式 / 过去分词 approached · 现在分词 approaching · 第三人称单数 approaches'
    )
    expect(formText([])).toBe('')
  })
})

describe('singleWordOf', () => {
  it('只有单个词（可带连字符、撇号）才给「释义」入口', () => {
    expect(singleWordOf(' hiring ')).toBe('hiring')
    expect(singleWordOf('AI-mediated')).toBe('AI-mediated')
    expect(singleWordOf('don’t')).toBe('don’t')
    expect(singleWordOf('take part')).toBeNull()
    expect(singleWordOf('')).toBeNull()
    expect(singleWordOf('—')).toBeNull()
  })
})

describe('statusText', () => {
  it('没收录与词典不可用分开说，都给下一步', () => {
    const missing: DictionaryLookup = { status: 'missing', query: 'zyzzyva' }
    const unavailable: DictionaryLookup = { status: 'unavailable', query: 'approach' }
    expect(statusText(missing)).toBe('没收录 · 去问 LLM')
    expect(statusText(unavailable)).toBe('词典没有随包加载 · 去问 LLM')
  })
})

describe('lemmaText', () => {
  it('回退到原形时说明是从哪个词形归过来的', () => {
    expect(
      lemmaText({ status: 'found', query: 'approaching', via: 'lemma', entry })
    ).toBe('由 approaching 归到原形')
    expect(lemmaText({ status: 'found', query: 'approach', via: 'exact', entry })).toBe('')
    expect(lemmaText({ status: 'missing', query: 'zyzzyva' })).toBe('')
  })
})

describe('dictionaryGlanceOf', () => {
  it('命中词典时返回音标与第一条释义，供词条抬头轻量透出', () => {
    expect(
      dictionaryGlanceOf({ status: 'found', query: 'approach', via: 'exact', entry })
    ).toEqual({
      phonetic: '/əˈprəʊtʃ/',
      firstSense: 'n. 方法, 途径'
    })
  })

  it('缺少音标或词性时按已有字段兜底，未命中或未加载返回 null', () => {
    expect(
      dictionaryGlanceOf({
        status: 'found',
        query: 'flask',
        via: 'exact',
        entry: { word: 'flask', phonetic: '', senses: [{ pos: 'a.', text: '亮' }], forms: [] }
      })
    ).toEqual({
      phonetic: '',
      firstSense: 'adj. 亮'
    })
    expect(dictionaryGlanceOf(null)).toBeNull()
    expect(dictionaryGlanceOf({ status: 'missing', query: 'zyzzyva' })).toBeNull()
    expect(dictionaryGlanceOf({ status: 'unavailable', query: 'approach' })).toBeNull()
  })
})

describe('isDictionarySettled', () => {
  it('只有加载结束、结果非空且对应当前查询词时才算落定', () => {
    const found: DictionaryLookup = { status: 'found', query: 'approach', via: 'exact', entry }
    expect(isDictionarySettled({ lookup: null, loading: false, word: null }, null)).toBe(true)
    expect(isDictionarySettled({ lookup: null, loading: true, word: 'approach' }, 'approach')).toBe(
      false
    )
    expect(isDictionarySettled({ lookup: found, loading: false, word: 'approach' }, 'Context')).toBe(
      false
    )
    expect(isDictionarySettled({ lookup: found, loading: false, word: 'approach' }, 'approach')).toBe(
      true
    )
  })
})
