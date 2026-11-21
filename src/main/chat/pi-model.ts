import type { Api, Model } from '@earendil-works/pi-ai'
import { isSupportedAggregateProvider } from '../../shared/model-catalog'
import type { ChatModelDescriptor } from './model-descriptor'

/** 目录只提供元数据，不提供价格；请求层不做计费，成本四项固定为 0。 */
export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/**
 * 该描述符在 pi 运行时的 provider id。
 *
 * 单协议 provider 直接用配置的 Provider ID（deepseek、deepseek-2）；真正受支持的
 * 聚合入口（目前只有 OpenCode GO）必须落到 pi 内置 Provider 的 id（目录 id 与
 * 之一致），否则 `Models.requireProvider` 找不到那套多协议实现。配置身份仍留在
 * `provider`，用于凭据、默认模型与「使用中」，两者不互相改名。
 *
 * 判定用 `isSupportedAggregateProvider` 而不是「目录里 protocol 为 null」：
 * 只有实测支持分派的入口才能复用 GO 的内置 Provider，别把未来的混合目录也
 * loadGo 进来。
 */
export function piRuntimeProviderId(descriptor: ChatModelDescriptor): string {
  return isSupportedAggregateProvider(descriptor.catalogProviderId)
    ? descriptor.catalogProviderId
    : descriptor.provider
}

/**
 * `ChatModelDescriptor` → pi `Model` 的唯一转换。
 *
 * 思考能力查询（`getSupportedThinkingLevels`）与真实流式请求必须看到同一个模型：
 * 两处各写一份时，只要描述符或 pi 的 `Model` 形状变化就可能漂移，导致「能力判断
 * 说支持 high」而「真正发请求的模型不是它」。这里只做字段搬运，不引入框架。
 */
export function piModelOf(descriptor: ChatModelDescriptor): Model<Api> {
  return {
    id: descriptor.model,
    name: descriptor.model,
    api: descriptor.api,
    provider: piRuntimeProviderId(descriptor),
    baseUrl: descriptor.baseUrl,
    input: [...descriptor.input],
    cost: ZERO_COST,
    contextWindow: descriptor.contextWindow,
    maxTokens: descriptor.maxTokens,
    reasoning: descriptor.reasoning,
    ...(descriptor.thinkingLevelMap === undefined
      ? {}
      : { thinkingLevelMap: descriptor.thinkingLevelMap }),
    ...(descriptor.compat === undefined ? {} : { compat: descriptor.compat })
  } as Model<Api>
}
