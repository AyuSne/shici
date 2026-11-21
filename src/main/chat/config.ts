import type { AppDatabase } from '../db/database'
import {
  isProviderSelectionCleared,
  readActiveChatProvider,
  readModelProviderRecords
} from '../settings/providers'
import type { SecretStore } from '../settings/secret-store'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  descriptorOfProvider,
  readEnvChatConfig,
  type ChatModelDescriptor
} from './model-descriptor'

export { DEFAULT_BASE_URL, DEFAULT_MODEL }

export type ChatConfig = {
  apiKey: string
  baseUrl: string
  model: string
  /** 来自设置里的哪个 provider 与模型；环境变量配置没有这一段，也不参与状态回写。 */
  providerId?: string
  modelId?: string
  /** 这次调用冻结的描述符：协议、地址、容量与思考元数据都在这里。 */
  descriptor: ChatModelDescriptor
  /**
   * 配置写着「用本机密钥」或「读环境变量」，但凭据确实拿不到：
   * 发送前就明确报配置错误，不拿空密钥去撞服务端，也不换源。
   */
  missingCredential?: boolean
}

/**
 * 模型配置先由环境变量注入，不经过设置页（开发态与 E2E 的退路）。
 * 缺密钥时返回 null，由对话服务在发送时给出一条明确的配置错误。
 */
export function readChatConfig(env: NodeJS.ProcessEnv): ChatConfig | null {
  const config = readEnvChatConfig(env)
  if (config === null) {
    return null
  }
  return config
}

/**
 * 一次调用真正该用的配置：设置里使用中的 provider 与它的默认模型优先，
 * 没有才退回环境变量。每次调用都重新解析，所以切换只影响之后的调用，不动历史消息。
 *
 * 用户删掉使用中的 provider 之后会留下「选择已清空」标记：这时不再静默用
 * 环境变量里的另一套凭据顶上，而是明确报「还没有配置模型服务」。
 */
export function resolveChatConfig(
  database: AppDatabase,
  secrets: SecretStore,
  env: NodeJS.ProcessEnv
): ChatConfig | null {
  const active = readActiveChatProvider(database, { secrets, env })
  if (active !== null) {
    const descriptor = descriptorOfProvider(active.provider, active.model)
    if (descriptor === null) {
      // 库里存了本版不认识的协议：明确没有可用配置，不拿别的协议去发请求。
      return null
    }
    // 配置写着「用本机密钥」或「读环境变量」，但凭据确实拿不到：明确报「还没有配置」，
    // 不拿空密钥去撞服务端，也不换源。
    //
    // 内置目录添加的 provider 一定存过密钥：备份会把密文抹成 NULL，恢复后再发送
    // 必须当成缺失，而不是像本地 Ollama 那样允许无密钥。保留无密钥发送的只有
    // 迁移来的 custom/本地配置（本批没有自定义编辑器，将来由显式 auth_mode 表达）。
    const missingCredential =
      active.apiKey.trim() === '' &&
      (active.provider.authMode === 'env' ||
        active.provider.secretCiphertext !== null ||
        active.provider.source === 'builtin')
    return {
      apiKey: active.apiKey,
      // 模型行可以覆盖 provider 的地址（聚合网关按模型带地址）。
      baseUrl: descriptor.baseUrl,
      model: descriptor.model,
      providerId: active.provider.id,
      modelId: active.model.id,
      descriptor,
      ...(missingCredential ? { missingCredential: true } : {})
    }
  }
  if (isProviderSelectionCleared(database)) {
    return null
  }
  // 环境变量退路只留给「还没有任何 provider 行」的开发态与 E2E。
  // 有 provider 却一套都没启用时，设置页明说「现在没有使用中的提供商」，
  // 这里就不能静默拿环境变量里的另一套凭据顶上。
  if (readModelProviderRecords(database).length > 0) {
    return null
  }
  return readChatConfig(env)
}
