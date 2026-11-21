import { describe, expect, it, vi } from 'vitest'
import {
  createOwnedProcessShutdown,
  type ShutdownChild,
  type ShutdownHooks
} from './process-shutdown'

/**
 * 测试基础设施的关闭流程：先有界地等应用自己退，超时后只对这条测试拉起的
 * 进程树做强制结束，并等它真的退出。替身进程不启动任何真实 Electron。
 */
class FakeChild implements ShutdownChild {
  exitCode: number | null = null
  readonly pid = 4_242
  readonly exitListeners = new Set<() => void>()
  readonly killSignals: Array<NodeJS.Signals | undefined> = []

  once(event: 'exit', listener: () => void): this {
    if (event === 'exit') {
      this.exitListeners.add(listener)
    }
    return this
  }

  removeListener(event: 'exit', listener: () => void): this {
    if (event === 'exit') {
      this.exitListeners.delete(listener)
    }
    return this
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal)
    return true
  }

  exit(): void {
    this.exitCode = 0
    for (const listener of [...this.exitListeners]) {
      listener()
    }
  }
}

function hooks(patch: Partial<ShutdownHooks> = {}): ShutdownHooks {
  return {
    graceful: () => new Promise<void>(() => undefined),
    gracefulTimeoutMs: 5,
    forceTimeoutMs: 50,
    ...patch
  }
}

describe('createOwnedProcessShutdown', () => {
  it('应用自己退出时不强制结束，并清掉 exit 监听', async () => {
    const child = new FakeChild()
    const forceKill = vi.fn()
    const shutdown = createOwnedProcessShutdown(
      child,
      hooks({
        graceful: async () => {
          child.exit()
        },
        forceKill
      })
    )

    await expect(shutdown.close()).resolves.toEqual({ forced: false })
    expect(forceKill).not.toHaveBeenCalled()
    expect(child.exitListeners.size).toBe(0)
  })

  it('优雅关闭挂起时有界超时，再只强制结束这个子进程并等它退出', async () => {
    const child = new FakeChild()
    const forceKill = vi.fn((target: ShutdownChild) => {
      expect(target.pid).toBe(child.pid)
      child.exit()
    })
    const shutdown = createOwnedProcessShutdown(child, hooks({ forceKill }))

    const started = Date.now()
    await expect(shutdown.close()).resolves.toEqual({ forced: true })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(forceKill).toHaveBeenCalledTimes(1)
    expect(child.exitListeners.size).toBe(0)
  })

  it('强制结束后仍不退出时明确报清理失败，不静默继续', async () => {
    const child = new FakeChild()
    const shutdown = createOwnedProcessShutdown(
      child,
      hooks({ forceKill: () => undefined, forceTimeoutMs: 5 })
    )

    await expect(shutdown.close()).rejects.toThrow(String(child.pid))
    expect(child.exitListeners.size).toBe(0)
  })

  it('进程在调用前已经退出：不再走优雅关闭或强制结束', async () => {
    const child = new FakeChild()
    child.exitCode = 1
    const graceful = vi.fn(async () => undefined)
    const forceKill = vi.fn()
    const shutdown = createOwnedProcessShutdown(child, hooks({ graceful, forceKill }))

    await expect(shutdown.close()).resolves.toEqual({ forced: false })
    expect(graceful).not.toHaveBeenCalled()
    expect(forceKill).not.toHaveBeenCalled()
  })

  it('并发 close/close、close/kill 共用同一段清理，不重复杀进程', async () => {
    const child = new FakeChild()
    const graceful = vi.fn(() => new Promise<void>(() => undefined))
    const forceKill = vi.fn(() => child.exit())
    const shutdown = createOwnedProcessShutdown(child, hooks({ graceful, forceKill }))

    const first = shutdown.close()
    const second = shutdown.close()
    const kill = shutdown.kill()
    expect(second).toBe(first)
    expect(kill).toBe(first)

    await expect(Promise.all([first, second, kill])).resolves.toEqual([
      { forced: true },
      { forced: true },
      { forced: true }
    ])
    expect(graceful).toHaveBeenCalledTimes(1)
    expect(forceKill).toHaveBeenCalledTimes(1)
  })

  it('kill() 保留真正的强制语义：不先等优雅关闭，直接结束进程树', async () => {
    const child = new FakeChild()
    const graceful = vi.fn(async () => undefined)
    const forceKill = vi.fn(() => child.exit())
    const shutdown = createOwnedProcessShutdown(child, hooks({ graceful, forceKill }))

    await expect(shutdown.kill()).resolves.toEqual({ forced: true })
    expect(graceful).not.toHaveBeenCalled()
    expect(forceKill).toHaveBeenCalledTimes(1)
  })
})
