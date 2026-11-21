import {
  findModelProvider,
  type CatalogModel,
  type CatalogProvider,
  type ModelProtocol
} from './model-catalog'

/**
 * 从内置目录添加的入口。批 2 开了 DeepSeek、Kimi（中国大陆区）与智谱 GLM；
 * 批 3 追加 Anthropic、MiniMax（Anthropic Messages）与 OpenAI、xAI
 * （OpenAI Responses）以及 Google Gemini（Gemini API）。
 * 其余入口由各自票据追加，最终取并集；这里不按名字去猜，也不从别的
 * 厂商目录克隆模型。
 */
export const BUILTIN_PROVIDER_IDS = [
  'deepseek',
  'kimi',
  'glm',
  'anthropic',
  'minimax',
  'openai',
  'xai',
  'gemini'
] as const

export type BuiltinProviderId = (typeof BUILTIN_PROVIDER_IDS)[number]

/** 一条内置入口：端点、环境变量、协议与只读模型目录都来自 #60 的生成产物。 */
export type BuiltinProviderSetup = {
  id: BuiltinProviderId
  displayName: string
  protocol: ModelProtocol
  baseUrl: string
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
  if (provider.protocol === null || provider.baseUrl === null) {
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
