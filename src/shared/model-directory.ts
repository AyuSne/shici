import { MODEL_PROVIDERS, findCatalogModel, type CatalogModel } from './model-catalog'
import type { ModelProtocol } from './model-protocols'

/**
 * 查本地模型目录的共享规则。
 *
 * 内置 provider 只认自己目录入口里的模型；自定义 provider 没有目录身份，
 * 按模型 ID 在全部入口里找，并优先选协议一致的那条。这样中转站手填
 * `deepseek-v4-pro` 这类常见 ID 时能带出容量，而不会把 Anthropic 模型的
 * 元数据套到 OpenAI 兼容入口上。找不到就是「不在目录」，调用方保留
 * 未知 ID 的加入与发送能力。
 */
export type ModelCatalogIdentity = {
  source: 'builtin' | 'custom'
  /** 内置目录身份；自定义 provider 为 null。 */
  catalogProviderId: string | null
  protocol: ModelProtocol | null
}

export function findProviderCatalogModel(
  identity: ModelCatalogIdentity,
  modelId: string
): CatalogModel | null {
  const id = modelId.trim()
  if (id === '') {
    return null
  }
  if (identity.catalogProviderId !== null) {
    return findCatalogModel(identity.catalogProviderId, id) ?? null
  }
  if (identity.protocol === null) {
    return null
  }
  // 同名模型在不同协议下可能是两种东西：这里只认当前协议的那一份。
  for (const provider of MODEL_PROVIDERS) {
    const model = provider.models.find(
      (candidate) => candidate.id === id && candidate.api === identity.protocol
    )
    if (model !== undefined) {
      return model
    }
  }
  return null
}

/**
 * OpenCode GO 这类聚合入口的模型目录首版只读：能选默认模型，不能手加、改、
 * 删或重排。主进程的写入口与渲染层的按钮状态共用这一条判定，避免两边各写
 * 一份、新增只读入口时漏掉一层。
 */
export function isModelDirectoryReadOnly(provider: {
  catalogProviderId: string | null
}): boolean {
  return provider.catalogProviderId === 'opencode-go'
}
