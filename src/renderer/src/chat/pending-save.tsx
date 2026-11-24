import type { PendingSave } from './store'

/**
 * 已生成但还没写进库的回答。只负责把捕获的内容和保存失败原因摆出来；
 * 重试走 store 的 retryPendingSave，不重新请求模型，也不会碰当前别的线程。
 */
export function PendingSaveNotice({
  pending,
  saving,
  savingThis,
  onRetry
}: {
  pending: PendingSave
  /** 全局保存串行时，任何可见的 pending 按钮都要反映忙态。 */
  saving: boolean
  savingThis: boolean
  onRetry: () => void
}) {
  return (
    <section className="pending-save" role="region" aria-label="尚未保存的回答">
      <div className="pending-save-head">
        <span className="pending-save-title">这条回答还没保存</span>
        <span className="pending-save-meta">
          {pending.retryable
            ? '内容留在本机内存；保存后才能继续这条对话。'
            : '内容只留在本窗口内存，可复制文本到新对话；无法再写回原位置。'}
        </span>
      </div>
      {pending.failure === null ? null : (
        <p className="pending-save-failure" role="status">
          {pending.failure}
        </p>
      )}
      {pending.displayText === '' ? null : (
        <div className="pending-save-text">{pending.displayText}</div>
      )}
      {pending.displayThinking === '' ? null : (
        <details className="pending-save-thinking">
          <summary>查看思考</summary>
          <div>{pending.displayThinking}</div>
        </details>
      )}
      {pending.retryable ? (
        <button
          type="button"
          className="button pending-save-retry"
          disabled={saving}
          onClick={onRetry}
        >
          {savingThis ? '正在保存…' : saving ? '正在保存另一条回答…' : '保存这条回答'}
        </button>
      ) : null}
    </section>
  )
}
