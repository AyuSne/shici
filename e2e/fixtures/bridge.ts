import type { ElectronApplication, Page } from '@playwright/test'
import type { IpcChannel } from '../../src/shared/ipc-contract'
import type { AppBootstrap } from '../../src/shared/types'

export type BridgeSurface = {
  hasInvoke: boolean
  hasRequire: boolean
  hasIpcRenderer: boolean
}

/**
 * 渲染层能碰到的全局对象：只该有 bridge，没有 Node 的 require 与 ipcRenderer。
 */
export function readBridgeSurface(page: Page): Promise<BridgeSurface> {
  return page.evaluate(() => {
    const candidate = window as unknown as {
      api?: { invoke?: unknown }
      require?: unknown
      ipcRenderer?: unknown
    }
    return {
      hasInvoke: typeof candidate.api?.invoke === 'function',
      hasRequire: typeof candidate.require === 'function',
      hasIpcRenderer: typeof candidate.ipcRenderer !== 'undefined'
    }
  })
}

export function readBootstrap(page: Page): Promise<AppBootstrap> {
  return page.evaluate(() => {
    const candidate = window as unknown as {
      api: { invoke(channel: string): Promise<AppBootstrap> }
    }
    return candidate.api.invoke('app:bootstrap')
  })
}

/** Hold the next real IPC reply, after the registered handler has taken its snapshot. */
export async function holdIpcReply(app: ElectronApplication, channel: IpcChannel) {
  const releaseKey = `__e2eRelease:${channel}`
  await app.evaluate(({ ipcMain }, { channel, releaseKey }) => {
    type Handler = Parameters<typeof ipcMain.handle>[1]
    const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get(channel)
    if (!original) throw new Error(`没有注册 ${channel}`)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (...args) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, original)
      const result = await original(...args)
      const globals = globalThis as Record<string, unknown>
      await new Promise<void>((resolve) => { globals[releaseKey] = resolve })
      return result
    })
  }, { channel, releaseKey })
  return {
    pending: () => app.evaluate((_electron, key) => key in globalThis, releaseKey),
    release: () => app.evaluate((_electron, key) => {
      const globals = globalThis as Record<string, unknown>
      const release = globals[key]
      if (typeof release !== 'function') throw new Error(`还没有待释放的 ${key}`)
      delete globals[key]
      release()
    }, releaseKey)
  }
}

/**
 * Hold the next real IPC call before its handler runs. The test can then change
 * server-side data (delete the article) so the held call observes the newer state.
 */
export async function holdIpcCall(app: ElectronApplication, channel: IpcChannel) {
  const releaseKey = `__e2eCall:${channel}`
  await app.evaluate(({ ipcMain }, { channel, releaseKey }) => {
    type Handler = Parameters<typeof ipcMain.handle>[1]
    const handlers = (ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, Handler> })._invokeHandlers
    const original = handlers.get(channel)
    if (!original) throw new Error(`没有注册 ${channel}`)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (...args) => {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, original)
      const globals = globalThis as Record<string, unknown>
      await new Promise<void>((resolve) => { globals[releaseKey] = resolve })
      return original(...args)
    })
  }, { channel, releaseKey })
  return {
    pending: () => app.evaluate((_electron, key) => key in globalThis, releaseKey),
    release: () => app.evaluate((_electron, key) => {
      const globals = globalThis as Record<string, unknown>
      const release = globals[key]
      if (typeof release !== 'function') throw new Error(`还没有待释放的 ${key}`)
      delete globals[key]
      release()
    }, releaseKey)
  }
}

export function callUnknownChannel(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const candidate = window as unknown as {
      api: { invoke(channel: string): Promise<unknown> }
    }
    try {
      await candidate.api.invoke('app:not-in-contract')
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
}

/**
 * 让某个真实 IPC 通道在这一次调用里失败：用于验证界面失败时不变脏、不做乐观更新。
 * 只替换这一条通道，其余处理函数与真实服务不动；用例进程结束即恢复。
 */
export async function failIpcReply(
  app: ElectronApplication,
  channel: IpcChannel,
  message = 'e2e 模拟失败'
): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel: target, message: text }) => {
    ipcMain.removeHandler(target)
    ipcMain.handle(target, () => {
      throw new Error(text)
    })
  }, { channel, message })
}
