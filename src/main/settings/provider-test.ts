import type { ChatError } from '../../shared/chat'
import type { ProviderCheckError } from '../../shared/model-providers'
import {
  PROVIDER_TEST_MAX_OUTPUT_TOKENS,
  PROVIDER_TEST_PROMPT,
  PROVIDER_TEST_TIMEOUT_MS,
  type ProviderTestRequest,
  type ProviderTestResult
} from '../../shared/provider-test'
import { credentialProblemDetail } from '../chat/config'
import { descriptorOfProvider, type ChatModelDescriptor } from '../chat/model-descriptor'
import { streamChatCompletion } from '../chat/pi-stream'
import type { AppDatabase } from '../db/database'
import { resolveProviderCredential } from './credentials'
import {
  markProviderCheckPassed,
  readDefaultModel,
  readModelProvider,
  recordProviderFailure,
  type ModelProviderRecord,
  type ProviderCheckFailure
} from './providers'
import type { SecretStore } from './secret-store'

/**
 * 显式「测试连接」的主进程实现。
 *
 * 与聊天共用同一条最小请求路径（`streamChatCompletion`），因此四种协议、
 * OpenCode GO 的按模型分派、密钥三态与错误分类都与真实对话一致；但它不经过
 * 对话服务、不经过重试执行器，也不会写入任何学习内容。
 *
 * 三条硬约束：
 * 1. 一次只发一次请求，总超时 8 秒，从调用开始计时（含协议实现加载）；
 * 2. 输出预算很小且不传思考参数；收到第一段正文/思维链就主动停止，不再为
 *    测试连接消耗额度；
 * 3. 结果只写验证状态与最后错误。失败绝不动地址、协议、密钥或默认模型；
 *    测试期间配置被改过（`updated_at` 变了）则整次结果不写回。
 */

export type ProviderTestOptions = {
  /** 测试注入较短超时；生产固定 8 秒。 */
  timeoutMs?: number
  /** 测试注入时钟；生产用真实时间。 */
  now?: () => Date
}

export async function testProviderConnection(
  database: AppDatabase,
  secrets: SecretStore,
  env: NodeJS.ProcessEnv,
  request: ProviderTestRequest,
  options: ProviderTestOptions = {}
): Promise<ProviderTestResult> {
  const provider = readModelProvider(database, request.providerId)
  if (provider === null) {
    return { status: 'missing' }
  }

  const checkedAt = (options.now?.() ?? new Date()).toISOString()
  // 冻结这次测试对应的配置版本：测试期间任何配置写入都会推进 updated_at，
  // 回写时据此判断结果是否还代表当前配置。
  const expectedUpdatedAt = provider.updatedAt

  const model = readDefaultModel(database, provider)
  if (model === null) {
    return fail(database, provider, expectedUpdatedAt, checkedAt, 'no-model', {
      code: 'unknown',
      kind: 'UNKNOWN',
      detail: '这套提供商没有可用的模型；先加一条模型再测试连接。'
    })
  }
  const descriptor = descriptorOfProvider(provider, model)
  if (descriptor === null) {
    return fail(database, provider, expectedUpdatedAt, checkedAt, 'unsupported-protocol', {
      code: 'unknown',
      kind: 'UNKNOWN',
      detail: '这套提供商保存的协议本版不认识；测试连接不会猜成另一种协议。'
    })
  }

  const credential = resolveProviderCredential(provider, { secrets, env })
  if (credential.state === 'missing') {
    return fail(database, provider, expectedUpdatedAt, checkedAt, 'missing-credential', {
      code: 'not-configured',
      detail: credentialProblemDetail(credential.problem),
      credential: credential.problem
    })
  }

  const probe = await runProbe(
    descriptor,
    credential.apiKey,
    options.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS
  )

  if (probe.outcome === 'timeout') {
    return fail(database, provider, expectedUpdatedAt, checkedAt, 'timeout', {
      code: 'network',
      kind: 'TIMEOUT',
      detail: `测试连接在 ${options.timeoutMs ?? PROVIDER_TEST_TIMEOUT_MS} 毫秒内没有完成。`
    })
  }
  if (probe.outcome === 'failed') {
    return fail(
      database,
      provider,
      expectedUpdatedAt,
      checkedAt,
      reasonOf(probe.error),
      probe.error
    )
  }

  const written = markProviderCheckPassed(
    database,
    provider.id,
    checkedAt,
    expectedUpdatedAt
  )
  if (written === 'missing') {
    return { status: 'missing' }
  }
  return { status: 'verified', checkedAt, persisted: written === 'recorded' }
}

type ProbeOutcome =
  | { outcome: 'verified' }
  | { outcome: 'timeout' }
  | { outcome: 'failed'; error: ChatError }

/**
 * 一次最小请求的收口。计时从函数进入开始，覆盖 pi 动态加载与整次请求；
 * 收到第一段正文 / 思维链或 done 都算一次成功的往返，随即中止以省额度。
 */
async function runProbe(
  descriptor: ChatModelDescriptor,
  apiKey: string,
  timeoutMs: number
): Promise<ProbeOutcome> {
  const controller = new AbortController()
  let settled = false
  let timedOut = false
  let result: ProbeOutcome | null = null
  let finish!: () => void
  const settledPromise = new Promise<void>((resolve) => {
    finish = resolve
  })

  const complete = (outcome: ProbeOutcome): void => {
    if (settled) {
      return
    }
    settled = true
    result = outcome
    finish()
  }

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
    complete({ outcome: 'timeout' })
  }, timeoutMs)

  const running = streamChatCompletion({
    apiKey,
    descriptor,
    messages: [{ role: 'user', content: PROVIDER_TEST_PROMPT }],
    signal: controller.signal,
    probe: { maxOutputTokens: PROVIDER_TEST_MAX_OUTPUT_TOKENS },
    onEvent: (event) => {
      if (settled) {
        return
      }
      if (event.type === 'done') {
        complete({ outcome: 'verified' })
        return
      }
      if (event.type === 'error') {
        complete({ outcome: 'failed', error: event.error })
        return
      }
      // 已经收到正文或思维链：协议往返成功，立刻停下，不再生成。
      controller.abort()
      complete({ outcome: 'verified' })
    }
  }).catch((): void => {
    // streamChatCompletion 正常不会抛；真抛了也不留未处理的 rejection。
    complete({
      outcome: 'failed',
      error: { code: 'unknown', kind: 'UNKNOWN', detail: '测试连接没有完成' }
    })
  })

  await settledPromise
  clearTimeout(timer)
  // 超时后不等待底层请求收尾（它已被 abort），但要把最终 rejection 吃掉。
  void running

  if (timedOut) {
    return { outcome: 'timeout' }
  }
  return result ?? { outcome: 'timeout' }
}

function fail(
  database: AppDatabase,
  provider: ModelProviderRecord,
  expectedUpdatedAt: string,
  checkedAt: string,
  reason: ProviderCheckError,
  error: ChatError
): ProviderTestResult {
  const failure: ProviderCheckFailure = {
    reason,
    ...(error.requestId === undefined ? {} : { requestId: error.requestId })
  }
  const written = recordProviderFailure(database, provider.id, failure, {
    now: checkedAt,
    expectedUpdatedAt,
    // 显式测试没通过就收回「已验证」：这是用户主动问「现在还能用吗」，
    // 没通过就不该继续显示已验证。真实对话失败不降级，见 providers.ts。
    revokeVerified: true
  })
  if (written === 'missing') {
    return { status: 'missing' }
  }
  return {
    status: 'failed',
    checkedAt,
    persisted: written === 'recorded',
    reason,
    error,
    ...(error.requestId === undefined ? {} : { requestId: error.requestId })
  }
}

/** 请求层错误 → 落库 / 展示的分类；只认结构化分类，不读报文案。 */
function reasonOf(error: ChatError): ProviderCheckError {
  switch (error.kind) {
    case 'AUTH':
      return 'invalid-key'
    case 'INVALID_REQUEST':
    case 'CONTEXT_WINDOW':
      return 'invalid-config'
    case 'QUOTA':
      return 'quota'
    case 'RATE_LIMIT':
      return 'rate-limit'
    case 'SERVER':
      return 'server'
    case 'TIMEOUT':
      return 'timeout'
    case 'TRANSPORT':
      return 'network'
    case 'EMPTY_RESPONSE':
      return 'empty-response'
    default:
      break
  }
  switch (error.code) {
    case 'invalid-key':
      return 'invalid-key'
    case 'context-too-long':
      return 'invalid-config'
    case 'insufficient-balance':
      return 'quota'
    case 'rate-limited':
      return 'rate-limit'
    case 'server-busy':
      return 'server'
    case 'network':
      return 'network'
    case 'empty-response':
      return 'empty-response'
    default:
      return 'unknown'
  }
}
