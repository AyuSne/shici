import { failureText, GENERIC_FAILURE } from '../errors'

/**
 * 全软件统一的顶部 Toast。所有页面共用这一份状态与计时器：
 * 页面只调用 `showToast`，不在各自组件里再养一个 setTimeout。
 *
 * 语义（后续 #81 / #83 / #84 复用）：
 * - 默认停留 5000ms；同一时刻只显示一条，新 Toast 替换旧 Toast 并清掉旧计时器；
 * - `action` 点击后立即关闭并只执行一次；重复点击、过期后点击都是 no-op；
 * - `action.run` 的同步抛错与异步 rejection 都在这里捕获，换成一条可见的错误 Toast；
 * - 到期只清理，不执行 action。
 */

export const DEFAULT_TOAST_DURATION_MS = 5000

export type ToastTone = 'info' | 'error'

export type ToastAction = {
  /** 动作按钮文字，例如「撤销」「立即测试连接」。 */
  label: string
  run: () => void | Promise<void>
  /** 动作失败时给用户看的兜底文案；真实错误信息优先。 */
  failureMessage?: string
}

export type ToastOptions = {
  message: string
  tone?: ToastTone
  action?: ToastAction
  durationMs?: number
}

export type ToastState = {
  id: number
  message: string
  tone: ToastTone
  action: ToastAction | null
  durationMs: number
  /** 到期时刻，供进度条按真实剩余时间绘制；不参与业务判断。 */
  expiresAt: number
}

export type ToastActionOutcome = 'succeeded' | 'failed' | 'noop'

type ToastListener = (toast: ToastState | null) => void

export type ToastStore = {
  show(options: ToastOptions): ToastState | null
  dismiss(): void
  runAction(toastId?: number): Promise<ToastActionOutcome>
  getSnapshot(): ToastState | null
  subscribe(listener: ToastListener): () => void
}

export function createToastStore(options: { now?: () => number } = {}): ToastStore {
  const now = options.now ?? (() => Date.now())
  const listeners = new Set<ToastListener>()
  let current: ToastState | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let nextId = 1

  function notify(): void {
    for (const listener of listeners) {
      listener(current)
    }
  }

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  function show(toastOptions: ToastOptions): ToastState | null {
    const message = toastOptions.message.trim()
    if (message === '') {
      return null
    }
    clearTimer()
    const durationMs =
      typeof toastOptions.durationMs === 'number' && toastOptions.durationMs > 0
        ? toastOptions.durationMs
        : DEFAULT_TOAST_DURATION_MS
    const id = nextId
    nextId += 1
    const toast: ToastState = {
      id,
      message,
      tone: toastOptions.tone ?? 'info',
      action: toastOptions.action ?? null,
      durationMs,
      expiresAt: now() + durationMs
    }
    current = toast
    timer = setTimeout(() => {
      timer = null
      if (current?.id !== id) return
      current = null
      notify()
    }, durationMs)
    notify()
    return toast
  }

  function dismiss(): void {
    if (current === null) {
      clearTimer()
      return
    }
    clearTimer()
    current = null
    notify()
  }

  async function runAction(toastId?: number): Promise<ToastActionOutcome> {
    const toast = current
    if (toast === null || toast.action === null) {
      return 'noop'
    }
    if (toastId !== undefined && toast.id !== toastId) {
      return 'noop'
    }
    // 动作接口自己按当前时间判断期限：事件循环被挂起、计时器晚到时，
    // 过期动作也绝不能在五秒窗口之外偷偷改数据。
    if (now() >= toast.expiresAt) {
      dismiss()
      return 'noop'
    }
    const action = toast.action
    // 先关闭再执行：同一按钮的第二下、以及到期后的迟到点击都只会是 no-op。
    dismiss()
    try {
      await action.run()
      return 'succeeded'
    } catch (error) {
      show({
        message: failureText(error, action.failureMessage ?? GENERIC_FAILURE),
        tone: 'error'
      })
      return 'failed'
    }
  }

  function subscribe(listener: ToastListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  return {
    show,
    dismiss,
    runAction,
    getSnapshot: () => current,
    subscribe
  }
}

/** 应用里唯一的 Toast 状态；页面一律通过 `showToast` 使用它。 */
export const toastStore = createToastStore()

export function showToast(options: ToastOptions): ToastState | null {
  return toastStore.show(options)
}

/** 页面卸载或测试收尾时收起当前 Toast。 */
export function dismissToast(): void {
  toastStore.dismiss()
}
