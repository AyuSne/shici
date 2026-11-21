import type { Provider } from '@earendil-works/pi-ai'

/**
 * pi 内置的 OpenCode GO 聚合 Provider。
 *
 * 产品明确要求直接复用这个对象：它自带 32 个模型与四条协议的 lazy 工厂，
 * 按 `model.api` 分派并带 OpenCode 会话头。这里不 `createProvider` 重建、
 * 不 spread / rename 一个对象来假装内置、也不自己写跨协议 switch。
 *
 * pi-ai 只发 ESM，主进程是 CJS，所以照旧动态 import；失败不缓存一个永远
 * reject 的 Promise，下一次发送仍可重试。
 */
let provider: Promise<Provider> | null = null

export function loadOpenCodeGoProvider(): Promise<Provider> {
  if (provider === null) {
    const pending = import('@earendil-works/pi-ai/providers/opencode-go').then(
      (module) => module.opencodeGoProvider()
    )
    provider = pending
    void pending.catch(() => {
      if (provider === pending) {
        provider = null
      }
    })
  }
  return provider
}
