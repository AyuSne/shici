/**
 * 「获取可用模型」的请求与结果契约。
 *
 * 请求里带的是设置页表单**当前**的值（可能尚未保存）：地址、协议、密钥来源、
 * 环境变量名或新密钥。主进程只读地解析一次，不写库、不打印密钥；返回的候选
 * 只是列表，是否加入目录由用户勾选后另行显式保存。
 */

import type {
  ProviderAuthMode,
  ProviderProtocol
} from './model-providers'

/** 候选来源：内置目录直接读本地；自定义 API 从远端返回。 */
export type FetchedModelOrigin = 'catalog' | 'remote'

/** 一条可加入目录的候选；容量与思考能力拿不到时保持 null，由目录/发送层兜底。 */
export type FetchedModelCandidate = {
  modelId: string
  displayName: string
  contextWindow: number | null
  maxTokens: number | null
  /**
   * `true` / `false` 表示上游明确给出；`null` 表示列表没提这件事（OpenAI 与
   * Anthropic 的模型列表通常如此）。不能把「没提」写成 false，否则保存一个
   * 目录里已知支持思考的模型时会把本地目录的 true 覆盖掉。
   */
  reasoning: boolean | null
  origin: FetchedModelOrigin
}

export type FetchProviderModelsRequest = {
  /**
   * `builtin`：只按内置目录身份返回本地目录，零 HTTP（含 OpenCode GO）；
   * `custom`：按当前表单地址真正请求服务商。
   */
  source: 'builtin' | 'custom'
  /** 内置目录身份（deepseek / kimi / glm / opencode-go …）；自定义为 null。 */
  catalogProviderId?: string | null
  /**
   * 仅当用户明确在编辑一套已有的自定义 provider 时传：本机模式留空密钥时，
   * 只从这一套解出已存密钥。不是「按 id 随便借一把钥匙」。
   */
  providerId?: string | null
  /** 表单当前协议；库里存了不认识的协议时传 null，明确拒绝而不是猜。 */
  protocol: ProviderProtocol | null
  /** 表单当前地址；内置身份下不参与请求。 */
  baseUrl: string
  /** 表单当前密钥来源；环境模式只读环境变量，忽略请求里的 apiKey。 */
  authMode: ProviderAuthMode
  /** 表单当前环境变量名；环境模式按它点名缺失。 */
  envVar?: string
  /** 本机模式的新密钥；非空时优先于同一 provider 的已存密文。 */
  apiKey?: string
  /** 已在目录或草稿里的模型 ID：候选里不再重复返回。 */
  knownModelIds?: readonly string[]
}

export type ModelDiscoveryFailureReason =
  | 'invalid-base-url'
  | 'unsupported-protocol'
  | 'unknown-catalog'
  | 'unknown-provider'
  | 'provider-mismatch'
  | 'missing-credential'
  | 'credential-error'
  | 'http-error'
  | 'invalid-format'
  | 'too-large'
  | 'timeout'
  | 'transport'

/** 凭据缺失/不可用的具体原因；不含任何密钥内容。 */
export type ModelDiscoveryCredentialProblem =
  | 'env-var-unset'
  | 'env-missing'
  | 'stored-missing'
  | 'stored-decrypt-failed'

export type FetchProviderModelsFailure = {
  status: 'rejected'
  reason: ModelDiscoveryFailureReason
  /** 环境变量缺失时点名变量；变量名本身不敏感。 */
  envVar?: string
  /** 仅凭据类失败：说清是没填、变量没值、还是本机密文解不开。 */
  problem?: ModelDiscoveryCredentialProblem
  /** 仅 HTTP 失败：只给状态码，不回传上游响应正文（可能回显密钥）。 */
  httpStatus?: number
}

export type FetchProviderModelsResult =
  | { status: 'fetched'; candidates: FetchedModelCandidate[] }
  | FetchProviderModelsFailure

/** 响应体字节上限：实际流式读取的字节数，绝不信任 Content-Length。 */
export const MODEL_DISCOVERY_MAX_BYTES = 4 * 1024 * 1024

/** 覆盖响应头与响应体；超时后取消读取并释放连接。 */
export const MODEL_DISCOVERY_TIMEOUT_MS = 15_000
