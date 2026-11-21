import { useState } from 'react'
import type { SettingsOverview } from '../../../shared/settings'
import { THEME_PREFERENCES, type ThemePreference } from '../../../shared/types'
import { saveTheme } from '../api'
import { failureText } from '../errors'
import { setThemePreference } from '../theme'
import { themeText } from './format'

/** 外观：浅色 / 深色 / 跟随系统，选了立刻生效并记住。 */
export function AppearanceSection({
  overview,
  onChange,
  notify
}: {
  overview: SettingsOverview
  onChange: (overview: SettingsOverview) => void
  notify: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)

  async function choose(theme: ThemePreference): Promise<void> {
    if (busy || overview.theme === theme) {
      return
    }
    setBusy(true)
    try {
      const result = await saveTheme(theme)
      if (!result.saved) {
        notify('主题没有保存')
        return
      }
      setThemePreference(result.theme)
      onChange({ ...overview, theme: result.theme })
      notify(`已切换到${themeText(result.theme)}`)
    } catch (caught) {
      notify(failureText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-appearance-title">
      <h2 id="settings-appearance-title">外观</h2>
      <p className="settings-desc">选择喜欢的主题。</p>

      <div className="settings-field" role="group" aria-label="主题">
        <span>主题</span>
        <div className="settings-segments">
          {THEME_PREFERENCES.map((theme) => (
            <button
              key={theme}
              type="button"
              className="settings-segment"
              aria-pressed={overview.theme === theme}
              onClick={() => void choose(theme)}
            >
              {themeText(theme)}
            </button>
          ))}
        </div>
      </div>

      <p className="settings-hint">
        跟随系统时，界面会随 Windows 的浅色或深色设置切换。
      </p>
    </section>
  )
}
