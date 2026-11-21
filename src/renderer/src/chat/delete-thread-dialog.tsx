import { useEffect, useRef, useState } from 'react'
import { failureText } from '../errors'
import { removeChatThread } from './store'

export function DeleteThreadDialog({
  thread, canDelete, busy, onClose, onDeleted
}: {
  thread: { id: string; title: string }
  canDelete: boolean
  busy: boolean
  onClose: () => void
  onDeleted: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const element = dialog.current
    element?.showModal()
    return () => element?.close()
  }, [])

  async function confirm(): Promise<void> {
    setError(null)
    try {
      if (await removeChatThread(thread.id)) onDeleted()
      else setError('这条对话还在生成或保存，请稍后再删除。')
    } catch (cause) {
      setError(failureText(cause, '没能删除对话，请再试一次。'))
    }
  }

  return (
    <dialog
      ref={dialog}
      className="thread-delete-dialog"
      aria-label="删除对话"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2>删除对话</h2>
      <p>确定删除「{thread.title}」及全部消息？此操作不可撤销，已钉住的内容仍会保留。</p>
      {error && <p role="alert">{error}</p>}
      <div className="thread-delete-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="button thread-delete-danger" disabled={!canDelete} onClick={() => void confirm()}>
          {busy ? '正在删除…' : '删除对话'}
        </button>
      </div>
    </dialog>
  )
}
