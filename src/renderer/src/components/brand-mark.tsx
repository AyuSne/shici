/**
 * 侧栏与融合标题栏共用的品牌标志：与桌面图标同源的「拾光行」微缩矢量版
 * （深墨底座 + 暖纸内页 + 琥珀选词块）。只在装饰位置出现，交给 aria-hidden。
 */
export function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="1.5" y="1.5" width="21" height="21" rx="5.5" className="brand-mark-frame" />
      <rect x="4.5" y="4.5" width="15" height="15" rx="3.2" fill="#FBFAF3" />
      <rect x="6.5" y="7.4" width="11" height="1.9" rx="0.95" fill="#524D43" />
      <rect x="6.5" y="10.9" width="7.2" height="2.4" rx="1.15" fill="#D9A441" />
      <rect x="14.7" y="11.15" width="2.8" height="1.9" rx="0.95" fill="#524D43" />
      <rect x="6.5" y="14.9" width="8.2" height="1.9" rx="0.95" fill="#524D43" />
    </svg>
  )
}
