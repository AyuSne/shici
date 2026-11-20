import { describe, expect, it } from 'vitest'
import {
  findCatalogModel,
  findModelProvider,
  isModelProtocol,
  MODEL_PROVIDER_CATALOG,
  MODEL_PROVIDERS,
  MODEL_PROTOCOLS,
  resolveModelBaseUrl,
  resolveModelProtocol,
  type CatalogProvider
} from './model-catalog'

/**
 * 共享目录是 #61/#62 的唯一入口数据。这里锁住入口集合、人工选择与查询接口，
 * 不测生成脚本内部，避免把测试绑死在实现上。
 */
describe('共享模型目录', () => {
  it('按固定顺序提供九个入口，并能按 Provider ID 查到', () => {
    expect(MODEL_PROVIDER_CATALOG.schemaVersion).toBe(1)
    expect(MODEL_PROVIDER_CATALOG.piVersion).toBe('1.5.2')
    expect(MODEL_PROVIDERS.map((provider) => provider.id)).toEqual([
      'deepseek',
      'kimi',
      'glm',
      'minimax',
      'openai',
      'anthropic',
      'gemini',
      'xai',
      'opencode-go'
    ])

    expect(findModelProvider('glm')?.displayName).toBe('智谱 GLM')
    expect(findModelProvider('kimi')?.region).toBe('cn')
    expect(findModelProvider('opencode-go')?.protocol).toBeNull()
    expect(findModelProvider('missing')).toBeUndefined()
    expect(isModelProtocol('openai-responses')).toBe(true)
    expect(isModelProtocol('openai-completions')).toBe(true)
    expect(isModelProtocol('anthropic-messages')).toBe(true)
    expect(isModelProtocol('google-generative-ai')).toBe(true)
    expect(isModelProtocol('mistral-conversations')).toBe(false)
    expect(isModelProtocol('')).toBe(false)

    const deepseek = findModelProvider('deepseek')
    const model = findCatalogModel('deepseek', 'deepseek-flash')
    expect(deepseek).toBeDefined()
    expect(model).toBeDefined()
    if (deepseek && model) {
      expect(resolveModelProtocol(deepseek, model)).toBe('openai-completions')
      expect(resolveModelBaseUrl(deepseek, model)).toBe(
        'https://api.deepseek.com'
      )
    }

    const opencodeGo = findModelProvider('opencode-go')
    const opencodeModel = findCatalogModel('opencode-go', 'gpt-6-luna')
    if (opencodeGo && opencodeModel) {
      expect(resolveModelProtocol(opencodeGo, opencodeModel)).toBe(
        'openai-responses'
      )
      expect(resolveModelBaseUrl(opencodeGo, opencodeModel)).toBe(
        'https://opencode.ai/inference/go/openai/v1'
      )
    }
  })

  it('单协议入口的模型继承协议，OpenCode GO 的 32 个模型各带协议与地址', () => {
    for (const provider of MODEL_PROVIDERS) {
      expect(provider.models.length).toBeGreaterThan(0)
      for (const model of provider.models) {
        expect(MODEL_PROTOCOLS).toContain(model.api)
        expect(model.input).toContain('text')
        expect(model.contextWindow).toBeGreaterThan(0)
        expect(model.maxTokens).toBeGreaterThan(0)
        expect(typeof model.reasoning).toBe('boolean')
        expect(model.name.length).toBeGreaterThan(0)

        if (provider.protocol === null) {
          expect(model.baseUrl).toMatch(
            /^https:\/\/opencode\.ai\/inference\/go\//
          )
        } else {
          expect(model.api).toBe(provider.protocol)
          // 单协议入口的地址只在 provider 上，避免把 pi 每个模型的 coding 套餐
          // 地址带进来；请求时模型继承入口地址。
          expect(Object.hasOwn(model, 'baseUrl')).toBe(false)
        }
      }
    }

    const opencodeGo = findModelProvider('opencode-go') as CatalogProvider
    expect(opencodeGo.models).toHaveLength(32)
    expect(new Set(opencodeGo.models.map((model) => model.api))).toEqual(
      new Set(MODEL_PROTOCOLS)
    )
    expect(new Set(opencodeGo.models.map((model) => model.baseUrl))).toEqual(
      new Set([
        'https://opencode.ai/inference/go/anthropic',
        'https://opencode.ai/inference/go/google/v1beta',
        'https://opencode.ai/inference/go/openai/v1'
      ])
    )

    const endpoints = MODEL_PROVIDERS.flatMap((provider) => [
      provider.baseUrl,
      ...provider.models.map((model) => model.baseUrl)
    ]).filter((endpoint): endpoint is string => typeof endpoint === 'string')
    expect(new Set(endpoints)).not.toContain(
      'https://api.z.ai/api/coding/paas/v4'
    )
    expect(new Set(endpoints)).not.toContain('https://api.kimi.com/coding/v1')
    for (const endpoint of endpoints) {
      expect(endpoint).toMatch(/^https:\/\//)
      expect(endpoint).not.toContain('/coding/')
      expect(endpoint).not.toContain('kimi-coding')
      expect(endpoint).not.toContain('qwen-token-plan')
      expect(endpoint).not.toContain('xiaomi-token-plan')
    }

    // 连注释与来源里也不留套餐入口：升级 pi 后有人把 notes 拿去拼地址也不会
    // 把 zai coding / kimi-coding 带进来。
    const serialized = JSON.stringify(MODEL_PROVIDER_CATALOG)
    for (const forbidden of [
      'api.z.ai/api/coding',
      'api.kimi.com/coding',
      'kimi-coding',
      'zai-coding',
      'qwen-token-plan',
      'xiaomi-token-plan'
    ]) {
      expect(serialized).not.toContain(forbidden)
    }
  })

  it('保留 DeepSeek/Kimi/GLM 的思考降级元数据（thinkingLevelMap 与 compat）', () => {
    const deepseek = findCatalogModel('deepseek', 'deepseek-flash')
    expect(deepseek?.thinkingLevelMap).toMatchObject({
      high: 'high',
      max: 'max'
    })
    expect(deepseek?.compat).toMatchObject({ thinkingFormat: 'deepseek' })

    const kimi = findCatalogModel('kimi', 'kimi-k3')
    expect(kimi?.thinkingLevelMap).toMatchObject({
      high: 'high',
      max: 'max'
    })
    expect(kimi?.compat).toMatchObject({
      supportsReasoningEffort: true,
      thinkingFormat: 'openai'
    })

    const glm = findCatalogModel('glm', 'glm-5.3')
    expect(glm?.thinkingLevelMap).toMatchObject({ high: 'high' })
    expect(glm?.compat).toMatchObject({ thinkingFormat: 'zai' })

    for (const provider of MODEL_PROVIDERS) {
      for (const model of provider.models) {
        expect(
          model.thinkingLevelMap === undefined ||
            typeof model.thinkingLevelMap === 'object'
        ).toBe(true)
      }
    }
  })

  it('快照覆盖每个入口的模型清单与思考元数据，新增或删除模型会失败', () => {
    expect(
      MODEL_PROVIDERS.map((provider) => ({
        id: provider.id,
        piProvider: provider.piProvider,
        protocol: provider.protocol,
        modelCount: provider.models.length,
        models: provider.models.map((model) => ({
          id: model.id,
          api: model.api,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          thinkingLevelMap: model.thinkingLevelMap,
          compat: model.compat
        }))
      }))
    ).toMatchSnapshot()
  })
})
