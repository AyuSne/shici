/**
 * 模型提供商与它的模型目录：主进程读出来给设置页的只读视图。
 * 密钥明文只在主进程里出现；这里最多只有掩码，环境变量模式连掩码都没有。
 */

import type { ModelProtocol } from './model-protocols'

/**
 * 四种协议；OpenCode GO 的模型各自带 `api`，单协议 provider 的所有模型都跟它一致。
 * 与共享目录同一个类型，协议 ID 只有一份清单（见 `model-protocols.ts`）。
 */
export type ProviderProtocol = ModelProtocol

/** 密钥来源：存本机（safeStorage 密文）或读环境变量。 */
export type ProviderAuthMode = 'stored' | 'env'

/** 主进程解析后的三态；缺失时明确报错，不静默换源。 */
export type ProviderKeyState = 'stored' | 'env' | 'missing'

export type ProviderVerification = 'verified' | 'unverified'

/** 上次校验没通过的原因；网络不通时不算密钥错。 */
export type ProviderCheckError = 'invalid-key' | 'invalid-config' | 'network'

export type ProviderSource = 'builtin' | 'custom'

export type ModelSource = 'catalog' | 'manual' | 'fetched'

export type ModelInput = 'text' | 'image'

/** 重试策略：默认只重试临时错误，也可改成所有失败。 */
export type RetryMode = 'normal' | 'always'

export type ProviderRetryPolicy = {
  mode: RetryMode
}

export const DEFAULT_RETRY_POLICY: ProviderRetryPolicy = { mode: 'normal' }

export type ModelProviderModelSummary = {
  /** 模型行的库内 id；默认模型指向它。 */
  id: string
  /** 请求里真正发送的模型名。 */
  modelId: string
  displayName: string
  /**
   * 该模型的协议；聚合网关可以逐模型不同。
   * null 表示库里存了本版不认识的协议：不猜成别的协议，也不拿它发请求。
   */
  api: ProviderProtocol | null
  baseUrl: string | null
  contextWindow: number | null
  maxTokens: number | null
  input: ModelInput
  reasoning: boolean
  source: ModelSource
  sort: number
}

export type ModelProviderSummary = {
  id: string
  /** Provider ID：小写字母开头，只含小写字母、数字与连字符；创建后不可改。 */
  providerKey: string
  displayName: string
  /** 库里存的协议；null 表示本版不认识该值，不静默换成别的协议。 */
  protocol: ProviderProtocol | null
  baseUrl: string | null
  authMode: ProviderAuthMode
  envVar: string | null
  /** 已保存密钥的掩码；环境变量模式、没填、或本机解不开时为 null。 */
  apiKeyMask: string | null
  /** 主进程解析出的密钥来源三态。 */
  keyState: ProviderKeyState
  retryPolicy: ProviderRetryPolicy
  verification: ProviderVerification
  lastError: ProviderCheckError | null
  lastCheckedAt: string | null
  lastVerifiedAt: string | null
  source: ProviderSource
  /** 内置目录身份（deepseek / kimi / glm）；迁移来的 custom 为 null。 */
  catalogProviderId: string | null
  /** 切换只影响之后的调用，所以这里只标「使用中」。 */
  active: boolean
  /** 该 provider 的默认模型**行 id**（库内 id，不是请求里发送的模型名）；没有模型时为 null。 */
  defaultModelRowId: string | null
  models: ModelProviderModelSummary[]
}

/* ---------- #62：从内置目录添加、选择默认模型、激活与删除 ---------- */

export type AddBuiltinProviderRequest = {
  /** 目录入口 id：deepseek / kimi / glm。 */
  catalogProviderId: string
  /** 写一次就加密保存，保存时不联网校验；结果里不会再回传。 */
  apiKey: string
}

export type AddBuiltinProviderResult =
  | { status: 'saved'; providerId: string; providerKey: string }
  | { status: 'rejected'; reason: 'unknown-provider' | 'missing-key' }

export type SetDefaultProviderModelRequest = {
  providerId: string
  /** 模型行的库内 id，不是请求里发送的 model id。 */
  modelRowId: string
}

export type SetDefaultProviderModelResult =
  | { status: 'saved'; defaultModelRowId: string }
  | { status: 'rejected'; reason: 'unknown-model' }
  | { status: 'missing' }

export type ActivateProviderRequest = {
  providerId: string
}

export type ActivateProviderResult =
  | { status: 'activated'; activeProviderId: string }
  | { status: 'missing' }

export type DeleteProviderRequest = {
  providerId: string
}

export type DeleteProviderResult =
  | {
      status: 'deleted'
      /** 删的是使用中的那套：选择被明确清空，不会静默换成别的凭据。 */
      activeCleared: boolean
    }
  | { status: 'missing' }

/* ---------- #63：自定义 provider 与模型目录编辑 ---------- */

/** Provider ID 的精确形状：小写字母开头，单词之间只用一个连字符。 */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export function isValidProviderId(value: string): boolean {
  return PROVIDER_ID_PATTERN.test(value)
}

/** 自定义 provider 保存时至少要带一个模型；本票先只收模型 ID。 */
export type CustomProviderModelDraft = {
  modelId: string
  displayName?: string
}

export type CreateCustomProviderRequest = {
  /** 唯一且创建后不可改。 */
  providerId: string
  displayName: string
  /** 本票只开放 OpenAI Chat Completions，但值仍来自共享协议表。 */
  protocol: ProviderProtocol
  baseUrl: string
  /**
   * 保存到本机的密钥。空串表示这个地址不需要密钥（自部署/本地中转）。
   * #68 接入凭据模式后，这一层由 authMode / envVar 取代。
   */
  apiKey: string
  /** 自定义 provider 至少要有一个模型才能保存。 */
  model: CustomProviderModelDraft
}

export type CustomProviderRejection =
  | 'invalid-provider-id'
  | 'duplicate-provider-id'
  | 'missing-display-name'
  | 'unsupported-protocol'
  | 'missing-base-url'
  | 'invalid-base-url'
  | 'missing-model'

export type CreateCustomProviderResult =
  | { status: 'saved'; providerId: string; providerKey: string }
  | { status: 'rejected'; reason: CustomProviderRejection }

/** 只允许改显示名与地址：Provider ID 与协议创建后不可改。 */
export type UpdateProviderRequest = {
  providerId: string
  displayName: string
  baseUrl: string
}

export type UpdateProviderRejection =
  | 'missing-display-name'
  | 'missing-base-url'
  | 'invalid-base-url'

export type UpdateProviderResult =
  | { status: 'saved' }
  | { status: 'missing' }
  | { status: 'rejected'; reason: UpdateProviderRejection }

/** 手填模型行：容量留空表示按目录/兜底处理。 */
export type ProviderModelDraft = {
  modelId: string
  displayName?: string
  contextWindow?: number | null
  maxTokens?: number | null
  reasoning?: boolean
}

export type AddProviderModelRequest = {
  providerId: string
  model: ProviderModelDraft
}

export type UpdateProviderModelRequest = {
  providerId: string
  modelRowId: string
  /** 没给的容量字段保持原值；显式 null 表示清空。 */
  model: ProviderModelDraft
}

export type DeleteProviderModelRequest = {
  providerId: string
  modelRowId: string
}

export type ReorderProviderModelsRequest = {
  providerId: string
  /** 完整的模型行顺序；必须与当前目录一一对应，否则拒绝。 */
  modelRowIds: string[]
}

export type ProviderModelRejection =
  | 'missing-model-id'
  | 'duplicate-model-id'
  | 'unknown-model'
  | 'unknown-protocol'
  | 'invalid-capacity'
  /** 还是默认模型：先另选一个默认模型再删。 */
  | 'default-model'
  /** 目录至少留一条模型。 */
  | 'last-model'
  | 'order-mismatch'
  /** OpenCode GO 这类聚合入口的目录首版只读，只能选默认模型。 */
  | 'read-only'

export type ProviderModelWriteResult =
  | { status: 'saved' }
  | { status: 'deleted' }
  | { status: 'missing' }
  | { status: 'rejected'; reason: ProviderModelRejection }
