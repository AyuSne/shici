import type {
  DictionaryForm,
  DictionaryFormKind,
  DictionaryLookup,
  DictionarySense
} from '../../../shared/dictionary'

/**
 * 词典在界面上的纯展示逻辑：释义先露几条、词性怎么叫、草稿怎么拼。
 * 组件只负责把这些结果摆出来。
 */

/** 划词卡首屏先露三条释义，其余折起来。 */
export const SENSE_PREVIEW = 3

const POS_NAMES: Record<string, string> = {
  'a.': 'adj.',
  'ad.': 'adv.'
}

const FORM_NAMES: Record<DictionaryFormKind, string> = {
  past: '过去式',
  'past-participle': '过去分词',
  'present-participle': '现在分词',
  'third-person': '第三人称单数',
  plural: '复数',
  comparative: '比较级',
  superlative: '最高级'
}

/** ECDICT 的 a. / ad. 换成学习者更熟悉的 adj. / adv.，其余词性原样。 */
export function posLabel(pos: string): string {
  return POS_NAMES[pos] ?? pos
}

export function visibleSenses(
  senses: readonly DictionarySense[],
  expanded: boolean
): { shown: DictionarySense[]; hidden: number } {
  if (expanded || senses.length <= SENSE_PREVIEW) {
    return { shown: [...senses], hidden: 0 }
  }
  return {
    shown: senses.slice(0, SENSE_PREVIEW),
    hidden: senses.length - SENSE_PREVIEW
  }
}

/** 音标统一用斜杠包起来；没有音标就整段不出现。 */
export function phoneticText(phonetic: string): string {
  return phonetic === '' ? '' : `/${phonetic}/`
}

export type DictionaryGlance = {
  phonetic: string
  firstSense: string
}

/** 词条抬头的只读词典速览：只露音标与第一条释义，查不到或未加载时返回 null。 */
export function dictionaryGlanceOf(lookup: DictionaryLookup | null): DictionaryGlance | null {
  if (lookup === null || lookup.status !== 'found') return null
  const phonetic = phoneticText(lookup.entry.phonetic)
  const sense = lookup.entry.senses[0]
  const firstSense =
    sense === undefined
      ? ''
      : [posLabel(sense.pos), sense.text].filter((part) => part !== '').join(' ')
  if (phonetic === '' && firstSense === '') return null
  return { phonetic, firstSense }
}

/**
 * 「用这条起草」的草稿：词形与音标一行，选中的那条释义一行。
 * 只填进编辑框，保存与否仍由学习者决定。
 */
export function draftFromSense({
  word,
  phonetic,
  sense
}: {
  word: string
  phonetic: string
  sense: DictionarySense
}): string {
  const head = phonetic === '' ? word : `${word} /${phonetic}/`
  const pos = posLabel(sense.pos)
  return `${head}\n${pos === '' ? sense.text : `${pos} ${sense.text}`}`
}

/** 词形变化一行说完：同一词形的几类用「/」连，词形之间用「·」隔开。 */
export function formText(forms: readonly DictionaryForm[]): string {
  return forms
    .map((form) => {
      const kinds = form.kinds.map((kind) => FORM_NAMES[kind]).join(' / ')
      return kinds === '' ? form.form : `${kinds} ${form.form}`
    })
    .join(' · ')
}

/**
 * 对话里划词浮卡只在选中单个词时多给「释义」：短语、整句不查，
 * 免得把一条普通句子送进词典还回一句「没收录」。
 */
export function singleWordOf(text: string): string | null {
  const word = text
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  if (!/^\p{L}[\p{L}\p{N}]*(?:['’-][\p{L}\p{N}]+)*$/u.test(word)) {
    return null
  }
  return word
}

/** 查不到时的说法：没收录和词典没随包加载要分开，别让人以为软件坏了。 */
export function statusText(lookup: DictionaryLookup): string {
  if (lookup.status === 'missing') return '没收录 · 去问 LLM'
  if (lookup.status === 'unavailable') return '词典没有随包加载 · 去问 LLM'
  return ''
}

/** 回退到原形时说明是从哪个词形归过来的，学习者才知道查到的是哪个词。 */
export function lemmaText(lookup: DictionaryLookup): string {
  if (lookup.status !== 'found' || lookup.via !== 'lemma') return ''
  return `由 ${lookup.query} 归到原形`
}
