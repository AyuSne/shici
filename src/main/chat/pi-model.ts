import type { Api, Model } from '@earendil-works/pi-ai'
import type { ChatModelDescriptor } from './model-descriptor'

/** 目录只提供元数据，不提供价格；请求层不做计费，成本四项固定为 0。 */
export const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

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
    provider: descriptor.provider,
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
