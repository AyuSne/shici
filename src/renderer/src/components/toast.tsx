import { useSyncExternalStore, type CSSProperties } from 'react'
import { toastStore } from './toast-store'

/**
 * 顶部 Toast 的唯一挂载点。状态与 5 秒计时器都在 toast-store 里，
 * 页面只调用 `showToast`；这里负责画在标题栏下方居中，并给动作按钮。
 */
export function ToastHost() {
  const toast = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot)
  if (toast === null) {
    return null
  }

  return (
    <div
      key={toast.id}
      className={`toast toast-top${toast.tone === 'error' ? ' toast-error' : ''}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      data-toast-id={String(toast.id)}
      style={{ '--toast-duration': `${toast.durationMs}ms` } as CSSProperties}
    >
      <span className="toast-message">{toast.message}</span>
      {toast.action === null ? null : (
        <button
          type="button"
          className="toast-undo"
          onClick={() => {
            void toastStore.runAction(toast.id)
          }}
        >
          {toast.action.label}
        </button>
      )}
      <span className="toast-progress" aria-hidden="true" />
    </div>
  )
}
