import { spawnSync } from 'node:child_process'

/**
 * 只清理「这条测试自己拉起的应用进程」。
 *
 * 先有界地等应用优雅退出；超时后只对它的进程树做强制结束（Windows 上
 * taskkill /pid <pid> /T /F），并等到子进程真的退出。绝不按进程名批量杀
 * electron/node，也不动本机其它 Electron 程序。
 *
 * e2e fixture 的 close()/kill() 共用这里：close 走优雅关闭，kill 保留
 * 「断电」语义直接强制结束。同一个子进程的并发调用只执行一次清理。
 */

export type ShutdownChild = {
  readonly pid?: number
  readonly exitCode: number | null
  once(event: 'exit', listener: () => void): unknown
  removeListener(event: 'exit', listener: () => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

export type ShutdownHooks = {
  /** 请求应用自己退出；可以抛错。 */
  graceful: () => Promise<void>
  /** 强制结束这个子进程及其进程树；默认 Windows taskkill /T /F。 */
  forceKill?: (child: ShutdownChild) => void
  /** 最多等多久让应用优雅退出。 */
  gracefulTimeoutMs?: number
  /** 强制结束后最多等多久让它真的退出。 */
  forceTimeoutMs?: number
  /** 测试注入；返回是否在超时前观察到退出。 */
  waitForExit?: (child: ShutdownChild, timeoutMs: number) => Promise<boolean>
}

export type ShutdownOutcome = {
  /** true 表示走了强制结束；false 表示应用自己退出了。 */
  forced: boolean
}

export type OwnedProcessShutdown = {
  close(): Promise<ShutdownOutcome>
  kill(): Promise<ShutdownOutcome>
}

export const DEFAULT_GRACEFUL_TIMEOUT_MS = 10_000
export const DEFAULT_FORCE_TIMEOUT_MS = 10_000

/** 同一个子进程的清理只跑一次；close()/kill() 与并发重复调用都安全。 */
export function createOwnedProcessShutdown(
  child: ShutdownChild,
  hooks: ShutdownHooks
): OwnedProcessShutdown {
  let pending: Promise<ShutdownOutcome> | null = null

  function start(force: boolean): Promise<ShutdownOutcome> {
    if (pending === null) {
      pending = force ? forceShutdown(child, hooks) : gracefulThenForce(child, hooks)
      // 调用方仍会 await；这里挂一个 catch 避免并发调用时出现未处理拒绝。
      pending.catch(() => undefined)
    }
    return pending
  }

  return {
    close: () => start(false),
    kill: () => start(true)
  }
}

async function gracefulThenForce(
  child: ShutdownChild,
  hooks: ShutdownHooks
): Promise<ShutdownOutcome> {
  if (child.exitCode !== null) {
    return { forced: false }
  }

  // 优雅关闭可能永远不 settle；不能等它，等的是「子进程真的退出」。
  Promise.resolve()
    .then(() => hooks.graceful())
    .catch(() => undefined)

  const exited = await waitForExitOf(
    child,
    hooks,
    hooks.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS
  )
  if (exited) {
    return { forced: false }
  }
  return forceShutdown(child, hooks)
}

async function forceShutdown(
  child: ShutdownChild,
  hooks: ShutdownHooks
): Promise<ShutdownOutcome> {
  if (child.exitCode !== null) {
    return { forced: false }
  }
  const forceKill = hooks.forceKill ?? taskkillOwnedTree
  forceKill(child)
  const exited = await waitForExitOf(
    child,
    hooks,
    hooks.forceTimeoutMs ?? DEFAULT_FORCE_TIMEOUT_MS
  )
  if (!exited && child.exitCode === null) {
    throw new Error(
      `被测应用的子进程（pid ${child.pid ?? '未知'}）在强制结束后仍未退出；` +
        '请检查是否有残留进程，不要用全局杀进程的方式掩盖它。'
    )
  }
  return { forced: true }
}

function waitForExitOf(
  child: ShutdownChild,
  hooks: ShutdownHooks,
  timeoutMs: number
): Promise<boolean> {
  const wait = hooks.waitForExit ?? waitForChildExit
  return wait(child, timeoutMs)
}

/** 等子进程退出；超时返回 false，且一定清掉计时器与监听。 */
export function waitForChildExit(
  child: ShutdownChild,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer !== undefined) {
        clearTimeout(timer)
      }
      child.removeListener('exit', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    timer = setTimeout(() => finish(child.exitCode !== null), timeoutMs)
    timer.unref()
    child.once('exit', onExit)
  })
}

function taskkillOwnedTree(child: ShutdownChild): void {
  if (child.pid === undefined) {
    throw new Error('拿不到被测应用的进程 id，不能确认要清理的是哪个子进程')
  }
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore'
    })
    if (result.error !== undefined) {
      throw result.error
    }
  } else {
    child.kill('SIGKILL')
  }
}
