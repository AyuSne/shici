import { describe, expect, it } from 'vitest'
import { findProviderCatalogModel } from './model-directory'

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
