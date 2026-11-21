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
  /** 库里是否存着本机密文（不论能否解开）；环境模式可能由历史遗留。 */
  hasStoredCiphertext: boolean
  /**
   * 本机有密文但解不开。此时 `keyState` 仍是 `stored`（来源没变），
   * 界面要给出「重新填写 / 改用环境变量」的动作提示，发送也必须明确报错。
   */
  credentialError: 'stored-decrypt-failed' | null
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
  /** 密钥来源；不传按本机处理（兼容只传 apiKey 的旧调用）。 */
  authMode?: ProviderAuthMode
  /**
   * 环境变量名：环境模式必填（不传用目录默认值）；本机模式也保存下来，
   * 供以后切换到环境变量时直接带出。空串等于使用目录值。
   */
  envVar?: string | null
  /**
   * 只在本机模式使用。环境模式即使带了也直接忽略：不加密、不落密文，
   * 保存时不联网。
   */
  apiKey?: string | null
}

export type AddBuiltinProviderResult =
  | { status: 'saved'; providerId: string; providerKey: string }
  | {
      status: 'rejected'
      reason: 'unknown-provider' | 'missing-key' | 'invalid-env-var'
    }

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

/** 自定义 provider 保存时至少要带一个模型；模型行可带容量等已解析元数据。 */
export type CustomProviderModelDraft = {
  modelId: string
  displayName?: string
  contextWindow?: number | null
  maxTokens?: number | null
  reasoning?: boolean
  /** 获取可用模型勾选进来的行记 fetched；手填默认 manual。 */
  source?: 'manual' | 'fetched'
}

export type CreateCustomProviderRequest = {
  /**
   * 唯一且创建后不可改的 Provider ID：落库到 `provider_key` 列，是配置与
   * 凭据引用的稳定身份。返回结果里的 `providerId` 是库内 UUID，两者不同。
   */
  providerKey: string
  displayName: string
  /** 本票只开放 OpenAI Chat Completions，但值仍来自共享协议表。 */
  protocol: ProviderProtocol
  baseUrl: string
  /** 密钥来源；不传按本机处理。环境模式不需要先存本机密钥。 */
  authMode?: ProviderAuthMode
  /** 环境变量名：环境模式必填；本机模式也保留下来备用。 */
  envVar?: string | null
  /**
   * 本机模式下保存的密钥。空串表示先存成「缺失」草稿：保存不联网，卡片会
   * 明确显示缺失；发送或获取模型前必须补上密钥，绝不会匿名请求。
   * 环境模式即使带了也忽略：不加密、不落密文。
   */
  apiKey?: string
  /** 自定义 provider 至少要有一个模型才能保存。 */
  model: CustomProviderModelDraft
  /**
   * 「获取可用模型」勾选后、保存时才一起入库的其它模型。
   * 与 `model` 同属一次事务：任一行非法就整笔拒绝，不会先建 provider 再逐条补。
   */
  additionalModels?: CustomProviderModelDraft[]
}

export type CustomProviderRejection =
  | 'invalid-provider-id'
  | 'duplicate-provider-id'
  | 'missing-display-name'
  | 'unsupported-protocol'
  | 'missing-base-url'
  | 'invalid-base-url'
  | 'missing-model'
  | 'duplicate-model-id'
  | 'invalid-capacity'
  | 'missing-key'
  | 'invalid-env-var'

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
  /**
   * 保存后的来源：手动加入或「获取可用模型」勾选。只在新增时使用；
   * 目录内置行仍由目录写入路径标 catalog。
   */
  source?: 'manual' | 'fetched'
}

export type AddProviderModelRequest = {
  providerId: string
  model: ProviderModelDraft
  /** 与 `model` 同一事务加入的其它候选；用于「加入所选模型」一次提交。 */
  additionalModels?: ProviderModelDraft[]
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
