import { describe, expect, it } from 'vitest'
import {
  BUILTIN_PROVIDER_IDS,
  isBuiltinProviderId,
  listBuiltinProviderSetups,
  readBuiltinProviderSetup
} from './model-builtin'

describe('内置提供商目录（批 2 + 批 3）', () => {
  it('按固定顺序列分批开放的入口', () => {
    expect(BUILTIN_PROVIDER_IDS).toEqual([
      'deepseek',
      'kimi',
      'glm',
      'anthropic',
      'minimax',
      'openai',
      'xai',
      'gemini',
      'opencode-go'
    ])
    expect(listBuiltinProviderSetups().map((setup) => setup.id)).toEqual([
      'deepseek',
      'kimi',
      'glm',
      'anthropic',
      'minimax',
      'openai',
      'xai',
      'gemini',
      'opencode-go'
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
      },
      {
        id: 'gemini',
        displayName: 'Google Gemini',
        protocol: 'google-generative-ai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        envVar: 'GEMINI_API_KEY'
      },
      {
        id: 'opencode-go',
        displayName: 'OpenCode GO',
        // 聚合入口没有单一协议与统一地址：两者都按模型给，不冒充任何一条协议。
        protocol: null,
        baseUrl: null,
        envVar: 'OPENCODE_GO_API_KEY'
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

  it('Anthropic 与 MiniMax 带出各自的 Anthropic Messages 端点与模型目录', () => {
    const anthropic = readBuiltinProviderSetup('anthropic')
    const minimax = readBuiltinProviderSetup('minimax')

    expect(anthropic?.models.length).toBeGreaterThan(0)
    expect(anthropic?.models.map((model) => model.api)).toEqual(
      anthropic?.models.map(() => 'anthropic-messages')
    )
    expect(anthropic?.models[0]).toMatchObject({
      id: 'claude-fable-5',
      api: 'anthropic-messages',
      contextWindow: 1000000,
      maxTokens: 128000,
      reasoning: true
    })

    expect(minimax?.models.map((model) => model.id)).toEqual([
      'MiniMax-M2.7',
      'MiniMax-M2.7-highspeed',
      'MiniMax-M3',
      'MiniMax-M3.1-Flash'
    ])
    expect(minimax?.models[0]).toMatchObject({
      api: 'anthropic-messages',
      contextWindow: 204800,
      maxTokens: 131072,
      reasoning: true
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

  it('Gemini 带出官方端点、环境变量与目录模型，协议是 Gemini API', () => {
    const setup = readBuiltinProviderSetup('gemini')

    expect(setup?.models.map((model) => model.id)).toContain('gemini-2.5-flash')
    expect(setup?.models[0]).toMatchObject({
      api: 'google-generative-ai',
      contextWindow: 1048576,
      maxTokens: 65536,
      reasoning: true
    })
  })

  it('OpenCode GO 带出 32 个模型，每个模型各自带协议与地址，不套单协议端点', () => {
    const setup = readBuiltinProviderSetup('opencode-go')

    expect(setup).toMatchObject({
      id: 'opencode-go',
      displayName: 'OpenCode GO',
      protocol: null,
      baseUrl: null,
      envVar: 'OPENCODE_GO_API_KEY'
    })
    expect(setup?.models).toHaveLength(32)
    expect(new Set(setup?.models.map((model) => model.api))).toEqual(
      new Set([
        'openai-completions',
        'openai-responses',
        'anthropic-messages',
        'google-generative-ai'
      ])
    )
    expect(setup?.models.every((model) => typeof model.baseUrl === 'string')).toBe(true)
    expect(
      setup?.models.find((model) => model.id === 'claude-haiku-5-5')
    ).toMatchObject({
      api: 'anthropic-messages',
      baseUrl: 'https://opencode.ai/inference/go/anthropic'
    })
    expect(setup?.models.find((model) => model.id === 'gemini-4-argon')).toMatchObject({
      api: 'google-generative-ai',
      baseUrl: 'https://opencode.ai/inference/go/google/v1beta'
    })
  })

  it('目录之外的入口与空值不可从目录添加', () => {
    expect(readBuiltinProviderSetup('not-in-catalog')).toBeNull()
    expect(readBuiltinProviderSetup('')).toBeNull()
    expect(isBuiltinProviderId('deepseek')).toBe(true)
    expect(isBuiltinProviderId('anthropic')).toBe(true)
    expect(isBuiltinProviderId('openai')).toBe(true)
    expect(isBuiltinProviderId('xai')).toBe(true)
    expect(isBuiltinProviderId('gemini')).toBe(true)
    expect(isBuiltinProviderId('opencode-go')).toBe(true)
    expect(isBuiltinProviderId(42)).toBe(false)
  })
})
