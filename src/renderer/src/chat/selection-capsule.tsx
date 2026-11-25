import { useLayoutEffect, useRef, useState } from 'react'

/**
 * 选中 AI 回复片段后浮在选区正上方的轻胶囊：钉住 / 追问 / 复制。
 * 只负责呈现与定位，不拥有对话或钉住状态；#82 的轻问抽屉可复用同一组件。
 *
 * 长选区滚动后起点可能在视口上方（rect.top 为负），所以不能直接拿 anchor.top
 * 定位。这里按「可见选区与安全区」算：优先贴在可见上沿，空间不够改到下方，
 * 再不够就夹在标题栏与窗口底之间，绝不让胶囊跑到原生标题栏或窗口外。
 */
export type SelectionCapsuleAnchor = {
  top: number
  left: number
  width: number
  /** 选区高度。老调用方不传时按 0 处理（等价于只贴选区上沿）。 */
  height?: number
}

const CAPSULE_GAP = 8
const FALLBACK_HEIGHT = 30

function titlebarSafeTop(): number {
  if (typeof window === 'undefined') return 42
  const value = getComputedStyle(document.documentElement).getPropertyValue('--titlebar-height')
  const parsed = Number.parseFloat(value)
  const titlebar = Number.isFinite(parsed) && parsed > 0 ? parsed : 34
  return titlebar + CAPSULE_GAP
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
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(FALLBACK_HEIGHT)

  useLayoutEffect(() => {
    const measured = ref.current?.offsetHeight ?? 0
    if (measured > 0 && measured !== height) setHeight(measured)
  }, [height, anchor.top, anchor.height, anchor.width])

  const half = 132
  const viewportWidth = typeof window === 'undefined' ? 1280 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 800 : window.innerHeight
  const left = Math.min(
    Math.max(anchor.left + anchor.width / 2, half + 8),
    Math.max(half + 8, viewportWidth - half - 8)
  )

  const safeTop = titlebarSafeTop()
  const safeBottom = viewportHeight - CAPSULE_GAP
  const selectionBottom = anchor.top + (anchor.height ?? 0)
  // 只有与视口相交的那一段算「可见选区」；整段都在上方时退化为安全区顶端。
  const visibleTop = Math.min(Math.max(anchor.top, safeTop), safeBottom)
  const visibleBottom = Math.min(Math.max(selectionBottom, visibleTop), safeBottom)

  const aboveBottom = visibleTop - CAPSULE_GAP
  const above = aboveBottom - height >= safeTop
  let topEdge: number
  let placement: 'above' | 'below'
  if (above) {
    placement = 'above'
    topEdge = aboveBottom - height
  } else {
    placement = 'below'
    const belowTop = visibleBottom + CAPSULE_GAP
    topEdge = Math.min(
      Math.max(belowTop, safeTop),
      Math.max(safeTop, viewportHeight - CAPSULE_GAP - height)
    )
  }

  return (
    <div
      ref={ref}
      className="selection-capsule"
      data-placement={placement}
      // CSS 用 translate(-50%, -100%) 把底边贴到 top；这里给出底边的位置。
      style={{ left, top: topEdge + height }}
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
