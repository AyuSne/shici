import { describe, expect, it } from 'vitest'
import type { ChatThreadView, ThreadAnswer, ThreadContextItem, ThreadTurn } from '../../../shared/threads'
import {
  CONTINUE_INSTRUCTION,
  buildMessages,
  canSaveAnswerAsArticle,
  contextSummaryText,
  lastTurn,
  selectedVersionIndex,
  summarizeContext,
  threadHeaderText,
  threadSystemPrompt
} from './turns'

const contextItem: ThreadContextItem = {
  id: 'sentence:es-1',
  kind: 'sentence',
  label: 'lament',
  text: 'Left alone on an unknown island, Crusoe has much to lament.',
  source: '2026年6月 · 第1套 · 长篇匹配 · 段 B · 第 6 句'
}

function answer(overrides: Partial<ThreadAnswer> = {}): ThreadAnswer {
  return {
    id: 'a-1',
    versions: [{ id: 'a-1', selected: true }],
    text: '第一版回答。',
    thinking: '想了一下。',
    thinkingMs: 3000,
    phase: 'done',
    error: null,
    model: 'deepseek-flash',
    createdAt: '2026-11-18T09:01:00.000Z',
    continuationIds: [],
    ...overrides
  }
}

function turn(
  question: Partial<ThreadTurn['question']> & { id: string; text: string },
  answerValue: ThreadAnswer | null = null
): ThreadTurn {
  return {
    question: {
      createdAt: '2026-11-18T09:00:00.000Z',
      wordCount: 0,
      versions: [{ id: question.id, selected: true }],
      ...question
    },
    answer: answerValue
  }
}

function view(overrides: Partial<ChatThreadView> = {}): ChatThreadView {
  return {
    id: 't-1',
    title: 'lament',
    main: {
      kind: 'entry',
      entryId: 'e-1',
      mainForm: 'lament',
      sentenceCount: 3,
      articleCount: 2
    },
    context: [contextItem],
    contextSummary: { articleCount: 0, paragraphCount: 0, wordCount: 0, sentenceCount: 1, excerptCount: 0, charCount: 56 },
    turns: [],
    createdAt: '2026-11-18T08:00:00.000Z',
    updatedAt: '2026-11-18T08:00:00.000Z',
    ...overrides
  }
}

describe('contextSummaryText', () => {
  it('按「N 个词 · M 条原句 · 约 K 字」显示，词与原句各自计数', () => {
    expect(contextSummaryText({ articleCount: 0, paragraphCount: 0, wordCount: 2, sentenceCount: 3, excerptCount: 0, charCount: 420 })).toBe(
      '3 条原句 · 2 个词 · 约 420 字'
    )
    expect(contextSummaryText({ articleCount: 0, paragraphCount: 0, wordCount: 0, sentenceCount: 0, excerptCount: 0, charCount: 0 })).toBe(
      '约 0 字'
    )
  })

  it('摘要按实际全文、段落、原句和词分别计数', () => {
    const items: ThreadContextItem[] = [
      { id: 'article:a', kind: 'article', label: '', text: 'Full text', source: '' },
      { id: 'paragraph:b:1', kind: 'paragraph', label: '', text: 'Other', source: '' },
      { id: 'sentence:s', kind: 'sentence', label: '', text: 'Line', source: '' },
      { id: 'word:w', kind: 'word', label: '', text: 'word', source: '' }
    ]
    expect(contextSummaryText(summarizeContext(items))).toBe('1 篇全文 · 1 段 · 1 条原句 · 1 个词 · 约 22 字')
  })

  it('词只数 word，原句只数 sentence，字数把词与段落也算进去', () => {
    expect(
      summarizeContext([
        contextItem,
        { id: 'word:e-1', kind: 'word', label: 'lament', text: 'lament', source: '' },
        { id: 'note:1', kind: 'note', label: 'lament', text: '学习内容', source: '' }
      ])
    ).toEqual({
      articleCount: 0,
      paragraphCount: 0,
      wordCount: 1,
      sentenceCount: 1,
      excerptCount: 0,
      charCount: Array.from(contextItem.text).length + 6 + 4
    })
  })

  it('组词上下文同时数出 20 个词与它们的原句', () => {
    const items = Array.from({ length: 20 }, (_, index) => [
      {
        id: `word:e-${index}`,
        kind: 'word' as const,
        label: `word${index}`,
        text: `word${index}`,
        source: ''
      },
      {
        id: `sentence:s-${index}`,
        kind: 'sentence' as const,
        label: `word${index}`,
        text: `The word${index} appears here.`,
        source: ''
      }
    ]).flat()
    const summary = summarizeContext(items)
    expect(summary.wordCount).toBe(20)
    expect(summary.sentenceCount).toBe(20)
    expect(contextSummaryText(summary)).toMatch(/^20 条原句 · 20 个词 · 约 \d+ 字$/)
  })
})

describe('threadSystemPrompt', () => {
  it('把带上的材料按种类排成 system 前言；没有上下文时为 null', () => {
    const prompt = threadSystemPrompt([
      contextItem,
      {
        id: 'word:e-1',
        kind: 'word',
        label: 'lament',
        text: 'lament',
        source: '已收 3 条原句 · 2 篇'
      }
    ])
    expect(prompt).not.toBeNull()
    expect(prompt).toContain('[词] lament')
    expect(prompt).toContain('[原句] Left alone on an unknown island, Crusoe has much to lament.')
    expect(prompt).toContain('2026年6月 · 第1套 · 长篇匹配 · 段 B · 第 6 句')
    expect(threadSystemPrompt([])).toBeNull()
  })
})

describe('buildMessages', () => {
  it('新提问只带这一路的历史与最后一问', () => {
    const thread = view({
      turns: [
        turn({ id: 'q-1', text: '第一问' }, answer()),
        turn({ id: 'q-2', text: '第二问' })
      ]
    })
    expect(buildMessages(thread, { kind: 'answer' })).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一版回答。' },
      { role: 'user', content: '第二问' }
    ])
  })

  it('重新生成截到那一问，不带当前这一版回答', () => {
    const thread = view({
      turns: [
        turn({ id: 'q-1', text: '第一问' }, answer()),
        turn({ id: 'q-2', text: '第二问' }, answer({ id: 'a-2', text: '第二版回答。' }))
      ]
    })
    expect(
      buildMessages(thread, { kind: 'regenerate', questionId: 'q-2' })
    ).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '第一版回答。' },
      { role: 'user', content: '第二问' }
    ])
  })

  it('继续生成把已写出的部分作为回答带上，再接一句继续的要求', () => {
    const thread = view({
      turns: [
        turn(
          { id: 'q-1', text: '写一段' },
          answer({ text: '已经写到这里。', thinking: '想过。' })
        )
      ]
    })
    expect(buildMessages(thread, { kind: 'continue' })).toEqual([
      { role: 'user', content: '写一段' },
      { role: 'assistant', content: '已经写到这里。' },
      { role: 'user', content: CONTINUE_INSTRUCTION }
    ])
  })

  it('停下来或出错的回答只要写出来了就带回历史；字数为空的不带', () => {
    const thread = view({
      turns: [
        turn(
          { id: 'q-1', text: '第一问' },
          answer({ id: 'a-1', text: '半截回答', phase: 'stopped' })
        ),
        turn(
          { id: 'q-2', text: '第二问' },
          answer({ id: 'a-2', text: '', phase: 'error', error: { code: 'network' } })
        ),
        turn({ id: 'q-3', text: '第三问' })
      ]
    })
    expect(buildMessages(thread, { kind: 'answer' })).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '半截回答' },
      { role: 'user', content: '第二问' },
      { role: 'user', content: '第三问' }
    ])
  })
})

describe('版本与页头', () => {
  it('找出选中版本的位置，从 1 起数', () => {
    expect(
      selectedVersionIndex([
        { id: 'a-1', selected: false },
        { id: 'a-2', selected: true }
      ])
    ).toBe(2)
    expect(selectedVersionIndex([])).toBe(0)
  })

  it('页头副标题按主对象给', () => {
    expect(threadHeaderText(view())).toBe('词条 lament · 3 条原句 · 2 篇')
    expect(threadHeaderText(view({ main: { kind: 'none' } }))).toBe(
      '从词或文章开始'
    )
    expect(
      threadHeaderText(
        view({
          main: {
            kind: 'sentence',
            entryId: 'e-1',
            entrySentenceId: 'es-1',
            mainForm: 'lament',
            surface: 'lament',
            sentenceText: '句',
            articleId: 'art-1',
            articleTitle: '2026年6月 · 第1套 · 长篇匹配',
            paragraphId: 'B',
            paragraphOrdinal: 2,
            paragraphLetter: 'B',
            sentenceOrdinal: 5
          }
        })
      )
    ).toBe('2026年6月 · 第1套 · 长篇匹配 · 段 B · 第 6 句')
    expect(
      threadHeaderText(
        view({
          main: {
            kind: 'article',
            articleId: 'art-1',
            title: '2026年6月 · 第1套 · 长篇匹配',
            sessionLabel: '2026年6月',
            setLabel: '第1套',
            kindLabel: '长篇匹配',
            wordCount: 1200
          }
        })
      )
    ).toBe('2026年6月 · 第1套 · 长篇匹配 · 1200 词')
  })

  it('生成文章没有场次与套数：对话头只列 AI 生成与词数，不编年份', () => {
    expect(
      threadHeaderText(
        view({
          main: {
            kind: 'article',
            articleId: 'ai-1',
            title: 'approach、Context',
            sessionLabel: '',
            setLabel: '',
            kindLabel: 'AI 生成',
            wordCount: 120
          }
        })
      )
    ).toBe('AI 生成 · 120 词')
  })

  it('只有带词上下文且完成的回答才出现「存为文章」', () => {
    const question = turn({ id: 'q-1', text: '问', wordCount: 2 }).question
    const done = answer({ phase: 'done', text: '写好的回答。' })
    expect(canSaveAnswerAsArticle(question, done, false)).toBe(true)

    // 生成中（disabled）、停止/出错、空正文都没有这个动作。
    expect(canSaveAnswerAsArticle(question, done, true)).toBe(false)
    expect(canSaveAnswerAsArticle(question, answer({ phase: 'stopped', text: '半截' }), false)).toBe(
      false
    )
    expect(canSaveAnswerAsArticle(question, answer({ phase: 'error', text: '半截' }), false)).toBe(
      false
    )
    // 完成状态与错误按同一份最后一段聚合；不一致的数据也不能给出保存入口。
    expect(
      canSaveAnswerAsArticle(
        question,
        answer({ phase: 'done', error: { code: 'network' }, text: '半截' }),
        false
      )
    ).toBe(false)
    expect(canSaveAnswerAsArticle(question, answer({ phase: 'done', text: '   ' }), false)).toBe(
      false
    )
    // 这一问没有带词：不出现存文章，避免保存出没有来源的文章。
    expect(canSaveAnswerAsArticle(turn({ id: 'q-2', text: '问' }).question, done, false)).toBe(
      false
    )
    expect(canSaveAnswerAsArticle(question, null, false)).toBe(false)
  })

  it('最后一轮与它的回答是重生成和继续生成的前提', () => {
    expect(lastTurn(view())).toBeNull()
    const answered = view({ turns: [turn({ id: 'q-1', text: '问' }, answer())] })
    expect(lastTurn(answered)?.answer?.id).toBe('a-1')
  })
})
