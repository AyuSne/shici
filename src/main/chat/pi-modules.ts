/**
 * pi-ai 只发 ESM（`exports` 没有 require 条件），而主进程产物是 CJS。
 * 所有入口都走这里的一次性动态 import，并让 `dynamicImportInCjs` 保持原样；
 * 加载失败不缓存一个永远 reject 的 Promise，下一次发送仍可重试。
 */
export type PiModules = {
  createModels: typeof import('@earendil-works/pi-ai').createModels
  createProvider: typeof import('@earendil-works/pi-ai').createProvider
  getSupportedThinkingLevels: typeof import('@earendil-works/pi-ai').getSupportedThinkingLevels
}

let modules: Promise<PiModules> | null = null

export function loadPi(): Promise<PiModules> {
  if (modules === null) {
    const pending = import('@earendil-works/pi-ai').then((pi) => ({
      createModels: pi.createModels,
      createProvider: pi.createProvider,
      getSupportedThinkingLevels: pi.getSupportedThinkingLevels
    }))
    modules = pending
    void pending.catch(() => {
      if (modules === pending) {
        modules = null
      }
    })
  }
  return modules
}
