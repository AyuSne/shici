import { useState } from 'react'
import type {
  ModelProviderSummary,
  ProviderAuthMode
} from '../../../shared/model-providers'
import { listBuiltinProviderSetups, type BuiltinProviderId } from '../../../shared/model-builtin'
import { isAggregateModelProvider } from '../../../shared/model-directory'
import type { UpdateProviderCredentialRequest } from '../../../shared/provider-credentials'
import type { ProviderTestFailure } from '../../../shared/provider-test'
import type { SettingsOverview } from '../../../shared/settings'
import {
  activateProvider,
  addBuiltinProvider,
  deleteProvider,
  loadSettingsOverview,
  setDefaultProviderModel,
  testProviderConnection,
  updateProviderCredential
} from '../api'
import { failureText } from '../errors'
import { ProviderCredentialEditor } from './credential-editor'
import { CustomProviderForm } from './custom-provider-form'
import {
  checkText,
  credentialIssueText,
  credentialRepairs,
  keyStateText,
  providerBaseUrlText,
  providerModelsText,
  providerProtocolText,
  providerSourceText,
  providerTestFailureText,
  providerTestRepairs,
  providerTestRequestId,
  providerTestVerifiedText,
  retryPolicyText,
  verificationText,
  type ProviderRepairKind
} from './format'
import { credentialRejectionText, modelSectionDescription } from './messages'
import { ProviderEditForm } from './provider-edit-form'
import { ProviderModelEditor } from './provider-model-editor'
import { showProviderSavedToast } from './provider-saved-toast'

type ModelSectionProps = {
  overview: SettingsOverview
  onChange: (overview: SettingsOverview) => void
  notify: (message: string) => void
}

/** 就地修复按钮的文字；动作本身由 `handleRepair` 统一收口。 */
const REPAIR_LABEL: Record<ProviderRepairKind, string> = {
  'replace-key': '更换密钥',
  'use-stored-key': '改用本机密钥',
  'edit-connection': '检查连接设置',
  'manage-models': '管理模型',
  'retry-test': '再测一次'
}

/**
 * 请求 ID 这类诊断字符只放在折叠小字里，并提供一键复制；
 * 不进入面向所有学习者的主文案。
 */
function DiagnosticRequestId({ requestId }: { requestId: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <details className="profile-diagnostic">
      <summary>诊断信息</summary>
      <div className="profile-diagnostic-body">
        <code className="profile-diagnostic-id">请求 ID {requestId}</code>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            void navigator.clipboard.writeText(requestId).then(
              () => setCopied(true),
              () => setCopied(false)
            )
          }}
        >
          复制请求 ID
        </button>
        {copied ? <span className="settings-hint">已复制</span> : null}
      </div>
    </details>
  )
}

/**
 * 模型服务：内置目录（由 `listBuiltinProviderSetups()` 决定当前开放哪些）
 * 与自定义 API 两条添加路径。
 *
 * 日常界面只保留「选提供商 + 填密钥 + 保存」和每张卡片的精炼状态；
 * 接口地址、协议、目录预览、Provider ID 规则与完整模型目录编辑器默认折叠，
 * 失败与凭据异常则就地给出自然原因和可直接点的修复动作。
 */
export function ModelSection({ overview, onChange, notify }: ModelSectionProps) {
  const setups = listBuiltinProviderSetups()
  const [catalogId, setCatalogId] = useState<BuiltinProviderId>(
    setups[0]?.id ?? 'deepseek'
  )
  const [apiKey, setApiKey] = useState('')
  const [addAuthMode, setAddAuthMode] = useState<ProviderAuthMode>('stored')
  const [addEnvVar, setAddEnvVar] = useState(setups[0]?.envVar ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [addMode, setAddMode] = useState<'builtin' | 'custom'>('builtin')
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)
  const [manageModelsId, setManageModelsId] = useState<string | null>(null)
  const [moreMenuId, setMoreMenuId] = useState<string | null>(null)
  const [credentialEditing, setCredentialEditing] = useState<{
    providerId: string
    authMode: ProviderAuthMode
  } | null>(null)
  const [credentialError, setCredentialError] = useState<string | null>(null)
  /** 最近一次「测试连接」失败：只留在对应卡片上，直到重测或改配置。 */
  const [testFailure, setTestFailure] = useState<{
    providerId: string
    result: ProviderTestFailure
  } | null>(null)

  const setup = setups.find((candidate) => candidate.id === catalogId) ?? setups[0]
  const builtinNames = setups.map((candidate) => candidate.displayName).join('、')
  const noActiveProvider =
    overview.providers.length > 0 && overview.activeProviderId === null

  async function refresh(): Promise<void> {
    onChange(await loadSettingsOverview())
  }

  async function run(action: string, work: () => Promise<void>): Promise<void> {
    setBusy(action)
    setFormError(null)
    try {
      await work()
    } catch (error) {
      setFormError(failureText(error, '这次操作没有完成，再试一次。'))
    } finally {
      setBusy(null)
    }
  }

  function onAdd(): Promise<void> {
    return run('add', async () => {
      if (setup === undefined) {
        setFormError('内置目录里没有可添加的提供商。')
        return
      }
      const key = apiKey.trim()
      if (addAuthMode === 'stored' && key === '') {
        setFormError('先填 API 密钥再保存；不想把密钥存在本机就选「使用环境变量」。')
        return
      }
      const result = await addBuiltinProvider({
        catalogProviderId: setup.id,
        authMode: addAuthMode,
        envVar: addEnvVar.trim() === '' ? setup.envVar : addEnvVar,
        apiKey: addAuthMode === 'stored' ? key : ''
      })
      if (result.status === 'rejected') {
        setFormError(
          result.reason === 'missing-key'
            ? '先填 API 密钥再保存。'
            : result.reason === 'invalid-env-var'
              ? credentialRejectionText('invalid-env-var')
              : '这个入口不在本版的内置目录里。'
        )
        return
      }
      setApiKey('')
      const next = await loadSettingsOverview()
      onChange(next)
      const saved = next.providers.find((provider) => provider.id === result.providerId)
      const savedName = saved?.displayName ?? setup.displayName
      const becameActive = saved?.active === true
      showProviderSavedToast({
        message: becameActive ? `已保存 ${savedName}，设为使用中` : `已保存 ${savedName}`,
        providerId: result.providerId,
        displayName: savedName,
        onTested: async (tested) => {
          await refresh()
          if (tested.status === 'verified') {
            setTestFailure((current) =>
              current?.providerId === result.providerId ? null : current
            )
            return
          }
          setTestFailure({ providerId: result.providerId, result: tested })
        }
      })
    })
  }

  function onActivate(provider: ModelProviderSummary): Promise<void> {
    return run(`activate-${provider.id}`, async () => {
      const result = await activateProvider({ providerId: provider.id })
      if (result.status !== 'activated') {
        setFormError('这套提供商已经不在了，刷新后再试。')
        return
      }
      await refresh()
      setMoreMenuId(null)
      notify(`之后的对话会使用「${provider.displayName}」`)
    })
  }

  function onDelete(provider: ModelProviderSummary): Promise<void> {
    return run(`delete-${provider.id}`, async () => {
      const result = await deleteProvider({ providerId: provider.id })
      setConfirmDelete(null)
      setMoreMenuId(null)
      if (testFailure?.providerId === provider.id) {
        setTestFailure(null)
      }
      if (result.status !== 'deleted') {
        setFormError('这套提供商已经不在了。')
        return
      }
      await refresh()
      notify(
        result.activeCleared
          ? '已删除使用中的提供商；现在没有使用中的提供商，之后的对话要先选一套。'
          : `已删除「${provider.displayName}」`
      )
    })
  }

  /**
   * 显式「测试连接」：按这套 provider 的协议发一次最小请求。
   * 保存与测试彻底分开——失败只写验证状态与最后错误，原配置与原密钥原样保留。
   */
  function onTest(provider: ModelProviderSummary): Promise<void> {
    return run(`test-${provider.id}`, async () => {
      if (testFailure?.providerId === provider.id) {
        setTestFailure(null)
      }
      const result = await testProviderConnection({ providerId: provider.id })
      if (result.status === 'missing') {
        setFormError('这套提供商已经不在了，刷新后再试。')
        await refresh()
        return
      }
      await refresh()
      if (result.status === 'verified') {
        notify(providerTestVerifiedText(result))
        return
      }
      setTestFailure({ providerId: provider.id, result })
      notify(`「${provider.displayName}」${providerTestFailureText(result)}`)
    })
  }

  function onDefaultModel(provider: ModelProviderSummary, modelRowId: string): Promise<void> {
    return run(`default-${provider.id}`, async () => {
      const result = await setDefaultProviderModel({
        providerId: provider.id,
        modelRowId
      })
      if (result.status === 'missing') {
        setFormError('这套提供商已经不在了，刷新后再试。')
        return
      }
      if (result.status === 'rejected') {
        setFormError('这个模型已经不在目录里了，刷新后再选。')
        return
      }
      await refresh()
      notify('已换默认模型')
    })
  }

  function startCredentialEdit(
    provider: ModelProviderSummary,
    authMode: ProviderAuthMode = provider.authMode
  ): void {
    // 卡片内同时只开一个编辑面板，避免两个表单抢同一块位置。
    setEditingProviderId(null)
    setManageModelsId(null)
    setMoreMenuId(null)
    setCredentialEditing({ providerId: provider.id, authMode })
    setCredentialError(null)
    if (testFailure?.providerId === provider.id) {
      setTestFailure(null)
    }
  }

  function cancelCredentialEdit(): void {
    setCredentialEditing(null)
    setCredentialError(null)
  }

  /** 失败/凭据异常旁的按钮都落到真实可改的地方，不只给一句路径。 */
  function handleRepair(kind: ProviderRepairKind, provider: ModelProviderSummary): void {
    switch (kind) {
      case 'replace-key':
      case 'use-stored-key':
        startCredentialEdit(provider, 'stored')
        return
      case 'edit-connection':
        setCredentialEditing(null)
        setManageModelsId(null)
        setMoreMenuId(null)
        setEditingProviderId(provider.id)
        return
      case 'manage-models':
        setEditingProviderId(null)
        setCredentialEditing(null)
        setManageModelsId(provider.id)
        return
      case 'retry-test':
        void onTest(provider)
        return
    }
  }

  async function submitCredential(request: UpdateProviderCredentialRequest): Promise<void> {
    setBusy(`credential-${request.providerId}`)
    setCredentialError(null)
    try {
      const result = await updateProviderCredential(request)
      if (result.status === 'missing') {
        setCredentialError('这套提供商已经不在了，刷新后再试。')
        return
      }
      if (result.status === 'rejected') {
        setCredentialError(credentialRejectionText(result.reason))
        return
      }
      cancelCredentialEdit()
      await refresh()
      notify(
        result.clearedStored
          ? '已清除本机密钥'
          : result.authMode === 'env'
            ? '已保存环境变量设置'
            : '已更新本机密钥'
      )
    } catch (error) {
      setCredentialError(failureText(error, '凭据没有保存成功，再试一次。'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="settings-section" aria-labelledby="settings-model-title">
      <h2 id="settings-model-title">模型服务</h2>
      <p className="settings-desc">{modelSectionDescription(builtinNames)}</p>

      {overview.providers.length === 0 ? (
        <p className="settings-empty">
          还没有模型提供商。选一家内置的服务，填上密钥就能开始；也可以自定义一套。
        </p>
      ) : (
        <>
          {noActiveProvider ? (
            <p className="settings-hint is-warning">
              现在没有使用中的提供商，请选择一套。
            </p>
          ) : null}
          <ul className="profile-list">
            {overview.providers.map((provider) => {
              const issue = credentialIssueText(provider)
              const failure = testFailure?.providerId === provider.id ? testFailure : null
              const requestId = failure === null ? null : providerTestRequestId(failure.result)
              const defaultRowId = provider.defaultModelRowId ?? provider.models[0]?.id ?? ''
              return (
                <li
                  key={provider.id}
                  className={provider.active ? 'profile-card is-active' : 'profile-card'}
                  data-provider-key={provider.providerKey}
                >
                  <div className="profile-head">
                    <b className="profile-name">{provider.displayName}</b>
                    {provider.active ? (
                      <span className="profile-chip is-current">使用中</span>
                    ) : null}
                    <span
                      className={
                        provider.verification === 'verified'
                          ? 'profile-chip is-verified'
                          : 'profile-chip'
                      }
                    >
                      {verificationText(provider)}
                    </span>

                    <div className="profile-controls">
                      {provider.models.length === 0 ? (
                        <span className="settings-hint">还没有模型</span>
                      ) : (
                        <label className="profile-default-model">
                          <span>默认模型</span>
                          <select
                            aria-label={`默认模型 ${provider.displayName}`}
                            value={defaultRowId}
                            disabled={busy !== null}
                            onChange={(event) =>
                              void onDefaultModel(provider, event.target.value)
                            }
                          >
                            {provider.models.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.modelId}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}

                      <div className="profile-actions">
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`测试连接 ${provider.displayName}`}
                        disabled={busy !== null || provider.models.length === 0}
                        onClick={() => void onTest(provider)}
                      >
                        {busy === `test-${provider.id}` ? '测试中…' : '测试连接'}
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy !== null}
                        onClick={() => startCredentialEdit(provider)}
                      >
                        编辑凭据
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        aria-expanded={manageModelsId === provider.id}
                        onClick={() => {
                          setMoreMenuId(null)
                          setEditingProviderId(null)
                          setManageModelsId(
                            manageModelsId === provider.id ? null : provider.id
                          )
                        }}
                      >
                        管理模型
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`更多 ${provider.displayName}`}
                        aria-expanded={moreMenuId === provider.id}
                        onClick={() => {
                          setManageModelsId(null)
                          setMoreMenuId(moreMenuId === provider.id ? null : provider.id)
                        }}
                      >
                        更多
                      </button>
                      </div>
                    </div>
                  </div>

                  {moreMenuId === provider.id ? (
                    <div
                      className="profile-more"
                      role="group"
                      aria-label={`更多操作 ${provider.displayName}`}
                    >
                      {provider.active ? null : (
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy !== null}
                          onClick={() => void onActivate(provider)}
                        >
                          设为使用中
                        </button>
                      )}
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`编辑提供商 ${provider.displayName}`}
                        disabled={busy !== null}
                        onClick={() => {
                          setCredentialEditing(null)
                          setManageModelsId(null)
                          setMoreMenuId(null)
                          setEditingProviderId(
                            editingProviderId === provider.id ? null : provider.id
                          )
                        }}
                      >
                        编辑连接
                      </button>
                      <button
                        type="button"
                        className="link-button is-danger"
                        aria-label={`删除提供商 ${provider.displayName}`}
                        disabled={busy !== null}
                        onClick={() => {
                          setMoreMenuId(null)
                          setConfirmDelete(provider.id)
                        }}
                      >
                        删除
                      </button>
                    </div>
                  ) : null}

                  {issue === null ? null : (
                    <div className="profile-issue" role="alert" data-credential-issue="true">
                      <p className="profile-issue-reason">{issue}</p>
                      <div className="profile-repair-actions">
                        {credentialRepairs(provider).map((kind) => (
                          <button
                            key={kind}
                            type="button"
                            className="button button-small"
                            disabled={busy !== null}
                            onClick={() => handleRepair(kind, provider)}
                          >
                            {REPAIR_LABEL[kind]}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {failure === null ? null : (
                    <div
                      className="profile-test-failure"
                      role="alert"
                      data-provider-test-failure={provider.id}
                    >
                      <p className="profile-test-reason">
                        {providerTestFailureText(failure.result)}
                      </p>
                      <div className="profile-repair-actions">
                        {providerTestRepairs(failure.result, provider.authMode).map((kind) => (
                          <button
                            key={kind}
                            type="button"
                            className="button button-small"
                            disabled={busy !== null}
                            onClick={() => handleRepair(kind, provider)}
                          >
                            {REPAIR_LABEL[kind]}
                          </button>
                        ))}
                      </div>
                      {requestId === null ? null : (
                        <DiagnosticRequestId requestId={requestId} />
                      )}
                    </div>
                  )}

                  {credentialEditing?.providerId === provider.id ? (
                    <ProviderCredentialEditor
                      key={`${provider.id}-${credentialEditing.authMode}`}
                      provider={provider}
                      busy={busy !== null}
                      error={credentialError}
                      initialAuthMode={credentialEditing.authMode}
                      onSubmit={(request) => void submitCredential(request)}
                      onCancel={cancelCredentialEdit}
                    />
                  ) : null}

                  {editingProviderId === provider.id ? (
                    <ProviderEditForm
                      provider={provider}
                      refresh={refresh}
                      notify={notify}
                      onClose={() => setEditingProviderId(null)}
                    />
                  ) : null}

                  {manageModelsId === provider.id ? (
                    <ProviderModelEditor
                      provider={provider}
                      refresh={refresh}
                      notify={notify}
                    />
                  ) : null}

                  <details className="profile-details">
                    <summary>连接详情</summary>
                    <dl className="profile-facts">
                      <div>
                        <dt>Provider ID</dt>
                        <dd>
                          <code>{provider.providerKey}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>来源</dt>
                        <dd>{providerSourceText(provider)}</dd>
                      </div>
                      <div>
                        <dt>协议</dt>
                        <dd>{providerProtocolText(provider)}</dd>
                      </div>
                      <div>
                        <dt>接口地址</dt>
                        <dd>
                          <code>{providerBaseUrlText(provider)}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>模型</dt>
                        <dd>
                          <code>{providerModelsText(provider)}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>重试策略</dt>
                        <dd>{retryPolicyText(provider.retryPolicy)}</dd>
                      </div>
                      <div>
                        <dt>密钥</dt>
                        <dd>
                          <code>{keyStateText(provider)}</code>
                        </dd>
                      </div>
                      {provider.envVar === null ? null : (
                        <div>
                          <dt>环境变量</dt>
                          <dd>
                            <code>{provider.envVar}</code>
                          </dd>
                        </div>
                      )}
                    </dl>

                    <p className="profile-check">{checkText(provider)}</p>

                    {provider.lastErrorRequestId === null ||
                    provider.lastErrorRequestId === undefined ||
                    provider.lastErrorRequestId.trim() === '' ? null : (
                      <DiagnosticRequestId requestId={provider.lastErrorRequestId} />
                    )}
                  </details>

                  {confirmDelete === provider.id ? (
                    <div className="profile-confirm">
                      <span>
                        {provider.active
                          ? '删除当前提供商后，需要另选一套才能继续对话。'
                          : '确定删除这套提供商？'}
                      </span>
                      <button
                        type="button"
                        className="button button-danger button-small"
                        disabled={busy !== null}
                        onClick={() => void onDelete(provider)}
                      >
                        确认删除
                      </button>
                      <button
                        type="button"
                        className="button button-small"
                        disabled={busy !== null}
                        onClick={() => setConfirmDelete(null)}
                      >
                        取消
                      </button>
                    </div>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </>
      )}

      <div className="profile-form">
        <h3>添加模型提供商</h3>
        <p className="settings-desc">
          内置服务会自动带好地址与模型，你只需要选提供商、填密钥；自定义 API 也可以自己填。
        </p>

        <div className="settings-segments" role="group" aria-label="添加方式">
          <button
            type="button"
            className="settings-segment"
            aria-pressed={addMode === 'builtin'}
            onClick={() => setAddMode('builtin')}
          >
            内置提供商
          </button>
          <button
            type="button"
            className="settings-segment"
            aria-pressed={addMode === 'custom'}
            onClick={() => setAddMode('custom')}
          >
            自定义 API
          </button>
        </div>

        {addMode === 'builtin' ? (
          <div className="builtin-provider-form" data-add-mode="builtin">
            <label className="settings-field">
              <span>内置提供商</span>
              <select
                aria-label="内置提供商"
                value={catalogId}
                disabled={busy !== null}
                onChange={(event) => {
                  const next = event.target.value as BuiltinProviderId
                  setCatalogId(next)
                  const nextSetup = setups.find((candidate) => candidate.id === next)
                  setAddEnvVar(nextSetup?.envVar ?? '')
                }}
              >
                {setups.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.displayName}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="credential-mode">
              <legend className="settings-field-label">密钥来源</legend>
              <label className="model-option">
                <input
                  type="radio"
                  name="add-auth-mode"
                  value="stored"
                  checked={addAuthMode === 'stored'}
                  disabled={busy !== null}
                  onChange={() => setAddAuthMode('stored')}
                />
                <span>保存在本机</span>
              </label>
              <label className="model-option">
                <input
                  type="radio"
                  name="add-auth-mode"
                  value="env"
                  checked={addAuthMode === 'env'}
                  disabled={busy !== null}
                  onChange={() => setAddAuthMode('env')}
                />
                <span>使用环境变量</span>
              </label>
            </fieldset>

            {addAuthMode === 'env' ? (
              <>
                <label className="settings-field">
                  <span>环境变量名</span>
                  <input
                    type="text"
                    aria-label="环境变量名"
                    autoComplete="off"
                    spellCheck={false}
                    value={addEnvVar}
                    placeholder={setup?.envVar ?? 'MY_PROVIDER_KEY'}
                    disabled={busy !== null}
                    onChange={(event) => setAddEnvVar(event.target.value)}
                  />
                </label>
                <p className="field-hint">
                  {`使用环境变量 ${
                    addEnvVar.trim() === '' ? (setup?.envVar ?? '') : addEnvVar.trim()
                  }，本机不会保存密钥。`}
                </p>
              </>
            ) : (
              <label className="settings-field">
                <span>API 密钥</span>
                <input
                  type="password"
                  aria-label="API 密钥"
                  autoComplete="off"
                  spellCheck={false}
                  value={apiKey}
                  disabled={busy !== null}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </label>
            )}

            {setup === undefined ? null : (
              <details className="add-connection-details">
                <summary>查看连接详情</summary>
                <dl className="profile-facts builtin-preview">
                  <div>
                    <dt>显示名</dt>
                    <dd>{setup.displayName}</dd>
                  </div>
                  <div>
                    <dt>接口地址</dt>
                    <dd>
                      <code>
                        {providerBaseUrlText({
                          baseUrl: setup.baseUrl,
                          catalogProviderId: setup.id
                        })}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>协议</dt>
                    <dd>
                      {providerProtocolText({
                        protocol: setup.protocol,
                        catalogProviderId: setup.id
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>模型目录</dt>
                    <dd>
                      <code>
                        {isAggregateModelProvider({ catalogProviderId: setup.id })
                          ? `${setup.models.length} 个模型，各自带协议与地址`
                          : setup.models.map((model) => model.id).join('、')}
                      </code>
                    </dd>
                  </div>
                  <div>
                    <dt>Provider ID</dt>
                    <dd>
                      <code>
                        保存后分配：{setup.id}、{setup.id}-2 …（唯一且不可改）
                      </code>
                    </dd>
                  </div>
                </dl>
              </details>
            )}

            {formError === null ? null : (
              <p className="field-error" role="alert">
                {formError}
              </p>
            )}

            <div className="settings-actions">
              <button
                type="button"
                className="button"
                disabled={busy !== null}
                onClick={() => void onAdd()}
              >
                保存提供商
              </button>
            </div>
          </div>
        ) : (
          <CustomProviderForm
            existingProviderKeys={overview.providers.map(
              (provider) => provider.providerKey
            )}
            refresh={refresh}
          />
        )}
      </div>
    </section>
  )
}
