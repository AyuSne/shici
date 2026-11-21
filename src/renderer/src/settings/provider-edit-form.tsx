import { useState } from 'react'
import type { ModelProviderSummary } from '../../../shared/model-providers'
import { updateProvider } from '../api'
import { failureText } from '../errors'
import { protocolText } from './format'
import { baseUrlError, displayNameError, providerUpdateErrorText } from './provider-editing'

type ProviderEditFormProps = {
  provider: ModelProviderSummary
  refresh: () => Promise<void>
  notify: (message: string) => void
  onClose: () => void
}

/**
 * 编辑 provider：只开放显示名与地址。
 * Provider ID 与协议是稳定身份与请求协议，创建后不可改，所以这里只读展示。
 */
export function ProviderEditForm({
  provider,
  refresh,
  notify,
  onClose
}: ProviderEditFormProps) {
  const [displayName, setDisplayName] = useState(provider.displayName)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '')
  const [nameError, setNameError] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function onSave(): Promise<void> {
    const nextNameError = displayNameError(displayName)
    const nextUrlError = baseUrlError(baseUrl)
    setNameError(nextNameError)
    setUrlError(nextUrlError)
    setFormError(null)
    if (nextNameError !== null || nextUrlError !== null) {
      return
    }

    setBusy(true)
    try {
      const result = await updateProvider({
        providerId: provider.id,
        displayName: displayName.trim(),
        baseUrl: baseUrl.trim()
      })
      if (result.status === 'missing') {
        setFormError('这套提供商已经不在了，刷新后再试。')
        return
      }
      if (result.status === 'rejected') {
        const message = providerUpdateErrorText(result.reason)
        if (result.reason === 'missing-display-name') {
          setNameError(message)
        } else {
          setUrlError(message)
        }
        return
      }
      await refresh()
      notify(
        baseUrl.trim() === (provider.baseUrl ?? '')
          ? `已保存「${displayName.trim()}」`
          : `已保存「${displayName.trim()}」的新地址；状态回到未验证`
      )
      onClose()
    } catch (error) {
      setFormError(failureText(error, '这次修改没有保存成功，再试一次。'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="profile-edit-form">
      <dl className="profile-facts">
        <div>
          <dt>Provider ID</dt>
          <dd>
            <code>{provider.providerKey}</code>
          </dd>
        </div>
        <div>
          <dt>协议</dt>
          <dd>{protocolText(provider.protocol)}</dd>
        </div>
      </dl>
      <p className="field-hint">Provider ID 与协议创建后不可改；要换协议请新建一套。</p>

      <label className="settings-field">
        <span>显示名</span>
        <input
          aria-label="编辑显示名"
          value={displayName}
          disabled={busy}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      {nameError === null ? null : (
        <p className="field-error" role="alert">
          {nameError}
        </p>
      )}

      <label className="settings-field">
        <span>接口地址</span>
        <input
          aria-label="编辑接口地址"
          autoComplete="off"
          spellCheck={false}
          value={baseUrl}
          disabled={busy}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>
      {urlError === null ? null : (
        <p className="field-error" role="alert">
          {urlError}
        </p>
      )}

      {formError === null ? null : (
        <p className="field-error" role="alert">
          {formError}
        </p>
      )}

      <div className="settings-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void onSave()}>
          保存修改
        </button>
        <button type="button" className="button" disabled={busy} onClick={onClose}>
          取消
        </button>
      </div>
    </div>
  )
}
