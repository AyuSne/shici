import type { Api, Model } from '@earendil-works/pi-ai'
import type { ModelThinkingLevel } from '../../shared/model-catalog'
import type { ChatModelDescriptor } from './model-descriptor'
import { loadPi } from './pi-modules'

/**
 * 首版思考强度固定 high（见 docs/product-scope.md），但界面不暴露不等于可以乱传：
 * 先用 pi 的真实能力表判断模型支持哪几档，支持 high 就传 high；不支持就降一档；
 * 只支持 off（或没有更低档位）时干脆不传 reasoning，避免把 non-reasoning
 * 模型逼成「关闭思考」参数，也避免传一个服务端不认识的档位。
 */
export const DESIRED_THINKING_LEVEL: EffectiveThinkingLevel = 'high'

/** 能作为 reasoning 传给 pi 的档位（minimal-高）；off 表示「不支持思考」，要省略。 */
export type EffectiveThinkingLevel = Exclude<ModelThinkingLevel, 'off'>

const LOWER_THAN_HIGH = ['medium', 'low', 'minimal'] as const

export function chooseThinkingLevel(
  supported: readonly ModelThinkingLevel[]
): EffectiveThinkingLevel | undefined {
  if (supported.includes(DESIRED_THINKING_LEVEL)) {
    return DESIRED_THINKING_LEVEL
  }
  const available = new Set(supported)
  return LOWER_THAN_HIGH.find((level) => available.has(level))
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/** 只给 `getSupportedThinkingLevels` 读 reasoning / thinkingLevelMap 用。 */
function piModelOf(descriptor: ChatModelDescriptor): Model<Api> {
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

export async function resolveThinkingLevel(
  descriptor: ChatModelDescriptor
): Promise<EffectiveThinkingLevel | undefined> {
  const pi = await loadPi()
  return chooseThinkingLevel(
    pi.getSupportedThinkingLevels(piModelOf(descriptor)) as ModelThinkingLevel[]
  )
}
