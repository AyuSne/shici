import {
  findModelProvider,
  isAggregateCatalogProvider,
  type CatalogModel,
  type CatalogProvider,
  type ModelProtocol
} from './model-catalog'

/**
 * 从内置目录添加的入口。批 2 开了 DeepSeek、Kimi（中国大陆区）与智谱 GLM；
 * 批 3 追加 Anthropic、MiniMax（Anthropic Messages）与 OpenAI、xAI
 * （OpenAI Responses）以及 Google Gemini（Gemini API），最后是聚合入口
 * OpenCode GO。其余入口由各自票据追加，最终取并集；这里不按名字去猜，
 * 也不从别的厂商目录克隆模型。
 */
export const BUILTIN_PROVIDER_IDS = [
  'deepseek',
  'kimi',
  'glm',
  'anthropic',
  'minimax',
  'openai',
  'xai',
  'gemini',
  'opencode-go'
] as const

export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number]

/**
 * 聚合入口在库里的协议表达：`model_provider.protocol` 是 TEXT NOT NULL，而
 * OpenCode GO 没有单一协议。这里存一个显式哨兵，读取层仍按「未知协议」保护
 * （返回 null），真正的「按模型混合」语义只由目录身份判定；绝不冒充
 * `openai-completions` 或增改旧 migration。
 */
export const AGGREGATE_PROTOCOL_STORAGE = 'mixed'

/** 一条内置入口：端点、环境变量、协议与只读模型目录都来自 #60 的生成产物。 */
export type BuiltinProviderSetup = {
  id: BuiltinProviderId
  displayName: string
  /** 单协议入口的协议；聚合入口为 null，协议按模型给。 */
  protocol: ModelProtocol | null
  /** 单协议入口的默认端点；聚合入口为 null，地址按模型给。 */
  baseUrl: string | null
  envVar: string
  models: readonly CatalogModel[]
}

export function isBuiltinProviderId(value: unknown): value is BuiltinProviderId {
  return (
    typeof value === 'string' &&
    (BUILTIN_PROVIDER_IDS as readonly string[]).includes(value)
  )
}

function setupOf(provider: CatalogProvider): BuiltinProviderSetup | null {
  const aggregate = isAggregateCatalogProvider(provider.id)
  // 聚合入口必须两项都为空（协议与地址按模型给）；单协议入口必须两项都有值。
  // 任何「一半空」的目录数据都不猜，也不静默换成一个默认协议。
  if (aggregate) {
    if (provider.protocol !== null || provider.baseUrl !== null) {
      return null
    }
  } else if (provider.protocol === null || provider.baseUrl === null) {
    return null
  }
  return {
    id: provider.id as BuiltinProviderId,
    displayName: provider.displayName,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    envVar: provider.envVar,
    models: provider.models
  }
}

/** 目录里读一条内置入口；本票不开放的入口一律返回 null，调用方不得自行降级。 */
export function readBuiltinProviderSetup(id: string): BuiltinProviderSetup | null {
  if (!isBuiltinProviderId(id)) {
    return null
  }
  const provider = findModelProvider(id)
  return provider === undefined ? null : setupOf(provider)
}

export function listBuiltinProviderSetups(): BuiltinProviderSetup[] {
  const setups: BuiltinProviderSetup[] = []
  for (const id of BUILTIN_PROVIDER_IDS) {
    const setup = readBuiltinProviderSetup(id)
    if (setup !== null) {
      setups.push(setup)
    }
  }
  return setups
}
