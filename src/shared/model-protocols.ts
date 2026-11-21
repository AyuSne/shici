/**
 * 首版支持的四条协议：值与 pi-ai 的 api 名称一致。
 *
 * 这是协议 ID 的**唯一** TypeScript 来源（目录类型、provider 持久化类型、DB 读取
 * 守卫都用它）。生成脚本 `scripts/generate-model-catalog.mjs` 独立离线运行，保留
 * 自己的 JS 清单；两者的逐项一致性由 `model-catalog-generation.test.ts` 的
 * parity 回归锁住，不会静默漂移。
 *
 * 只放协议清单与守卫，不导入目录 JSON：主进程的 DB 读取只需要这份轻量契约。
 */
export const MODEL_PROTOCOLS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
] as const

export type ModelProtocol = (typeof MODEL_PROTOCOLS)[number]

/** 界面显示名也只留一份；设置页的协议下拉与卡片文案都读这里。 */
export const MODEL_PROTOCOL_LABELS: Record<ModelProtocol, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Gemini API'
}

/**
 * 自定义入口当前开放的协议。这不是第二份协议清单：下拉选项仍由
 * `MODEL_PROTOCOLS` 生成，这里只决定当前哪些选项可用。
 *
 * 批 3 同时打开 OpenAI Responses 与 Gemini API；其余协议由各自票据追加，最终取并集。
 */
export const OPEN_CUSTOM_PROTOCOLS: readonly ModelProtocol[] = [
  'openai-completions',
  'openai-responses',
  'google-generative-ai'
]

export function isCustomProviderProtocol(protocol: ModelProtocol): boolean {
  return OPEN_CUSTOM_PROTOCOLS.includes(protocol)
}

export function isModelProtocol(value: unknown): value is ModelProtocol {
  return (
    typeof value === 'string' &&
    (MODEL_PROTOCOLS as readonly string[]).includes(value)
  )
}
