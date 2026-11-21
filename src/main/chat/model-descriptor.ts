import type { CatalogModel, ModelProtocol } from '../../shared/model-catalog'
import { findCatalogModel } from '../../shared/model-catalog'
import type {
  ModelProviderModelRecord,
  ModelProviderRecord,
  ModelThinkingLevelMap
} from '../settings/providers'

/**
 * 一次请求冻结下来的模型描述符：provider 身份、协议、地址与目录元数据。
 * 切换 provider 只影响之后的调用，正在生成的那一条始终用这里的快照。
 *
 * 迁移来的 custom 模型与目录里查不到的模型没有容量信息：统一按
 * 1,000,000 上下文 / 128,000 输出 / text 兜底，不拿 DeepSeek 的目录冒充。
 */
export type ChatModelDescriptor = {
  /** pi 的 provider id；同厂商多套时用不可变的 Provider ID（deepseek-2 等）。 */
  provider: string
  /** 请求里真正发送的模型名。 */
  model: string
  api: ModelProtocol
  baseUrl: string
  contextWindow: number
  maxTokens: number
  input: ('text' | 'image')[]
  reasoning: boolean
  thinkingLevelMap?: ModelThinkingLevelMap
  compat?: Record<string, unknown>
}

export const UNKNOWN_CONTEXT_WINDOW = 1_000_000
export const UNKNOWN_MAX_TOKENS = 128_000

export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_MODEL = 'deepseek-flash'

/**
 * 使用中的 provider + 默认模型的描述符。
 *
 * 模型行的 `api` 是真正的派发依据（聚合网关按模型分派）：库里存了本版不认识的
 * 协议时返回 null，由调用方明确报「没有可用配置」，绝不静默换成另一种协议。
 */
export function descriptorOfProvider(
  provider: ModelProviderRecord,
  model: ModelProviderModelRecord
): ChatModelDescriptor | null {
  if (model.api === null) {
    return null
  }
  return {
    provider: provider.providerKey,
    model: model.modelId,
    api: model.api,
    baseUrl: model.baseUrl ?? provider.baseUrl ?? '',
    contextWindow: model.contextWindow ?? UNKNOWN_CONTEXT_WINDOW,
    maxTokens: model.maxTokens ?? UNKNOWN_MAX_TOKENS,
    input: model.input === 'image' ? ['image'] : ['text'],
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap === null ? {} : { thinkingLevelMap: model.thinkingLevelMap }),
    ...(model.compat === null ? {} : { compat: model.compat })
  }
}

export function descriptorOfCatalogModel(
  model: CatalogModel,
  baseUrl: string,
  providerId: string
): ChatModelDescriptor {
  return {
    provider: providerId,
    model: model.id,
    api: model.api,
    baseUrl,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: [...model.input],
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: { ...model.thinkingLevelMap } }),
    ...(model.compat === undefined ? {} : { compat: { ...model.compat } })
  }
}

/** 目录里查不到描述符时的通用兜底；不复制任何厂商的思考能力。 */
export function fallbackDescriptor(input: {
  provider: string
  model: string
  api: ModelProtocol
  baseUrl: string
}): ChatModelDescriptor {
  return {
    provider: input.provider,
    model: input.model,
    api: input.api,
    baseUrl: input.baseUrl,
    contextWindow: UNKNOWN_CONTEXT_WINDOW,
    maxTokens: UNKNOWN_MAX_TOKENS,
    input: ['text'],
    reasoning: false
  }
}

export type EnvChatConfig = {
  apiKey: string
  baseUrl: string
  model: string
  descriptor: ChatModelDescriptor
}

/**
 * 没有本机 provider 时的环境变量退路（开发态与 E2E 用）。
 * 仍优先按目录里的 DeepSeek 描述符发请求，目录里没有的模型走通用兜底。
 */
export function readEnvChatConfig(env: NodeJS.ProcessEnv): EnvChatConfig | null {
  const apiKey = env.DEEPSEEK_API_KEY?.trim()
  if (!apiKey) {
    return null
  }
  const baseUrl = env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL
  const model = env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL
  const catalogModel = findCatalogModel('deepseek', model)
  const descriptor =
    catalogModel !== undefined
      ? descriptorOfCatalogModel(catalogModel, baseUrl, 'deepseek')
      : fallbackDescriptor({
          provider: 'deepseek',
          model,
          api: 'openai-completions',
          baseUrl
        })
  return { apiKey, baseUrl, model, descriptor }
}
