import { describe, expect, it } from 'vitest'
import { findCatalogModel, findModelProvider } from '../../shared/model-catalog'
import { descriptorOfCatalogModel, type ChatModelDescriptor } from './model-descriptor'
import { DESIRED_THINKING_LEVEL, chooseThinkingLevel, resolveThinkingLevel } from './thinking'

describe('chooseThinkingLevel', () => {
  it('默认要 high，模型支持就原样用 high', () => {
    expect(DESIRED_THINKING_LEVEL).toBe('high')
    expect(
      chooseThinkingLevel(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    ).toBe('high')
    expect(chooseThinkingLevel(['off', 'low', 'high', 'max'])).toBe('high')
  })

  it('high 不支持时确定性地降一档，不会跳到更高的 max', () => {
    expect(chooseThinkingLevel(['off', 'minimal', 'low', 'medium'])).toBe('medium')
    expect(chooseThinkingLevel(['off', 'low'])).toBe('low')
    expect(chooseThinkingLevel(['off', 'minimal'])).toBe('minimal')
  })

  it('只支持 off 或根本没有更低档位时省略思考，不当成“支持思考”', () => {
    expect(chooseThinkingLevel(['off'])).toBeUndefined()
    expect(chooseThinkingLevel([])).toBeUndefined()
    expect(chooseThinkingLevel(['off', 'max'])).toBeUndefined()
  })
})

describe('resolveThinkingLevel（用 pi 的真实能力表）', () => {
  it('DeepSeek 目录描述符在 pi 里支持 high', async () => {
    const provider = findModelProvider('deepseek')!
    const model = findCatalogModel('deepseek', 'deepseek-flash')!
    const descriptor = descriptorOfCatalogModel(provider, model, provider.baseUrl!, 'deepseek')

    await expect(resolveThinkingLevel(descriptor)).resolves.toBe('high')
  })

  it('能力表把 high 标成 null 时降一档，只有 off 时省略', async () => {
    const downgraded: ChatModelDescriptor = {
      provider: 'custom',
      model: 'custom-reasoner',
      api: 'openai-completions',
      baseUrl: 'https://gateway.example.com/v1',
      contextWindow: 1000,
      maxTokens: 100,
      input: ['text'],
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: null,
        high: null,
        xhigh: null,
        max: null
      }
    }
    await expect(resolveThinkingLevel(downgraded)).resolves.toBe('low')

    const nonReasoning: ChatModelDescriptor = {
      ...downgraded,
      reasoning: false,
      thinkingLevelMap: undefined
    }
    await expect(resolveThinkingLevel(nonReasoning)).resolves.toBeUndefined()
  })
})
