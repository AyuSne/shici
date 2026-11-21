import type { SettingsOverview } from '../../../shared/settings'

/** 关于：版本、Electron 版本与词典版权。 */
export function AboutSection({ overview }: { overview: SettingsOverview }) {
  return (
    <section className="settings-section" aria-labelledby="settings-about-title">
      <h2 id="settings-about-title">关于</h2>
      <p className="settings-desc">
        版本 {overview.appVersion}
      </p>
      <p className="settings-hint">
        词典数据来自 ECDICT（MIT License），版权归其作者所有。
      </p>
    </section>
  )
}
