import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TOAST_DURATION_MS,
  createToastStore,
  type ToastState
} from './toast-store'

/**
 * 顶部 Toast 的公共行为：5 秒倒计时、替换即清旧计时器、动作只执行一次、
 * 动作失败要有可见反馈且不能留下未处理的 Promise。
 * 这里只测 store 的公开接口；组件只负责把这份状态画在顶部安全区。
 */

let store: ReturnType<typeof createToastStore>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-24T10:00:00.000Z'))
  store = createToastStore()
})

afterEach(() => {
  vi.useRealTimers()
})

function snapshot(): ToastState | null {
  return store.getSnapshot()
}

describe('顶部 Toast store', () => {
  it('默认停留 5 秒，到期自动清理并通知订阅者', () => {
    const seen: Array<ToastState | null> = []
    const unsubscribe = store.subscribe((toast) => seen.push(toast))

    const toast = store.show({ message: '已拾下「approach」' })
    expect(toast?.durationMs).toBe(DEFAULT_TOAST_DURATION_MS)
    expect(toast?.expiresAt).toBe(Date.now() + 5000)
    expect(snapshot()?.message).toBe('已拾下「approach」')

    vi.advanceTimersByTime(4999)
    expect(snapshot()).not.toBeNull()

    vi.advanceTimersByTime(1)
    expect(snapshot()).toBeNull()
    expect(seen.at(-1)).toBeNull()
    unsubscribe()
  })

  it('新 Toast 替换旧的并清掉旧计时器，旧到期时间不会误清新 Toast', () => {
    store.show({ message: '第一条', durationMs: 3000 })
    vi.advanceTimersByTime(1000)
    store.show({ message: '第二条', durationMs: 5000 })

    // 旧计时器原本会在 3000ms 时触发，现在不能把第二条清掉。
    vi.advanceTimersByTime(2000)
    expect(snapshot()?.message).toBe('第二条')

    vi.advanceTimersByTime(3000)
    expect(snapshot()).toBeNull()
  })

  it('动作点击只执行一次并立即关闭，重复点击是 no-op', async () => {
    const run = vi.fn()
    const toast = store.show({ message: '已丢弃', action: { label: '撤销', run } })
    if (toast === null) throw new Error('Toast 没有出现')

    await expect(store.runAction(toast.id)).resolves.toBe('succeeded')
    expect(run).toHaveBeenCalledTimes(1)
    expect(snapshot()).toBeNull()

    await expect(store.runAction(toast.id)).resolves.toBe('noop')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('动作异步失败被捕获，换成可见的错误 Toast，且没有未处理 rejection', async () => {
    const run = vi.fn(async () => {
      throw new Error('撤销没有完成')
    })
    const toast = store.show({
      message: '已丢弃',
      action: { label: '撤销', run }
    })
    if (toast === null) throw new Error('Toast 没有出现')

    await expect(store.runAction(toast.id)).resolves.toBe('failed')
    expect(snapshot()).toMatchObject({
      message: '撤销没有完成',
      tone: 'error'
    })
    expect(snapshot()?.action).toBeNull()
  })

  it('到期后动作不再执行；手动关闭也清掉计时器', async () => {
    const run = vi.fn()
    const toast = store.show({ message: '已保存', action: { label: '撤销', run } })
    if (toast === null) throw new Error('Toast 没有出现')

    vi.advanceTimersByTime(5000)
    expect(snapshot()).toBeNull()
    await expect(store.runAction(toast.id)).resolves.toBe('noop')
    expect(run).not.toHaveBeenCalled()

    store.show({ message: '再一条' })
    store.dismiss()
    expect(snapshot()).toBeNull()
    vi.advanceTimersByTime(5000)
    expect(snapshot()).toBeNull()
  })

  it('动作接口自己按公开时钟判断过期：计时器没触发，到点后也不能执行', async () => {
    let clock = 1_000_000
    const manual = createToastStore({ now: () => clock })
    const run = vi.fn()
    const toast = manual.show({
      message: '已删除',
      durationMs: 5000,
      action: { label: '撤销', run }
    })
    if (toast === null) throw new Error('Toast 没有出现')

    clock += 5000
    await expect(manual.runAction(toast.id)).resolves.toBe('noop')
    expect(run).not.toHaveBeenCalled()
    expect(manual.getSnapshot()).toBeNull()

    clock += 1
    await expect(manual.runAction(toast.id)).resolves.toBe('noop')
    expect(run).not.toHaveBeenCalled()
  })

  it('到期前动作照常只执行一次', async () => {
    let clock = 2_000_000
    const manual = createToastStore({ now: () => clock })
    const run = vi.fn()
    const toast = manual.show({
      message: '已删除',
      durationMs: 5000,
      action: { label: '撤销', run }
    })
    if (toast === null) throw new Error('Toast 没有出现')

    clock += 4999
    await expect(manual.runAction(toast.id)).resolves.toBe('succeeded')
    expect(run).toHaveBeenCalledTimes(1)
    await expect(manual.runAction(toast.id)).resolves.toBe('noop')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('空消息不创建 Toast；错误态保留 tone 供读屏区分', () => {
    expect(store.show({ message: '   ' })).toBeNull()
    expect(snapshot()).toBeNull()

    const toast = store.show({ message: '保存失败', tone: 'error' })
    expect(toast?.tone).toBe('error')
    expect(snapshot()?.tone).toBe('error')
  })
})
