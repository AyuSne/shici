/**
 * 选中 AI 回复片段后浮在选区正上方的轻胶囊：钉住 / 追问 / 复制。
 * 只负责呈现与定位，不拥有对话或钉住状态；#82 的轻问抽屉可复用同一组件。
 */
export type SelectionCapsuleAnchor = {
  top: number
  left: number
  width: number
}

export function SelectionCapsule({
  anchor,
  onPin,
  onFollowUp,
  onCopy,
  busy = false
}: {
  /** 选区在视口里的矩形（getBoundingClientRect）。 */
  anchor: SelectionCapsuleAnchor
  onPin: () => void
  onFollowUp: () => void
  onCopy: () => void
  busy?: boolean
}) {
  const half = 132
  const viewport = typeof window === 'undefined' ? 1280 : window.innerWidth
  const left = Math.min(
    Math.max(anchor.left + anchor.width / 2, half + 8),
    Math.max(half + 8, viewport - half - 8)
  )
  return (
    <div
      className="selection-capsule"
      data-placement="above"
      style={{ left, top: anchor.top - 8 }}
      role="toolbar"
      aria-label="选中片段操作"
    >
      <button type="button" className="selection-capsule-action" disabled={busy} onClick={onPin}>
        钉住
      </button>
      <button
        type="button"
        className="selection-capsule-action"
        disabled={busy}
        onClick={onFollowUp}
      >
        追问
      </button>
      <button type="button" className="selection-capsule-action" onClick={onCopy}>
        复制
      </button>
    </div>
  )
}
