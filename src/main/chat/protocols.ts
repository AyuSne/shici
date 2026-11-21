import type { ProviderStreams } from '@earendil-works/pi-ai'
import type { ModelProtocol } from '../../shared/model-catalog'

/**
 * 协议注册表：协议 ID 只在这里映射到 pi 的 lazy API 工厂。
 * 请求层按模型描述符里的 `api` 取实现，不把 DeepSeek/OpenAI Completions 写死；
 * 后续接入其他协议时只注册新工厂，聊天流与错误分类不用改。
 *
 * 工厂内部保持动态 import：pi-ai 只发 ESM，主进程是 CJS，静态 import 会在
 * 打包后变成 require 而失败。
 */
export type ProtocolApiFactory = () => Promise<ProviderStreams>

export const PROTOCOL_FACTORIES: Record<ModelProtocol, ProtocolApiFactory> = {
  'openai-completions': async () =>
    (await import('@earendil-works/pi-ai/api/openai-completions.lazy')).openAICompletionsApi(),
  'openai-responses': async () =>
    (await import('@earendil-works/pi-ai/api/openai-responses.lazy')).openAIResponsesApi(),
  'anthropic-messages': async () =>
    (await import('@earendil-works/pi-ai/api/anthropic-messages.lazy')).anthropicMessagesApi(),
  'google-generative-ai': async () =>
    (await import('@earendil-works/pi-ai/api/google-generative-ai.lazy')).googleGenerativeAIApi()
}

export async function loadProtocolApi(protocol: ModelProtocol): Promise<ProviderStreams> {
  const factory = (PROTOCOL_FACTORIES as Record<string, ProtocolApiFactory | undefined>)[
    String(protocol)
  ]
  if (factory === undefined) {
    throw new Error(`不支持的协议：${String(protocol)}`)
  }
  return factory()
}
