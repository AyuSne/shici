import { useState } from 'react'
import type {
  ReadingGlobalPreferences,
  ReadingPreferences
} from '../../../shared/reading'
import {
  MARGIN_NOTE_LABELS,
  MARGIN_NOTE_MODES,
  READING_FONT_SIZES,
  READING_LINE_HEIGHTS
} from '../../../shared/reading'
import type { SettingsOverview } from '../../../shared/settings'
import { saveReadingGlobalPreferences, saveReadingPreferences } from '../api'
import { failureText } from '../errors'
import { readingDefaultsText } from './format'

/**
 * 全局阅读默认。阅读页里改的是本篇覆盖值，不会被这里覆盖；
 * 这里只决定还没单独调过的文章。
 */
export function ReadingDefaultsSection({
  overview,
  onChange,
  notify
}: {
  overview: SettingsOverview
  onChange: (overview: SettingsOverview) => void
  notify: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)

  async function save(patch: Partial<ReadingPreferences>): Promise<void> {
    if (busy) {
      return
    }
    const preferences = { ...overview.reading, ...patch }
    onChange({ ...overview, reading: preferences })
    setBusy(true)
    try {
      const result = await saveReadingPreferences(preferences)
      onChange({ ...overview, reading: result.preferences })
      notify(result.saved ? '已保存为全局默认' : '这次没有保存，值不合法')
    } catch (caught) {
      notify(failureText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function saveGlobal(patch: Partial<ReadingGlobalPreferences>): Promise<void> {
    if (busy) {
      return
    }
    const preferences = { ...overview.readingGlobal, ...patch }
    onChange({ ...overview, readingGlobal: preferences })
    setBusy(true)
    try {
      const result = await saveReadingGlobalPreferences(preferences)
      onChange({ ...overview, readingGlobal: result.preferences })
      notify(result.saved ? '已保存为全局默认' : '这次没有保存，值不合法')
    } catch (caught) {
      notify(failureText(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-reading-title">
      <h2 id="settings-reading-title">阅读</h2>
      <p className="settings-desc">
        这里改的是全局默认。单篇阅读页里改的只影响那一篇，不会被这里覆盖。
      </p>

      <div className="settings-field" role="group" aria-label="默认字号">
        <span>正文字号</span>
        <div className="settings-segments">
          {READING_FONT_SIZES.map((fontSize) => (
            <button
              key={fontSize}
              type="button"
              className="settings-segment"
              aria-pressed={overview.reading.fontSize === fontSize}
              onClick={() => void save({ fontSize })}
            >
              {fontSize}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-field" role="group" aria-label="默认行距">
        <span>行距</span>
        <div className="settings-segments">
          {READING_LINE_HEIGHTS.map((lineHeight) => (
            <button
              key={lineHeight}
              type="button"
              className="settings-segment"
              aria-pressed={overview.reading.lineHeight === lineHeight}
              onClick={() => void save({ lineHeight })}
            >
              {lineHeight.toFixed(1)}
            </button>
          ))}
        </div>
      </div>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={overview.reading.annotationsVisible}
          onChange={(event) =>
            void save({ annotationsVisible: event.target.checked })
          }
        />
        默认显示原文注释
      </label>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={overview.reading.weakHighlight}
          onChange={(event) => void save({ weakHighlight: event.target.checked })}
        />
        默认弱高亮已收集的词
      </label>

      <h3 className="settings-subtitle">圈词与重读</h3>
      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={overview.readingGlobal.silentCollection}
          onChange={(event) => void saveGlobal({ silentCollection: event.target.checked })}
        />
        静默圈词（只落墨与撤销提示，不弹选词卡）
      </label>

      <div className="settings-field" role="group" aria-label="页边眉批">
        <span>页边眉批</span>
        <div className="settings-segments">
          {MARGIN_NOTE_MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              className="settings-segment"
              aria-pressed={overview.readingGlobal.marginNoteMode === mode}
              onClick={() => void saveGlobal({ marginNoteMode: mode })}
            >
              {MARGIN_NOTE_LABELS[mode]}
            </button>
          ))}
        </div>
      </div>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={overview.readingGlobal.lightMask}
          onChange={(event) => void saveGlobal({ lightMask: event.target.checked })}
        />
        轻遮重读（已收集词只露首字母，悬停或轻点揭开）
      </label>

      <p className="settings-summary">
        当前全局默认 · {readingDefaultsText(overview.reading)}
      </p>
    </section>
  )
}
