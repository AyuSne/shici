import { useState } from 'react'
import {
  isAggregateModelProvider,
  isModelDirectoryReadOnly
} from '../../../shared/model-directory'
import type { FetchedModelCandidate } from '../../../shared/model-discovery'
import type {
  ModelProviderSummary,
  ProviderRetryPolicy
} from '../../../shared/model-providers'
import type { ProviderCredentialDraft } from '../../../shared/provider-credentials'
import { addProviderModel, updateProvider } from '../api'
import { failureText } from '../errors'
import { emptyCredentialDraft } from './credential-editor'
import { providerProtocolText, retryPolicyText } from './format'
import { providerModelDraftOf } from './model-discovery'
import { ModelDiscoveryPanel } from './model-discovery-panel'
import {
  baseUrlError,
  displayNameError,
  modelWriteErrorText,
  providerUpdateErrorText
} from './provider-editing'

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
  const aggregate = isAggregateModelProvider(provider)
  const [displayName, setDisplayName] = useState(provider.displayName)
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl ?? '')
  const [retryMode, setRetryMode] = useState<ProviderRetryPolicy['mode']>(
    provider.retryPolicy.mode
  )
  // 获取可用模型用的凭据草稿：与「编辑凭据」分开展示，只用于这次获取，不写库。
  const [credential, setCredential] = useState<ProviderCredentialDraft>(
    emptyCredentialDraft({
      authMode: provider.authMode,
      envVar: provider.envVar ?? ''
    })
  )
  const [discoveryReset, setDiscoveryReset] = useState(0)
  const [nameError, setNameError] = useState<string | null>(null)
  const [urlError, setUrlError] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * 勾选候选后显式加入：一次事务追加所有选中行，已有模型、默认模型与顺序都不动。
   * 这里不保存上面正在编辑的地址——「保存修改」才是改地址的动作。
   */
  async function applyDiscovered(candidates: readonly FetchedModelCandidate[]): Promise<void> {
    const drafts = candidates.map(providerModelDraftOf)
    const first = drafts[0]
    if (first === undefined) {
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      const result = await addProviderModel({
        providerId: provider.id,
        model: first,
        ...(drafts.length > 1 ? { additionalModels: drafts.slice(1) } : {})
      })
      if (result.status === 'missing') {
        throw new Error('这套提供商已经不在了，刷新后再试。')
      }
      if (result.status === 'rejected') {
        throw new Error(modelWriteErrorText(result.reason))
      }
      await refresh()
      setDiscoveryReset((current) => current + 1)
      notify(`已加入 ${drafts.length} 个获取到的模型；已有目录、默认模型与顺序不变`)
    } finally {
      setBusy(false)
    }
  }

  async function onSave(): Promise<void> {
    const nextNameError = displayNameError(displayName)
    // 聚合入口没有统一地址：地址按模型给，只改显示名不需要填一个假地址。
    const nextUrlError = aggregate ? null : baseUrlError(baseUrl)
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
        baseUrl: aggregate ? '' : baseUrl.trim(),
        retryPolicy: { mode: retryMode }
      })
      if (result.status === 'missing') {
        setFormError('这套提供商已经不在了，刷新后再试。')
        return
      }
      if (result.status === 'rejected') {
        const message = providerUpdateErrorText(result.reason)
        if (result.reason === 'missing-display-name') {
          setNameError(message)
        } else if (result.reason === 'invalid-retry-policy') {
          setFormError(message)
        } else {
          setUrlError(message)
        }
        return
      }
      await refresh()
      notify(
        aggregate || baseUrl.trim() === (provider.baseUrl ?? '')
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
          <dd>{providerProtocolText(provider)}</dd>
        </div>
      </dl>
      <p className="field-hint">
        {aggregate
          ? 'Provider ID 与「按模型混合」的协议创建后不可改；接口地址由每条模型自带，这里没有统一地址。'
          : 'Provider ID 与协议创建后不可改；要换协议请新建一套。'}
      </p>

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

      {aggregate ? (
        <p className="field-hint" data-aggregate-address="true">
          接口地址按每条模型自带（OpenCode GO 没有统一地址）；改显示名或凭据不影响模型地址。
        </p>
      ) : (
        <>
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
        </>
      )}

      <fieldset className="retry-mode" data-retry-policy={retryMode}>
        <legend className="settings-field-label">重试策略</legend>
        <label className="model-option">
          <input
            type="radio"
            name={`retry-mode-${provider.id}`}
            value="normal"
            checked={retryMode === 'normal'}
            disabled={busy}
            onChange={() => setRetryMode('normal')}
          />
          <span>只重试临时错误</span>
        </label>
        <label className="model-option">
          <input
            type="radio"
            name={`retry-mode-${provider.id}`}
            value="always"
            checked={retryMode === 'always'}
            disabled={busy}
            onChange={() => setRetryMode('always')}
          />
          <span>所有失败都重试</span>
        </label>
      </fieldset>
      <p className="field-hint">
        {retryPolicyText({ mode: retryMode })}。已经输出正文或思维链后不再自动重试，
        会保留已输出内容并显示真实错误；停止会取消还在等待的重试。
      </p>

      <ModelDiscoveryPanel
        source={provider.source === 'builtin' ? 'builtin' : 'custom'}
        catalogProviderId={provider.catalogProviderId}
        providerId={provider.source === 'custom' ? provider.id : null}
        protocol={provider.protocol}
        baseUrl={aggregate ? '' : baseUrl}
        credential={credential}
        onCredentialChange={setCredential}
        showCredentialFields={provider.source === 'custom'}
        defaultEnvVar={provider.envVar ?? ''}
        hasStoredKey={provider.authMode === 'stored' && provider.hasStoredCiphertext}
        storedKeyUnreadable={provider.credentialError === 'stored-decrypt-failed'}
        knownModelIds={provider.models.map((model) => model.modelId)}
        onApply={applyDiscovered}
        readOnly={isModelDirectoryReadOnly(provider)}
        resetToken={discoveryReset}
        disabled={busy}
      />

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
