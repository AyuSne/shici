/**
 * 显式的「测试连接」：设置页里的一个动作，按 provider 自己的协议发一次
 * 最小请求，只为确认这套地址、协议与密钥此刻能不能用，不生成学习内容。
 *
 * 保存与测试是分开的：保存零网络；测试是用户主动点的，失败也绝不改地址、
 * 协议或密钥，只把结果写回验证状态与最后错误。
 */

import type { ChatError } from './chat'
import type { ProviderCheckError } from './model-providers'

/** 一次最小请求的输出预算：够拿到一次往返，不生成正文。 */
export const PROVIDER_TEST_MAX_OUTPUT_TOKENS = 16

/** 测试连接的总超时：从开始调用计时，覆盖协议实现加载与整次请求。 */
export const PROVIDER_TEST_TIMEOUT_MS = 8_000

/** 探针正文：只用来触发一次最小请求，不承载任何学习内容。 */
export const PROVIDER_TEST_PROMPT = 'ping'

export type ProviderTestRequest = {
  providerId: string
}

/**
 * 测试没通过的原因。前三个沿用旧校验的三分类；其余是把真实 HTTP 状态与
 * 本地配置问题如实分开，界面据此给下一步动作，不混成一句「失败」。
 */
export type ProviderTestFailureReason = ProviderCheckError

export type ProviderTestFailure = {
  status: 'failed'
  /** 这次测试发生的时刻；无论是否写回都带着。 */
  checkedAt: string
  /**
   * false 表示测试期间配置被改动（换地址 / 换密钥 / 换默认模型 / 删目录行）：
   * 这次结果不再代表当前配置，主进程没有写回，请重新测试。
   */
  persisted: boolean
  reason: ProviderTestFailureReason
  /** 结构化错误：渲染层据 kind 给下一步，据 requestId 对服务端日志。 */
  error: ChatError
  /** 与 `error.requestId` 相同；显式给一份方便卡片直接展示。 */
  requestId?: string
}

export type ProviderTestResult =
  /** 这套 provider 已经不在了（可能在测试期间被删）。 */
  | { status: 'missing' }
  | {
      status: 'verified'
      checkedAt: string
      /** false 表示请求本身通过，但测试期间配置变了，没有写回已验证。 */
      persisted: boolean
      requestId?: string
    }
  | ProviderTestFailure
