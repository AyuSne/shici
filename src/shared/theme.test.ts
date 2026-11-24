import { describe, expect, it } from 'vitest'
import { THEME_INK, THEME_PAPER, TITLEBAR_HEIGHT, titleBarOverlayFor } from './theme'

/**
 * 原生覆盖标题栏的颜色必须来自 token 表的纸色与墨色，而不是另写一套。
 * 期望值直接抄 docs/ui-tokens.md，不从实现里反推。
 */
describe('原生覆盖标题栏配色', () => {
  it('浅色：暖纸底、深墨符号', () => {
    expect(THEME_PAPER.light).toBe('#FBFAF3')
    expect(THEME_INK.light).toBe('#1A1A17')
    expect(titleBarOverlayFor('light')).toEqual({
      color: '#FBFAF3',
      symbolColor: '#1A1A17',
      height: 34
    })
  })

  it('深色：深纸底、暖墨符号', () => {
    expect(THEME_PAPER.dark).toBe('#1A1A1E')
    expect(THEME_INK.dark).toBe('#E8E4DA')
    expect(titleBarOverlayFor('dark')).toEqual({
      color: '#1A1A1E',
      symbolColor: '#E8E4DA',
      height: 34
    })
  })

  it('标题栏高度与渲染层预留一致', () => {
    expect(TITLEBAR_HEIGHT).toBe(34)
  })
})
