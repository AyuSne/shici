import { useEffect, useState } from 'react'
import type { SettingsOverview } from '../../../shared/settings'
import { loadSettingsOverview } from '../api'
import { setChatModel } from '../chat/store'
import { ErrorBlock } from '../components/error-block'
import { showToast } from '../components/toast-store'
import { failureText } from '../errors'
import { AboutSection } from '../settings/about-section'
import { AppearanceSection } from '../settings/appearance-section'
import { DataSection } from '../settings/data-section'
import { ModelSection } from '../settings/model-section'
import { ReadingDefaultsSection } from '../settings/reading-defaults-section'
import { settingsViewSection, updateSettingsViewSection } from '../view-state'

const SECTIONS = [
  { id: 'model', label: '模型服务' },
  { id: 'reading', label: '阅读' },
  { id: 'appearance', label: '外观' },
  { id: 'data', label: '数据' },
  { id: 'about', label: '关于' }
] as const

type SectionId = (typeof SECTIONS)[number]['id']

/** 设置页：左导航五分区，右侧单列表单；每处改动都直接写本机。 */
export function SettingsPage() {
  const [section, setSection] = useState<SectionId>(settingsViewSection)
  const [overview, setOverview] = useState<SettingsOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)

  useEffect(() => {
    let active = true
    setLoadError(null)
    loadSettingsOverview().then(
      (value) => {
        if (active) {
          setOverview(value)
          setChatModel(value.activeModel)
        }
      },
      (error: unknown) => {
        if (active) setLoadError(failureText(error, '设置没有读出来。'))
      }
    )
    return () => {
      active = false
    }
  }, [reloadToken])

  function applyOverview(next: SettingsOverview): void {
    setOverview(next)
    setChatModel(next.activeModel)
  }

  if (loadError !== null) {
    return (
      <div className="settings">
        <div className="settings-main">
          <div className="settings-inner">
            <ErrorBlock
              message={loadError}
              onAction={() => setReloadToken((token) => token + 1)}
            />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="settings">
      <aside className="settings-nav" aria-label="设置分区">
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="settings-nav-item"
            aria-current={section === item.id ? 'location' : undefined}
            onClick={() => {
              setSection(item.id)
              updateSettingsViewSection(item.id)
            }}
          >
            {item.label}
          </button>
        ))}
      </aside>

      <div className="settings-main">
        <div className="settings-inner">
          <header className="settings-head">
            <h1 className="page-title">设置</h1>
            <span className="settings-head-note">设置随本机保存</span>
          </header>

          {overview === null ? (
            <p className="empty-line">正在读取设置…</p>
          ) : section === 'model' ? (
            <ModelSection
              overview={overview}
              onChange={applyOverview}
              notify={(message) => showToast({ message })}
            />
          ) : section === 'reading' ? (
            <ReadingDefaultsSection
              overview={overview}
              onChange={applyOverview}
              notify={(message) => showToast({ message })}
            />
          ) : section === 'appearance' ? (
            <AppearanceSection
              overview={overview}
              onChange={applyOverview}
              notify={(message) => showToast({ message })}
            />
          ) : section === 'data' ? (
            <DataSection
              overview={overview}
              onChange={applyOverview}
              notify={(message) => showToast({ message })}
            />
          ) : (
            <AboutSection overview={overview} />
          )}
        </div>
      </div>
    </div>
  )
}
