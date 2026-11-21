import { useState } from 'react'
import type {
  ModelProviderSummary,
  ProviderAuthMode
} from '../../../shared/model-providers'
import type {
  ProviderCredentialDraft,
  UpdateProviderCredentialRequest
} from '../../../shared/provider-credentials'

/**
 * 密钥来源编辑区：本机 / 环境变量、变量名、新密钥与「清除已存密文」的确认位。
 *
 * 两个层次，创建与编辑共用同一份 `ProviderCredentialDraft`：
 * - `CredentialEditor` 只做受控输入，不直接发 IPC（#63 的自定义 API 表单直接用它）；
 * - `ProviderCredentialEditor` 带保存/确认/清除动作，给已有 provider 的卡片用。
 *
 * `confirmClearStored` 不在界面里直接勾选，而是用户在确认「切到环境会清掉
 * 本机密钥」之后由组件置为 true；主进程还会再校验一次这个字段。
 */

export type CredentialEditorProps = {
  /** 同一页多处使用时的 id 前缀，如 `credential-provider-1`。 */
  idPrefix: string
  value: ProviderCredentialDraft
  onChange: (next: ProviderCredentialDraft) => void
  /** 本机已存密钥：密钥输入留空表示保持不变。 */
  hasStoredKey?: boolean
  /** 本机已存密钥但解不开：密钥必须重填，不要提示「留空保持不变」。 */
  storedKeyUnreadable?: boolean
  /** 目录或现有配置带出的默认环境变量名；输入框留空时用它。 */
  defaultEnvVar?: string
  disabled?: boolean
  error?: string | null
}

export function emptyCredentialDraft(
  input: Partial<ProviderCredentialDraft> = {}
): ProviderCredentialDraft {
  return {
    authMode: input.authMode ?? 'stored',
    envVar: input.envVar ?? '',
    apiKey: input.apiKey ?? '',
    confirmClearStored: input.confirmClearStored ?? false
  }
}

/** 编辑已有 provider 时从只读摘要生成草稿：永远不带回明文密钥。 */
export function credentialDraftOfProvider(
  provider: Pick<ModelProviderSummary, 'authMode' | 'envVar'>
): ProviderCredentialDraft {
  return emptyCredentialDraft({
    authMode: provider.authMode,
    envVar: provider.envVar ?? ''
  })
}

export function CredentialEditor({
  idPrefix,
  value,
  onChange,
  hasStoredKey = false,
  storedKeyUnreadable = false,
  defaultEnvVar = '',
  disabled = false,
  error = null
}: CredentialEditorProps) {
  const stored = value.authMode === 'stored'
  const envPlaceholder = defaultEnvVar === '' ? 'MY_PROVIDER_KEY' : defaultEnvVar
  const keyPlaceholder = storedKeyUnreadable
    ? '本机密钥解不开，请重新填写'
    : hasStoredKey
      ? '留空保持不变（只写不读）'
      : '填写 API 密钥'

  function choose(authMode: ProviderAuthMode): void {
    if (authMode === value.authMode) {
      return
    }
    onChange({ ...value, authMode, confirmClearStored: false })
  }

  return (
    <div className="credential-editor">
      <fieldset className="credential-mode" disabled={disabled}>
        <legend className="settings-field-label">密钥来源</legend>
        <label className="model-option">
          <input
            type="radio"
            name={`${idPrefix}-auth-mode`}
            value="stored"
            checked={stored}
            onChange={() => choose('stored')}
          />
          <span>保存在本机</span>
        </label>
        <label className="model-option">
          <input
            type="radio"
            name={`${idPrefix}-auth-mode`}
            value="env"
            checked={!stored}
            onChange={() => choose('env')}
          />
          <span>使用环境变量</span>
        </label>
      </fieldset>

      <label className="settings-field">
        <span>环境变量名</span>
        <input
          type="text"
          aria-label="环境变量名"
          autoComplete="off"
          spellCheck={false}
          value={value.envVar}
          placeholder={envPlaceholder}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, envVar: event.target.value })}
        />
      </label>
      <p className="field-hint">
        {stored
          ? `改用环境变量时会读这个名字；现在存本机，不读它。留空默认 ${envPlaceholder}。`
          : `只从环境变量 ${value.envVar.trim() === '' ? envPlaceholder : value.envVar.trim()} 读取；不加密、不写入本机，也不读已存密文。`}
      </p>

      {stored ? (
        <>
          <label className="settings-field">
            <span>API 密钥</span>
            <input
              type="password"
              aria-label="API 密钥"
              autoComplete="off"
              spellCheck={false}
              value={value.apiKey}
              placeholder={keyPlaceholder}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, apiKey: event.target.value })}
            />
          </label>
          <p className="field-hint">
            {storedKeyUnreadable
              ? '库里的旧密文解不开，只有重填一个新密钥才能恢复使用；不会自动改用环境变量。'
              : hasStoredKey
                ? '已保存的密钥只显示掩码，不会回传到界面；留空表示继续用原来那把。'
                : '密钥只经系统密钥库加密保存，保存时不联网。'}
          </p>
        </>
      ) : null}

      {error === null ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/* ---------- 已有 provider：带保存 / 切换确认 / 清除密钥 ---------- */

export type ProviderCredentialEditorProps = {
  provider: ModelProviderSummary
  busy: boolean
  error: string | null
  /** 提交给主进程；成功与否由调用方决定何时卸载本编辑器。 */
  onSubmit: (request: UpdateProviderCredentialRequest) => void
  /** 取消编辑：不写库，原配置保持不变。 */
  onCancel: () => void
}

/**
 * 卡片内联的凭据编辑：先确认再清除本机密文，取消不写库。
 * 清除密钥与切换来源都只改 provider 行，历史线程与钉住不受影响。
 */
export function ProviderCredentialEditor({
  provider,
  busy,
  error,
  onSubmit,
  onCancel
}: ProviderCredentialEditorProps) {
  const [draft, setDraft] = useState<ProviderCredentialDraft>(
    credentialDraftOfProvider(provider)
  )
  const [pending, setPending] = useState<'switch-env' | 'clear-key' | null>(null)

  function save(): void {
    if (
      draft.authMode === 'env' &&
      provider.authMode === 'stored' &&
      provider.hasStoredCiphertext &&
      !draft.confirmClearStored
    ) {
      // 先让用户明确确认会删掉本机唯一的密钥；取消就保持原配置。
      setPending('switch-env')
      return
    }
    onSubmit({
      providerId: provider.id,
      authMode: draft.authMode,
      envVar: draft.envVar,
      apiKey: draft.apiKey,
      confirmClearStored: draft.confirmClearStored
    })
  }

  const idPrefix = `credential-${provider.id}`

  return (
    <div className="credential-editor-panel">
      <CredentialEditor
        idPrefix={idPrefix}
        value={draft}
        onChange={setDraft}
        hasStoredKey={provider.authMode === 'stored' && provider.hasStoredCiphertext}
        storedKeyUnreadable={provider.credentialError === 'stored-decrypt-failed'}
        defaultEnvVar={provider.envVar ?? ''}
        disabled={busy}
        error={error}
      />

      {pending === 'switch-env' ? (
        <div className="profile-confirm">
          <span>
            切到环境变量会清除这套本机已存的密钥，之后只读环境变量；取消则保持原配置。历史线程与钉住不受影响。
          </span>
          <button
            type="button"
            className="button button-danger button-small"
            disabled={busy}
            onClick={() =>
              onSubmit({
                providerId: provider.id,
                authMode: 'env',
                envVar: draft.envVar,
                apiKey: draft.apiKey,
                confirmClearStored: true
              })
            }
          >
            确认清除并切换
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
        </div>
      ) : pending === 'clear-key' ? (
        <div className="profile-confirm">
          <span>
            清除本机密钥后，这套会显示「缺失」，发送时会明确报错；历史线程与钉住不受影响。
          </span>
          <button
            type="button"
            className="button button-danger button-small"
            disabled={busy}
            onClick={() =>
              onSubmit({
                providerId: provider.id,
                authMode: 'stored',
                envVar: provider.envVar ?? '',
                apiKey: '',
                confirmClearStored: false,
                clearStoredKey: true
              })
            }
          >
            确认清除
          </button>
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
        </div>
      ) : (
        <div className="settings-actions">
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={save}
          >
            保存凭据
          </button>
          {provider.authMode === 'stored' && provider.hasStoredCiphertext ? (
            <button
              type="button"
              className="link-button is-danger"
              disabled={busy}
              onClick={() => setPending('clear-key')}
            >
              清除已存密钥
            </button>
          ) : null}
          <button
            type="button"
            className="button button-small"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
        </div>
      )}
    </div>
  )
}
