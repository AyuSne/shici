import type { AppDatabase } from '../db/database'
import type { ChatCredentialProblem } from '../../shared/chat'
import type { ProviderRetryPolicy } from '../../shared/model-providers'
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
  /**
   * 解析这份配置时 provider 行的 `updated_at`：回写验证状态 / 最后错误时用它
   * 判断配置有没有在调用期间被改过，避免旧结果误写新配置。
   */
  providerUpdatedAt?: string
  /** 这次调用冻结的描述符：协议、地址、容量与思考元数据都在这里。 */
  descriptor: ChatModelDescriptor
  /**
   * 这次调用冻结的重试策略：切换 provider 只影响之后的调用，正在跑的流
   * 始终按启动时的策略重试。环境变量退路没有 provider 行，按 normal。
   */
  retryPolicy?: ProviderRetryPolicy
  /**
   * 配置写着「用本机密钥」或「读环境变量」，但凭据确实拿不到：
   * 发送前就明确报配置错误，不拿空密钥去撞服务端，也不换源。
   */
  missingCredential?: boolean
  /** 缺失的具体原因：环境模式点名变量，本机模式明说解不开。 */
  credentialProblem?: ChatCredentialProblem
}

/** 给日志与排障用的说明；界面文案另从结构化原因生成。 */
export function credentialProblemDetail(
  problem: ChatCredentialProblem | undefined
): string {
  if (problem === undefined) {
    return '本机密钥缺失或解不开'
  }
  switch (problem.kind) {
    case 'stored-decrypt-failed':
      return '本机保存的密钥解不开'
    case 'stored-missing':
      return '这套提供商没有保存密钥'
    case 'env-missing':
      return `环境变量 ${problem.envVar} 没有设置`
    case 'env-var-unset':
      return '环境模式没有填写环境变量名'
  }
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
    // 三态是严格的：配置写着「用本机密钥」或「读环境变量」，但凭据确实拿不到，
    // 就明确报配置错误，不拿空密钥去撞服务端，也不换源。
    //
    // 自定义 provider 也不例外：保存时可以先把空密钥存成「缺失」草稿，
    // 但发送前必须补上；从本机清除密钥或备份恢复后同样是缺失，绝不匿名发送。
    const credentialProblem =
      active.credential.state === 'missing' ? active.credential.problem : undefined
    return {
      apiKey: active.credential.state === 'missing' ? '' : active.credential.apiKey,
      // 模型行可以覆盖 provider 的地址（聚合网关按模型带地址）。
      baseUrl: descriptor.baseUrl,
      model: descriptor.model,
      providerId: active.provider.id,
      modelId: active.model.id,
      providerUpdatedAt: active.provider.updatedAt,
      descriptor,
      retryPolicy: active.provider.retryPolicy,
      ...(credentialProblem === undefined
        ? {}
        : { missingCredential: true, credentialProblem })
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
