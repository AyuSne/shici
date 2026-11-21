import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_IDS,
  isBuiltinProviderId,
  listBuiltinProviderSetups,
  readBuiltinProviderSetup
} from './model-builtin'

describe('内置提供商目录（本批的 OpenAI 兼容与 Anthropic 入口）', () => {
  it('列出本批开放的入口，顺序固定', () => {
    expect(BUILTIN_PROVIDER_IDS).toEqual([
      'deepseek',
      'kimi',
      'glm',
      'anthropic',
      'minimax'
    ])
    expect(listBuiltinProviderSetups().map((setup) => setup.id)).toEqual([
      'deepseek',
      'kimi',
      'glm',
      'anthropic',
      'minimax'
    ])
  })

  it('每条都带出目录里的端点、环境变量与协议，用户只需再填密钥', () => {
    const setups = listBuiltinProviderSetups()

    expect(
      setups.map(({ id, displayName, protocol, baseUrl, envVar }) => ({
        id,
        displayName,
        protocol,
        baseUrl,
        envVar
      }))
    ).toEqual([
      {
        id: 'deepseek',
        displayName: 'DeepSeek',
        protocol: 'openai-completions',
        baseUrl: 'https://api.deepseek.com',
        envVar: 'DEEPSEEK_API_KEY'
      },
      {
        id: 'kimi',
        displayName: 'Kimi',
        protocol: 'openai-completions',
        baseUrl: 'https://api.moonshot.cn/v1',
        envVar: 'MOONSHOT_API_KEY'
      },
      {
        id: 'glm',
        displayName: '智谱 GLM',
        protocol: 'openai-completions',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        envVar: 'ZAI_API_KEY'
      },
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        envVar: 'ANTHROPIC_API_KEY'
      },
      {
        id: 'minimax',
        displayName: 'MiniMax',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.minimax.io/anthropic',
        envVar: 'MINIMAX_API_KEY'
      }
    ])
  })

  it('DeepSeek 带出目录的两个模型与完整元数据，不做 DeepSeek 式克隆', () => {
    const setup = readBuiltinProviderSetup('deepseek')

    expect(setup?.models.map((model) => model.id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro'
    ])
    expect(setup?.models[0]).toMatchObject({
      api: 'openai-completions',
      contextWindow: 1000000,
      maxTokens: 384000,
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: 'low',
        medium: null,
        high: 'high',
        max: 'max'
      },
      compat: {
        thinkingFormat: 'deepseek',
        requiresReasoningContentOnAssistantMessages: true
      }
    })
    expect(setup?.models[1]).toMatchObject({
      contextWindow: 1000000,
      maxTokens: 384000,
      reasoning: true,
      thinkingLevelMap: { low: null, high: 'high', max: 'max' }
    })
  })

  it('Kimi 与 GLM 同样按各自目录元数据带出，不共用 DeepSeek 的描述', () => {
    const kimi = readBuiltinProviderSetup('kimi')
    const glm = readBuiltinProviderSetup('glm')

    expect(kimi?.models.map((model) => model.id)).toEqual([
      'kimi-k2.6',
      'kimi-k2.7-code',
      'kimi-k2.7-code-highspeed',
      'kimi-k3',
      'kimi-k3.1-pro',
      'kimi-k3.1-pro-highspeed'
    ])
    expect(kimi?.models[0]?.thinkingLevelMap).toBeUndefined()
    expect(kimi?.models[0]?.compat).toMatchObject({
      thinkingFormat: 'deepseek',
      supportsReasoningEffort: false
    })

    expect(glm?.models.map((model) => model.id)).toEqual([
      'glm-4.7',
      'glm-5-turbo',
      'glm-5.2',
      'glm-5.2-highspeed',
      'glm-5.3',
      'glm-5.3-flash',
      'glm-5.3-highspeed'
    ])
    expect(glm?.models[0]).toMatchObject({
      contextWindow: 204800,
      maxTokens: 131072,
      reasoning: true,
      compat: { thinkingFormat: 'zai', supportsReasoningEffort: false }
    })
  })

  it('本批未开放的入口（含 OpenCode GO 与其他协议）不可从目录添加', () => {
    expect(readBuiltinProviderSetup('opencode-go')).toBeNull()
    expect(readBuiltinProviderSetup('openai')).toBeNull()
    expect(readBuiltinProviderSetup('')).toBeNull()
    expect(isBuiltinProviderId('deepseek')).toBe(true)
    expect(isBuiltinProviderId('anthropic')).toBe(true)
    expect(isBuiltinProviderId(42)).toBe(false)
  })
})
