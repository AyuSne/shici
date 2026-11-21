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
