import catalogJson from './model-catalog.json'

/** 首版支持的四条协议。值同时是 pi-ai 的 api 名称。 */
export const MODEL_PROTOCOLS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
] as const

export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number]

export type ModelThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export type CatalogModelInput = 'text' | 'image'

export type CatalogModelCostTier = {
  readonly inputTokensAbove: number
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type CatalogModelCost = {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly tiers?: readonly CatalogModelCostTier[]
}

/**
 * pi Model descriptor 里可序列化的部分。
 *
 * 不存函数；`thinkingLevelMap` 与 `compat` 必须保留：后续用
 * `getSupportedThinkingLevels` 把默认 high 降级到模型支持的档位时，只看
 * `reasoning` 布尔不够（例如 DeepSeek/Kimi 用 compat 决定思考格式）。
 */
export type CatalogModel = {
  readonly id: string
  readonly name: string
  readonly api: ModelProtocol
  /** 只有多协议聚合入口（OpenCode GO）按模型带地址；单协议入口继承 provider.baseUrl。 */
  readonly baseUrl?: string
  readonly reasoning: boolean
  readonly thinkingLevelMap?: Readonly<
    Partial<Record<ModelThinkingLevel, string | null>>
  >
  readonly input: readonly CatalogModelInput[]
  readonly inputLimits?: Readonly<Record<string, unknown>>
  readonly contextWindow: number
  readonly maxTokens: number
  readonly cost: CatalogModelCost
  readonly promptCache?: Readonly<Record<string, unknown>>
  readonly compat?: Readonly<Record<string, unknown>>
  readonly samplingParams?: Readonly<Record<string, unknown>>
  readonly samplingParamsByThinkingLevel?: Readonly<
    Partial<Record<ModelThinkingLevel, Readonly<Record<string, unknown>>>>
  >
}

export type CatalogAuthHeader = {
  readonly header: string
  readonly scheme?: string
}

export type CatalogSource = {
  readonly title: string
  readonly url: string
}

export type CatalogProvider = {
  readonly id: string
  readonly displayName: string
  /** pi 内置目录里的来源 provider，升级 pi 后用于审查模型新增与删除。 */
  readonly piProvider: string
  /** null 表示多协议聚合入口，每个模型自带 api。 */
  readonly protocol: ModelProtocol | null
  /** 单协议入口的默认端点；聚合入口为 null，地址按模型给。 */
  readonly baseUrl: string | null
  readonly envVar: string
  readonly auth: CatalogAuthHeader
  readonly region?: string
  readonly notes?: string
  readonly sources: readonly CatalogSource[]
  readonly models: readonly CatalogModel[]
}

export type ModelProviderCatalog = {
  readonly schemaVersion: number
  readonly piVersion: string
  readonly providers: readonly CatalogProvider[]
}

/**
 * 构建期由 scripts/generate-model-catalog.mjs 生成，经 Vite 的 JSON 导入直接打进
 * 主进程/渲染层产物，因此开发与只带 out/ 的打包应用读的是同一份数据，不依赖
 * 运行时 cwd 或 src/ 路径。
 */
export const MODEL_PROVIDER_CATALOG = catalogJson as unknown as ModelProviderCatalog

export const MODEL_PROVIDERS: readonly CatalogProvider[] =
  MODEL_PROVIDER_CATALOG.providers

export function isModelProtocol(value: unknown): value is ModelProtocol {
  return (
    typeof value === 'string' &&
    (MODEL_PROTOCOLS as readonly string[]).includes(value)
  )
}

export function findModelProvider(
  providerId: string
): CatalogProvider | undefined {
  return MODEL_PROVIDERS.find((provider) => provider.id === providerId)
}

export function findCatalogModel(
  providerId: string,
  modelId: string
): CatalogModel | undefined {
  return findModelProvider(providerId)?.models.find(
    (model) => model.id === modelId
  )
}

/** 模型的请求协议；单协议入口与模型行一致，聚合入口按模型自身的 api。 */
export function resolveModelProtocol(
  _provider: CatalogProvider,
  model: CatalogModel
): ModelProtocol {
  return model.api
}

/** 模型地址：模型行优先，其次 provider；聚合入口每个模型都必须带地址。 */
export function resolveModelBaseUrl(
  provider: CatalogProvider,
  model: CatalogModel
): string | null {
  return model.baseUrl ?? provider.baseUrl
}
