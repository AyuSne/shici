import type { ProviderAuthMode } from './model-providers'

/**
 * 密钥来源的跨层类型：解析三态、编辑器输入与写回请求。
 *
 * 明文只在主进程里出现；这里没有、也不该有保存明文密钥的字段。
 */

/** 主进程解析后仍拿不到密钥的原因。界面据此点名变量或指路。 */
export type ProviderCredentialProblem =
  | { kind: 'stored-decrypt-failed' }
  | { kind: 'stored-missing' }
  | { kind: 'env-missing'; envVar: string }
  | { kind: 'env-var-unset' }

/**
 * 凭据编辑器的四个输入（创建与编辑共用）：
 * `confirmClearStored` 是「从本机切到环境会清除已存密文」的显式确认，
 * 后端也按它做 guard，不能只靠界面拦。
 */
export type ProviderCredentialDraft = {
  authMode: ProviderAuthMode
  envVar: string
  apiKey: string
  confirmClearStored: boolean
}

export type UpdateProviderCredentialRequest = ProviderCredentialDraft & {
  providerId: string
  /** 本机模式下显式清除已存密文；与切换来源的确认分开。 */
  clearStoredKey?: boolean
}

export type CredentialRejectionReason =
  | 'missing-key'
  | 'invalid-env-var'
  /** 从本机切到环境，但没带「清除已存密文」的显式确认。 */
  | 'confirm-required'

export type UpdateProviderCredentialResult =
  | { status: 'saved'; authMode: ProviderAuthMode; clearedStored: boolean }
  /** provider 已经不在了。 */
  | { status: 'missing' }
  | { status: 'rejected'; reason: CredentialRejectionReason }

/** 环境变量名按最常见的 shell / Windows 规则：字母或下划线开头，只含字母数字下划线。 */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidEnvVarName(value: string): boolean {
  return ENV_VAR_NAME.test(value.trim())
}
