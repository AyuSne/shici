import { describe, expect, it } from 'vitest'
import {
  findProviderCatalogModel,
  isAggregateModelProvider,
  isModelDirectoryReadOnly
} from './model-directory'

describe('findProviderCatalogModel', () => {
  it('内置 provider 只认自己目录入口里的模型，不拿别家的同名模型冒充', () => {
    expect(
      findProviderCatalogModel(
        {
          source: 'builtin',
          catalogProviderId: 'deepseek',
          protocol: 'openai-completions'
        },
        'deepseek-v4-pro'
      )
    ).toMatchObject({ id: 'deepseek-v4-pro', contextWindow: 1000000 })
    expect(
      findProviderCatalogModel(
        {
          source: 'builtin',
          catalogProviderId: 'deepseek',
          protocol: 'openai-completions'
        },
        'kimi-k2.6'
      )
    ).toBeNull()
  })

  it('自定义 provider 按模型 ID 在共享目录里查找，只认协议一致的那一份', () => {
    expect(
      findProviderCatalogModel(
        {
          source: 'custom',
          catalogProviderId: null,
          protocol: 'openai-completions'
        },
        'deepseek-v4-pro'
      )
    ).toMatchObject({ name: 'DeepSeek V4 Pro', maxTokens: 384000 })
    // MiniMax-M3 在目录里只有 Anthropic Messages 协议，不套到 OpenAI 兼容入口。
    expect(
      findProviderCatalogModel(
        {
          source: 'custom',
          catalogProviderId: null,
          protocol: 'openai-completions'
        },
        'MiniMax-M3'
      )
    ).toBeNull()
    expect(
      findProviderCatalogModel(
        {
          source: 'custom',
          catalogProviderId: null,
          protocol: 'anthropic-messages'
        },
        'MiniMax-M3'
      )
    ).toMatchObject({ id: 'MiniMax-M3', api: 'anthropic-messages' })
  })

  it('聚合入口在目录里只按模型身份查，模型自带协议与地址', () => {
    expect(
      findProviderCatalogModel(
        { source: 'builtin', catalogProviderId: 'opencode-go', protocol: null },
        'gemini-4-argon'
      )
    ).toMatchObject({
      api: 'google-generative-ai',
      baseUrl: 'https://opencode.ai/inference/go/google/v1beta'
    })
    expect(
      findProviderCatalogModel(
        { source: 'builtin', catalogProviderId: 'opencode-go', protocol: null },
        'not-in-go-catalog'
      )
    ).toBeNull()
  })

  it('空 ID 与目录外 ID 返回 null，交给调用方保留未知模型', () => {
    const identity = {
      source: 'custom' as const,
      catalogProviderId: null,
      protocol: 'openai-completions' as const
    }
    expect(findProviderCatalogModel(identity, '   ')).toBeNull()
    expect(findProviderCatalogModel(identity, 'mystery-relay-model')).toBeNull()
    expect(
      findProviderCatalogModel(
        { ...identity, protocol: null },
        'deepseek-v4-pro'
      )
    ).toBeNull()
  })
})

describe('聚合入口与只读目录', () => {
  it('只有目录里没有单一协议的入口算聚合；未知与单协议入口都不算', () => {
    expect(isAggregateModelProvider({ catalogProviderId: 'opencode-go' })).toBe(true)
    expect(isAggregateModelProvider({ catalogProviderId: 'deepseek' })).toBe(false)
    expect(isAggregateModelProvider({ catalogProviderId: 'not-in-catalog' })).toBe(false)
    expect(isAggregateModelProvider({ catalogProviderId: null })).toBe(false)
  })

  it('聚合目录首版只读；单协议内置与自定义仍可编辑', () => {
    expect(isModelDirectoryReadOnly({ catalogProviderId: 'opencode-go' })).toBe(true)
    expect(isModelDirectoryReadOnly({ catalogProviderId: 'deepseek' })).toBe(false)
    expect(isModelDirectoryReadOnly({ catalogProviderId: null })).toBe(false)
  })
})
