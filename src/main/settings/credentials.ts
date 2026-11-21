import type { ProviderAuthMode } from '../../shared/model-providers'
import {
  isValidEnvVarName,
  type ProviderCredentialProblem,
  type UpdateProviderCredentialRequest
} from '../../shared/provider-credentials'
import { readEnvValue } from '../process-env'
import type { ModelProviderRecord } from './providers'
import type { SecretStore } from './secret-store'

/**
 * 密钥来源的唯一解析与编码处。
 *
 * 规则只有一条：本机模式只读密文，环境模式只读环境变量。两种来源互不兜底，
 * 解不开的密文不会被当成「没填」再悄悄换环境变量——那会让用户以为在用 A，
 * 实际发出去的是 B。
 */

export type CredentialReadOptions = {
  secrets: SecretStore
  env?: NodeJS.ProcessEnv
}

export type ResolvedCredential =
  | { state: 'stored'; apiKey: string }
  | { state: 'env'; apiKey: string; envVar: string }
  | { state: 'missing'; problem: ProviderCredentialProblem }

type CredentialSource = Pick<ModelProviderRecord, 'authMode' | 'envVar' | 'secretCiphertext'>

/**
 * 解析一套 provider 此刻真正能用的密钥。
 * 环境模式绝不读旧密文：即使库里还留着历史密文，也不解密、不参与判断。
 */
export function resolveProviderCredential(
  provider: CredentialSource,
  options: CredentialReadOptions
): ResolvedCredential {
  if (provider.authMode === 'env') {
    const name = provider.envVar?.trim() ?? ''
    if (name === '') {
      return { state: 'missing', problem: { kind: 'env-var-unset' } }
    }
    // 变量名可编辑：继承属性（constructor/__proto__）与非字符串值都算没设置，
    // 不能在这里对函数调 trim。
    const value = readEnvValue(options.env, name)
    if (value === null) {
      return { state: 'missing', problem: { kind: 'env-missing', envVar: name } }
    }
    return { state: 'env', apiKey: value, envVar: name }
  }

  if (provider.secretCiphertext === null) {
    return { state: 'missing', problem: { kind: 'stored-missing' } }
  }
  let plain: string | null
  try {
    plain = options.secrets.decrypt(provider.secretCiphertext)
  } catch {
    // 解密抛错与返回 null 都代表「有密文但解不开」：明确报错，不静默当缺失。
    plain = null
  }
  if (plain === null || plain.trim() === '') {
    return { state: 'missing', problem: { kind: 'stored-decrypt-failed' } }
  }
  return { state: 'stored', apiKey: plain }
}

/* ---------- 创建时编码凭据 ---------- */

export type CredentialColumns = {
  authMode: ProviderAuthMode
  envVar: string | null
  secretCiphertext: string | null
}

export type CredentialInput = {
  authMode?: ProviderAuthMode
  envVar?: string | null
  apiKey?: string | null
  /**
   * 自定义 API 可以先留空存成「缺失」草稿：保存本身不联网，卡片会明确写
   * 「缺失」，发送或获取模型前仍必须补上密钥，绝不会匿名请求。内置目录
   * 添加不传这个开关，仍然必须填 key。
   */
  allowMissingStoredKey?: boolean
}

export type PrepareCredentialResult =
  | ({ ok: true } & CredentialColumns)
  | { ok: false; reason: 'missing-key' | 'invalid-env-var' }

/**
 * 新建 provider 时把请求里的凭据编成三列。
 *
 * 环境模式即使请求里带了 `apiKey` 也直接忽略：不加密、不落密文。
 * 本机模式先加密再交回给调用方，加密不可用时调用方什么都不写。
 */
export function prepareProviderCredential(
  secrets: SecretStore,
  input: CredentialInput
): PrepareCredentialResult {
  const authMode: ProviderAuthMode = input.authMode === 'env' ? 'env' : 'stored'
  const envVar = input.envVar?.trim() ?? ''
  if (envVar !== '' && !isValidEnvVarName(envVar)) {
    return { ok: false, reason: 'invalid-env-var' }
  }

  if (authMode === 'env') {
    if (envVar === '') {
      return { ok: false, reason: 'invalid-env-var' }
    }
    return { ok: true, authMode, envVar, secretCiphertext: null }
  }

  const apiKey = input.apiKey?.trim() ?? ''
  if (apiKey === '') {
    if (input.allowMissingStoredKey === true) {
      return { ok: true, authMode, envVar: envVar === '' ? null : envVar, secretCiphertext: null }
    }
    return { ok: false, reason: 'missing-key' }
  }
  return { ok: true, authMode, envVar: envVar === '' ? null : envVar, secretCiphertext: secrets.encrypt(apiKey) }
}

/* ---------- 编辑已有 provider 的凭据 ---------- */

export type CredentialUpdatePlan =
  | {
      ok: true
      authMode: ProviderAuthMode
      envVar: string | null
      secretCiphertext: string | null
      /** 密钥来源或密文真的变了：旧校验状态不再代表这次配置。 */
      credentialChanged: boolean
      clearedStored: boolean
    }
  | { ok: false; reason: 'missing-key' | 'invalid-env-var' | 'confirm-required' }

/**
 * 编辑凭据的纯计算：不碰库、不打印任何密钥。数据库写入在
 * `credential-writes.ts` 里一次事务完成，避免只改了一半。
 */
export function planCredentialUpdate(
  provider: CredentialSource,
  secrets: SecretStore,
  request: UpdateProviderCredentialRequest
): CredentialUpdatePlan {
  const authMode: ProviderAuthMode = request.authMode === 'env' ? 'env' : 'stored'
  const envVar = request.envVar.trim()
  if (envVar !== '' && !isValidEnvVarName(envVar)) {
    return { ok: false, reason: 'invalid-env-var' }
  }

  if (authMode === 'env') {
    if (envVar === '') {
      return { ok: false, reason: 'invalid-env-var' }
    }
    // 从本机切到环境会删掉唯一可用的本机密钥，必须由界面显式确认；
    // 后端同样拦一道，不能只靠界面。
    if (
      provider.authMode === 'stored' &&
      provider.secretCiphertext !== null &&
      request.confirmClearStored !== true
    ) {
      return { ok: false, reason: 'confirm-required' }
    }
    const envVarChanged = (provider.envVar ?? '').trim() !== envVar
    // 环境模式从不看请求里的 apiKey：不解密、不加密。
    return {
      ok: true,
      authMode,
      envVar,
      secretCiphertext: null,
      credentialChanged:
        provider.authMode !== 'env' || provider.secretCiphertext !== null || envVarChanged,
      clearedStored: provider.secretCiphertext !== null
    }
  }

  if (request.clearStoredKey === true) {
    return {
      ok: true,
      authMode,
      envVar: envVar === '' ? null : envVar,
      secretCiphertext: null,
      credentialChanged: provider.authMode !== 'stored' || provider.secretCiphertext !== null,
      clearedStored: provider.secretCiphertext !== null
    }
  }

  const apiKey = request.apiKey.trim()
  if (apiKey === '') {
    // 环境模式里可能留着历史密文（本就不参与解析）；切回本机时不能把这种
    // 旧密文当成有效密钥，必须重新填一把。
    if (provider.authMode === 'env' || provider.secretCiphertext === null) {
      return { ok: false, reason: 'missing-key' }
    }
    // 留空 = 保持已存密文；只改环境变量名不重置校验状态。
    return {
      ok: true,
      authMode,
      envVar: envVar === '' ? null : envVar,
      secretCiphertext: provider.secretCiphertext,
      credentialChanged: provider.authMode !== 'stored',
      clearedStored: false
    }
  }

  return {
    ok: true,
    authMode,
    envVar: envVar === '' ? null : envVar,
    secretCiphertext: secrets.encrypt(apiKey),
    credentialChanged: true,
    clearedStored: false
  }
}
