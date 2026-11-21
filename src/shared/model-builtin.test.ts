import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_IDS,
  isBuiltinProviderId,
  listBuiltinProviderSetups,
  readBuiltinProviderSetup
} from './model-builtin'

describe('内置提供商目录（批 2 + 批 3 OpenAI / xAI）', () => {
  it('按固定顺序列 DeepSeek、Kimi、智谱 GLM、OpenAI 与 xAI', () => {
    expect(BUILTIN_PROVIDER_IDS).toEqual([
      'deepseek',
      'kimi',
      'glm',
      'openai',
      'xai'
    ])
    expect(listBuiltinProviderSetups().map((setup) => setup.id)).toEqual([
      'deepseek',
      'kimi',
      'glm',
      'openai',
      'xai'
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
        id: 'openai',
        displayName: 'OpenAI',
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        envVar: 'OPENAI_API_KEY'
      },
      {
        id: 'xai',
        displayName: 'xAI',
        protocol: 'openai-responses',
        baseUrl: 'https://api.x.ai/v1',
        envVar: 'XAI_API_KEY'
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

  it('OpenAI 与 xAI 带出各自的 Responses 模型目录，不共用别家元数据', () => {
    const openai = readBuiltinProviderSetup('openai')
    const xai = readBuiltinProviderSetup('xai')

    expect(openai?.models.length).toBeGreaterThan(0)
    expect(openai?.models.map((model) => model.api)).toEqual(
      openai?.models.map(() => 'openai-responses')
    )
    expect(openai?.models[0]).toMatchObject({
      id: 'chat-latest',
      api: 'openai-responses',
      contextWindow: 400000,
      maxTokens: 128000,
      reasoning: true
    })
    // 普通模型没有思考能力：发送层不能替它带 reasoning。
    expect(openai?.models.find((model) => model.id === 'gpt-4.1')).toMatchObject({
      api: 'openai-responses',
      reasoning: false
    })

    expect(xai?.models.map((model) => model.id)).toEqual([
      'grok-4.3',
      'grok-4.5',
      'grok-4.6',
      'grok-4.7'
    ])
    expect(xai?.models[0]).toMatchObject({
      api: 'openai-responses',
      contextWindow: 1000000,
      maxTokens: 30000,
      reasoning: true
    })
  })

  it('目录之外的入口（含尚未开放的协议）在本票不可从目录添加', () => {
    expect(readBuiltinProviderSetup('opencode-go')).toBeNull()
    expect(readBuiltinProviderSetup('anthropic')).toBeNull()
    expect(readBuiltinProviderSetup('gemini')).toBeNull()
    expect(readBuiltinProviderSetup('')).toBeNull()
    expect(isBuiltinProviderId('deepseek')).toBe(true)
    expect(isBuiltinProviderId('openai')).toBe(true)
    expect(isBuiltinProviderId('xai')).toBe(true)
    expect(isBuiltinProviderId('anthropic')).toBe(false)
    expect(isBuiltinProviderId(42)).toBe(false)
  })
})
