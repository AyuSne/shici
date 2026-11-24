import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { filterTargets, moveActiveIndex, type SearchableTarget } from './target-search'

/**
 * 可搜索的目标选择器：词条与文章共用。输入即时过滤（主标签 + 变体说明），
 * ↑/↓ 移动活动项、Enter 选中、Esc 收起；选中后显示「已选」一行，仍可继续输入改选。
 * 由 #83 的钉住落点与右栏维护表单共用，后续轻问抽屉也可直接复用。
 */
export function SearchableTargetPicker({
  label,
  targets,
  value,
  onChange,
  placeholder = '输入关键词过滤…',
  emptyText = '没有匹配的目标',
  disabled = false,
  autoFocus = false,
  onSubmit
}: {
  /** 字段名与输入框的无障碍名称。 */
  label: string
  targets: readonly SearchableTarget[]
  value: string | null
  onChange: (targetId: string) => void
  placeholder?: string
  emptyText?: string
  disabled?: boolean
  autoFocus?: boolean
  /**
   * 列表收起时按 Enter 的语义。钉住弹层传「确认」：预选就绪后一个 Enter 就能落钉；
   * 不传时保持原行为（打开候选列表），维护表单里的选择器因此不受影响。
   */
  onSubmit?: () => void
}) {
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  /** 弹层刚打开时的自动聚焦只定位输入框，不立刻铺开候选盖住确认按钮。 */
  const skipAutoOpen = useRef(autoFocus)
  const filtered = filterTargets(targets, query)
  const selected = targets.find((target) => target.id === value) ?? null

  // 点选择器以外的地方收起候选；不抢当前输入焦点。
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return
      setOpen(false)
      setActive(-1)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus()
  }, [autoFocus])

  const choose = (target: SearchableTarget | undefined): void => {
    if (!target) return
    onChange(target.id)
    setQuery('')
    setOpen(false)
    setActive(-1)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // 输入法组合态里的 Enter / 方向键 / Esc 属于候选词，不属于选择器。
    if (event.nativeEvent.isComposing) {
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setOpen(true)
      setActive((current) => moveActiveIndex(filtered.length, current, event.key === 'ArrowDown' ? 'down' : 'up'))
      return
    }
    if (event.key === 'Enter') {
      if (!open) {
        if (onSubmit !== undefined) {
          event.preventDefault()
          onSubmit()
          return
        }
        setOpen(true)
        return
      }
      if (filtered.length > 0) {
        event.preventDefault()
        choose(filtered[active < 0 ? 0 : active])
      }
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      setActive(-1)
      return
    }
    if (event.key === 'Tab') {
      setOpen(false)
      setActive(-1)
    }
  }

  return (
    <div className="target-picker" ref={rootRef} data-open={open ? 'true' : 'false'}>
      <input
        ref={inputRef}
        className="target-picker-input"
        type="text"
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={
          open && active >= 0 && filtered[active] ? `${listId}-${filtered[active]!.id}` : undefined
        }
        autoComplete="off"
        disabled={disabled}
        placeholder={placeholder}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => {
          if (skipAutoOpen.current) {
            skipAutoOpen.current = false
            return
          }
          setOpen(true)
        }}
        onClick={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {selected === null ? null : (
        <p className="target-picker-current">
          已选：<strong>{selected.label}</strong>
          {selected.detail ? <span> · {selected.detail}</span> : null}
        </p>
      )}
      {open ? (
        <ul className="target-picker-list" id={listId} role="listbox" aria-label={`${label}候选`}>
          {filtered.length === 0 ? (
            <li className="target-picker-empty" role="presentation">
              {emptyText}
            </li>
          ) : (
            filtered.map((target, index) => (
              <li
                key={target.id}
                id={`${listId}-${target.id}`}
                role="option"
                aria-selected={target.id === value}
                data-active={index === active ? 'true' : 'false'}
                className="target-picker-option"
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  choose(target)
                }}
                onClick={() => choose(target)}
              >
                <span className="target-picker-label">{target.label}</span>
                {target.detail ? (
                  <span className="target-picker-detail">{target.detail}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  )
}
