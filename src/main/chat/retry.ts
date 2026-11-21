import type { ChatError, ChatStreamEvent, ProviderErrorCode } from '../../shared/chat'
import {
  DEFAULT_RETRY_POLICY,
  type ProviderRetryPolicy
} from '../../shared/model-providers'

/**
 * 自动重试执行层（#69）。
 *
 * 只包住「一次模型请求」：`pi-stream.ts` 仍是一次调用只发一次请求（maxRetries: 0），
 * 这里按 provider 的重试策略再决定是否重跑整次请求。四种协议共用这一层，
 * 协议差异全部留在下面的 `runAttempt` 里。
 *
 * 三条硬约束：
 * - 一旦有非空正文或思维链抵达，就不可逆地停止自动重试，已输出内容原样保留；
 * - 被放弃的尝试产生的错误不发给界面，只有最终失败才给一条真实错误；
 * - 停止/取消（包括正在退避时）立即收手，不再发请求，也不补错误事件。
 */

/** normal 的默认上限：初次请求之外最多再试 5 次。 */
export const MAX_RETRIES = 5

/** 第一次退避 500ms，之后每次翻倍，封顶 10s。 */
export const BASE_DELAY_MS = 500
export const MAX_DELAY_MS = 10_000

/** 抖动幅度 ±10%；`random()` 返回 0.5 时正好不加不减。 */
export const JITTER_RATIO = 0.1

/**
 * normal 只重试这些稳定分类。AUTH / QUOTA / CONTEXT_WINDOW / INVALID_REQUEST
 * 属于「重试也没用」，交给用户换密钥、充值或删上下文。
 */
const NORMAL_RETRYABLE: ReadonlySet<ProviderErrorCode> = new Set([
  'EMPTY_RESPONSE',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT'
])

/** 时间与随机数是系统边界：单测替换成确定性实现，生产用真实计时器。 */
export type RetryTiming = {
  /** 等待 `ms` 毫秒；期间被 signal 取消时返回 false。 */
  sleep: (ms: number, signal: AbortSignal) => Promise<boolean>
  random: () => number
}

export const REAL_RETRY_TIMING: RetryTiming = {
  sleep(ms, signal) {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(false)
        return
      }
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const onAbort = (): void => finish(false)
      const finish = (waited: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer !== undefined) {
          clearTimeout(timer)
        }
        signal.removeEventListener('abort', onAbort)
        resolve(waited)
      }
      timer = setTimeout(() => finish(true), Math.max(0, ms))
      signal.addEventListener('abort', onAbort, { once: true })
    })
  },
  random: Math.random
}

export type RetryRunOptions = {
  /** provider 的持久化策略；缺省按 normal。 */
  policy?: ProviderRetryPolicy
  signal: AbortSignal
  /** 只把要展示给界面的事件发出去：正文/思维链即时转发，错误等最终决定。 */
  send: (event: ChatStreamEvent) => void
  /** 真正跑一次请求；事件通过传入的 onEvent 回来。 */
  runAttempt: (onEvent: (event: ChatStreamEvent) => void) => Promise<void>
  timing?: RetryTiming
}

/**
 * 跑一次模型请求并按其策略重试，直到成功、耗尽、遇到不可重试错误或取消。
 *
 * `runAttempt` 必须像 `streamChatCompletion` 一样以 done 或 error 收尾；
 * 没有终态事件也没有取消时，这里不伪造错误，直接结束（避免重复回答）。
 */
export async function runWithRetry(options: RetryRunOptions): Promise<void> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY
  const timing = options.timing ?? REAL_RETRY_TIMING
  let retries = 0
  let committed = false

  while (true) {
    if (options.signal.aborted) {
      return
    }

    let terminal: { type: 'done' } | { type: 'error'; error: ChatError } | undefined
    await options.runAttempt((event) => {
      if (terminal !== undefined) {
        // 终态之后的事件一律丢弃：一次尝试只认第一个终态。
        return
      }
      switch (event.type) {
        case 'thinking':
        case 'text':
          if (event.text === '') {
            return
          }
          // 不可逆：从这一个片段起，这次请求不再自动重试。
          committed = true
          options.send(event)
          return
        case 'done':
          terminal = event
          return
        case 'error':
          terminal = event
          return
      }
    })

    if (options.signal.aborted) {
      return
    }

    if (terminal === undefined) {
      // 低层流要么 done 要么 error，取消则已被上面的 signal 分支收走。
      return
    }

    if (terminal.type === 'done') {
      options.send(terminal)
      return
    }

    const error = terminal.error
    if (committed) {
      // 已经给用户看过正文/思维链：保留内容，把真实错误作为最终错误发出。
      options.send(terminal)
      return
    }

    if (
      retries >= MAX_RETRIES ||
      !shouldRetry(policy, error) ||
      options.signal.aborted
    ) {
      options.send(terminal)
      return
    }

    const delay = retryDelayMs(retries, error.retryAfterMs, timing.random)
    if (delay === null) {
      // Retry-After 比最大退避还长：不自动等待，直接把原错误交给用户。
      options.send(terminal)
      return
    }

    retries += 1
    const waited = await timing.sleep(delay, options.signal)
    if (!waited || options.signal.aborted) {
      return
    }
  }
}

/**
 * 这一次失败值不值得再试。normal 只认固定五个临时分类；always 重试所有
 * 「模型请求确实发出去并失败了」的情况，但不重试本地失败（UNKNOWN 表示
 * 请求没发出去，例如协议实现加载失败，与本地配置预检同属不该重试的一类）。
 */
export function shouldRetry(
  policy: ProviderRetryPolicy,
  error: ChatError
): boolean {
  if (error.code === 'not-configured') {
    return false
  }
  if (policy.mode === 'normal') {
    return error.kind !== undefined && NORMAL_RETRYABLE.has(error.kind)
  }
  return error.kind !== 'UNKNOWN'
}

/**
 * 第 `retryIndex` 次退避（从 0 开始）：500ms → 1s → 2s → 4s → 8s，抖动 ±10%。
 * `Retry-After` 是下限，绝不提前；超过最大退避（10s）返回 null，表示放弃重试。
 */
export function retryDelayMs(
  retryIndex: number,
  retryAfterMs: number | undefined,
  random: () => number = Math.random
): number | null {
  if (retryAfterMs !== undefined && retryAfterMs > MAX_DELAY_MS) {
    return null
  }
  const base = Math.min(BASE_DELAY_MS * 2 ** retryIndex, MAX_DELAY_MS)
  const jitter = 1 + (random() * 2 - 1) * JITTER_RATIO
  const backoff = Math.max(0, Math.round(base * jitter))
  return retryAfterMs === undefined ? backoff : Math.max(backoff, retryAfterMs)
}
