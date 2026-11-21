import type { ModelThinkingLevel } from '../../shared/model-catalog'
import type { ChatModelDescriptor } from './model-descriptor'
import { loadPi } from './pi-modules'
import { piModelOf } from './pi-model'

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

/**
 * 能力查询与真实请求共用 `piModelOf`：判断思考档位时看到的模型，
 * 必须与真正发给 pi 的那个完全一致。
 */
export async function resolveThinkingLevel(
  descriptor: ChatModelDescriptor
): Promise<EffectiveThinkingLevel | undefined> {
  const pi = await loadPi()
  return chooseThinkingLevel(
    pi.getSupportedThinkingLevels(piModelOf(descriptor)) as ModelThinkingLevel[]
  )
}
