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
  /** 自定义 API 表单用与内置表单不同的字段名，避免同页两个「API 密钥」。 */
  apiKeyLabel?: string
  /** 覆盖本机模式的密钥提示（如自定义 API 允许留空）。 */
  keyHint?: string
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
  apiKeyLabel = 'API 密钥',
  keyHint,
  disabled = false,
  error = null
}: CredentialEditorProps) {
  const stored = value.authMode === 'stored'
  const envPlaceholder = defaultEnvVar === '' ? 'MY_PROVIDER_KEY' : defaultEnvVar
  const keyPlaceholder = storedKeyUnreadable
    ? '本机密钥解不开，请重新填写'
    : hasStoredKey
      ? '留空保持原密钥'
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
          ? `切换到环境变量时使用这个名称，留空默认为 ${envPlaceholder}。`
          : `使用环境变量 ${value.envVar.trim() === '' ? envPlaceholder : value.envVar.trim()}。`}
      </p>

      {stored ? (
        <>
          <label className="settings-field">
            <span>{apiKeyLabel}</span>
            <input
              type="password"
              aria-label={apiKeyLabel}
              autoComplete="off"
              spellCheck={false}
              value={value.apiKey}
              placeholder={keyPlaceholder}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, apiKey: event.target.value })}
            />
          </label>
          <p className="field-hint">
            {keyHint ??
              (storedKeyUnreadable
                ? '保存的密钥无法使用，请重新填写。'
                : hasStoredKey
                  ? '留空可继续使用原密钥。'
                  : '密钥会加密保存在本机。')}
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
  /**
   * 打开时预选的密钥来源。默认沿用当前配置；从失败/凭据异常的
   * 「更换密钥」「改用本机密钥」按钮进来时直接落在要改的那一档。
   */
  initialAuthMode?: ProviderAuthMode
  /** 提交给主进程；成功与否由调用方决定何时卸载本编辑器。 */
  onSubmit: (request: UpdateProviderCredentialRequest) => void
  /** 取消编辑：不写库，原配置保持不变。 */
  onCancel: () => void
}

/**
 * 正在等待用户确认的动作。这里连同「当时那份草稿」一起冻结：确认按钮只
 * 提交快照里的值，草稿一改就作废，绝不能拿过期的表单内容去清密钥。
 */
type PendingConfirmation = {
  kind: 'switch-env' | 'clear-key'
  draft: ProviderCredentialDraft
}

/**
 * 卡片内联的凭据编辑：先确认再清除本机密文，取消不写库。
 * 清除密钥与切换来源都只改 provider 行，历史线程与钉住不受影响。
 */
export function ProviderCredentialEditor({
  provider,
  busy,
  error,
  initialAuthMode,
  onSubmit,
  onCancel
}: ProviderCredentialEditorProps) {
  const [draft, setDraft] = useState<ProviderCredentialDraft>(() => ({
    ...credentialDraftOfProvider(provider),
    authMode: initialAuthMode ?? provider.authMode
  }))
  const [pending, setPending] = useState<PendingConfirmation | null>(null)

  /** 任何字段/来源变化都让此前的确认失效，避免确认按钮用过期的草稿。 */
  function changeDraft(next: ProviderCredentialDraft): void {
    setDraft(next)
    setPending(null)
  }

  function submit(
    draftToSubmit: ProviderCredentialDraft,
    extra: { clearStoredKey?: boolean } = {}
  ): void {
    onSubmit({
      providerId: provider.id,
      authMode: draftToSubmit.authMode,
      envVar: draftToSubmit.envVar,
      apiKey: draftToSubmit.apiKey,
      confirmClearStored: draftToSubmit.confirmClearStored,
      ...extra
    })
  }

  function save(): void {
    if (
      draft.authMode === 'env' &&
      provider.authMode === 'stored' &&
      provider.hasStoredCiphertext &&
      !draft.confirmClearStored
    ) {
      // 先让用户明确确认会删掉本机唯一的密钥；取消就保持原配置。
      // 确认框锁住这份草稿；改回本机或改字段都会让它失效。
      setPending({ kind: 'switch-env', draft: { ...draft } })
      return
    }
    submit(draft)
  }

  function clearStoredKey(): void {
    // 只在本机模式且确有密文时提供；确认框同样锁住此刻的草稿。
    setPending({ kind: 'clear-key', draft: { ...draft, apiKey: '' } })
  }

  const idPrefix = `credential-${provider.id}`

  return (
    <div className="credential-editor-panel" data-credential-editor-for={provider.providerKey}>
      <CredentialEditor
        idPrefix={idPrefix}
        value={draft}
        onChange={changeDraft}
        hasStoredKey={provider.authMode === 'stored' && provider.hasStoredCiphertext}
        storedKeyUnreadable={provider.credentialError === 'stored-decrypt-failed'}
        defaultEnvVar={provider.envVar ?? ''}
        disabled={busy}
        error={error}
      />

      {pending?.kind === 'switch-env' ? (
        <div className="profile-confirm">
          <span>
            切换到环境变量会清除本机保存的密钥。
          </span>
          <button
            type="button"
            className="button button-danger button-small"
            disabled={busy}
            onClick={() =>
              submit(
                { ...pending.draft, authMode: 'env', confirmClearStored: true }
              )
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
      ) : pending?.kind === 'clear-key' ? (
        <div className="profile-confirm">
          <span>
            清除本机密钥后，需要重新填写才能使用。
          </span>
          <button
            type="button"
            className="button button-danger button-small"
            disabled={busy}
            onClick={() =>
              submit(
                {
                  ...pending.draft,
                  authMode: 'stored',
                  apiKey: '',
                  confirmClearStored: false
                },
                { clearStoredKey: true }
              )
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
          {provider.authMode === 'stored' &&
          provider.hasStoredCiphertext &&
          draft.authMode === 'stored' ? (
            <button
              type="button"
              className="link-button is-danger"
              disabled={busy}
              onClick={clearStoredKey}
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
