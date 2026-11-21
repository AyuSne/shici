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

export function isModelProtocol(value: unknown): value is ModelProtocol {
  return (
    typeof value === 'string' &&
    (MODEL_PROTOCOLS as readonly string[]).includes(value)
  )
}
