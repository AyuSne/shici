import type { CatalogModel, ModelProtocol } from '../../shared/model-catalog'
import { findCatalogModel } from '../../shared/model-catalog'
import { readEnvValue } from '../process-env'
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
  /** 配置层的稳定身份（Provider ID）；同厂商多套时是 deepseek-2、opencode-go-2 等。 */
  provider: string
  /**
   * 内置目录身份；自定义 provider 为 null。聚合入口（OpenCode GO）请求时用
   * 它去找 pi 内置的多协议 Provider（其 id 与目录 id 一致），而 `provider`
   * 继续作为配置与凭据的稳定身份，两者不混用。
   *
   * 从 provider 行构造的描述符总会带上它；测试/环境退路手搓的描述符可以省略，
   * 省略即按单协议处理。
   */
  catalogProviderId?: string | null
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
    catalogProviderId: provider.catalogProviderId,
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
  providerId: string,
  catalogProviderId: string | null = null
): ChatModelDescriptor {
  return {
    provider: providerId,
    catalogProviderId,
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
    catalogProviderId: null,
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
  const apiKey = readEnvValue(env, 'DEEPSEEK_API_KEY')
  if (apiKey === null) {
    return null
  }
  const baseUrl = readEnvValue(env, 'DEEPSEEK_BASE_URL') ?? DEFAULT_BASE_URL
  const model = readEnvValue(env, 'DEEPSEEK_MODEL') ?? DEFAULT_MODEL
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
