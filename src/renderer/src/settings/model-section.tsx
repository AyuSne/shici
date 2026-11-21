import { useState } from 'react'
import type {
  ModelProviderSummary,
  ProviderAuthMode
} from '../../../shared/model-providers'
import { listBuiltinProviderSetups, type BuiltinProviderId } from '../../../shared/model-builtin'
import { MODEL_PROTOCOL_LABELS } from '../../../shared/model-protocols'
import type { UpdateProviderCredentialRequest } from '../../../shared/provider-credentials'
import type { SettingsOverview } from '../../../shared/settings'
import {
  activateProvider,
  addBuiltinProvider,
  deleteProvider,
  loadSettingsOverview,
  updateProviderCredential
} from '../api'
import { failureText } from '../errors'
import { ProviderCredentialEditor } from './credential-editor'
import { CustomProviderForm } from './custom-provider-form'
import {
  checkText,
  credentialIssueText,
  keyStateText,
  providerBaseUrlText,
  providerModelsText,
  providerProtocolText,
  providerSourceText,
  verificationText
} from './format'
import { credentialRejectionText } from './messages'
import { ProviderEditForm } from './provider-edit-form'
import { ProviderModelEditor } from './provider-model-editor'

type ModelSectionProps = {
  overview: SettingsOverview
  onChange: (overview: SettingsOverview) => void
  notify: (message: string) => void
}

/**
 * 模型服务：内置目录（由 `listBuiltinProviderSetups()` 决定当前开放哪些）
 * 与自定义 API 两条添加路径。
 *
 * - 卡片可切换、编辑显示名/地址、删除，并在卡片内直接编辑模型目录；
 * - 模型目录支持手加、行内编辑、删除、默认模型单选、拖拽与上移/下移排序，
 *   内置与自定义 provider 都可用；OpenCode GO 的聚合目录首版只读；
 * - 保存不联网：填完密钥立即落库，状态是「未验证」；真正成功生成一次后才转「已验证」。
 *   获取可用模型是卡片里的显式动作：只读返回候选，勾选后再显式加入，不自动保存；
 *   测试连接留给后续票，不在本票入口里。
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
  const [credentialEditingId, setCredentialEditingId] = useState<string | null>(null)
  const [credentialError, setCredentialError] = useState<string | null>(null)

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
      await refresh()
      notify(
        addAuthMode === 'env'
          ? `已保存 ${setup.displayName}（使用环境变量）；未验证（保存时不联网）`
          : `已保存 ${setup.displayName}；未验证（保存时不联网）`
      )
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
      notify(`之后的对话会使用「${provider.displayName}」`)
    })
  }

  function onDelete(provider: ModelProviderSummary): Promise<void> {
    return run(`delete-${provider.id}`, async () => {
      const result = await deleteProvider({ providerId: provider.id })
      setConfirmDelete(null)
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

  function startCredentialEdit(provider: ModelProviderSummary): void {
    // 卡片内同时只开一个编辑面板，避免两个表单抢同一块位置。
    setEditingProviderId(null)
    setCredentialEditingId(provider.id)
    setCredentialError(null)
  }

  function cancelCredentialEdit(): void {
    setCredentialEditingId(null)
    setCredentialError(null)
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
          ? '已清除本机已存密钥；历史线程与钉住不受影响'
          : result.authMode === 'env'
            ? '已保存环境变量设置；本机不保存密文'
            : '已更新本机密钥；历史线程与钉住不受影响'
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
      <p className="settings-desc">
        {`从内置目录添加 ${builtinNames}，或自定义一套模型 API。内置入口自动带出地址、环境变量名与模型目录；单协议入口可改模型目录，也能用「获取可用模型」从当前地址与密钥取回候选、勾选后再加入。OpenCode GO 是聚合入口：协议与地址按模型给，目录首版只读，只能搜索与选默认模型。保存只写本机，不联网校验；真正生成成功一次后才标「已验证」。`}
      </p>

      {overview.providers.length === 0 ? (
        <p className="settings-empty">
          还没有模型提供商。从下面的内置目录选一家开始，或自定义一套 API；也可以先用环境变量。
        </p>
      ) : (
        <>
          {noActiveProvider ? (
            <p className="settings-hint is-warning">
              现在没有使用中的提供商。选一套点「使用这个」，之后的对话才会用它。
            </p>
          ) : null}
          <ul className="profile-list">
            {overview.providers.map((provider) => (
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
                  <span className="profile-chip">{providerSourceText(provider)}</span>
                  <div className="profile-actions">
                    {provider.active ? null : (
                      <button
                        type="button"
                        className="link-button"
                        disabled={busy !== null}
                        onClick={() => void onActivate(provider)}
                      >
                        使用这个
                      </button>
                    )}
                    <button
                      type="button"
                      className="link-button"
                      aria-label={`编辑提供商 ${provider.displayName}`}
                      disabled={busy !== null}
                      onClick={() => {
                        setCredentialEditingId(null)
                        setEditingProviderId(
                          editingProviderId === provider.id ? null : provider.id
                        )
                      }}
                    >
                      编辑
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
                      className="link-button is-danger"
                      disabled={busy !== null}
                      onClick={() => setConfirmDelete(provider.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>

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

                {credentialIssueText(provider) === null ? null : (
                  <p className="field-error" role="alert">
                    {credentialIssueText(provider)}
                  </p>
                )}

                {credentialEditingId === provider.id ? (
                  <ProviderCredentialEditor
                    provider={provider}
                    busy={busy !== null}
                    error={credentialError}
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

                <ProviderModelEditor
                  provider={provider}
                  refresh={refresh}
                  notify={notify}
                />

                <p className="profile-check">{checkText(provider)}</p>

                {confirmDelete === provider.id ? (
                  <div className="profile-confirm">
                    <span>
                      {provider.active
                        ? '这是使用中的提供商。删除后会清空使用中选择，之后的对话要先另选一套；历史线程与钉住不受影响。'
                        : '删除这套提供商？历史线程与钉住不受影响。'}
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
            ))}
          </ul>
        </>
      )}

      <div className="profile-form">
        <h3>添加模型提供商</h3>
        <p className="settings-desc">
          内置目录自动带出地址与模型；自定义 API 由你自己填 Provider ID、协议与地址。
          保存时不联网，断网也能存成「未验证」。密钥可以加密存在本机，也可以只引用环境变量。
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

            {setup === undefined ? null : (
              <dl className="profile-facts builtin-preview">
                <div>
                  <dt>接口地址</dt>
                  <dd>
                    <code>
                      {setup.baseUrl ?? '按模型给（无统一地址）'}
                    </code>
                  </dd>
                </div>
                <div>
                  <dt>协议</dt>
                  <dd>
                    {setup.protocol === null ? '按模型混合' : MODEL_PROTOCOL_LABELS[setup.protocol]}
                  </dd>
                </div>
                <div>
                  <dt>环境变量</dt>
                  <dd>
                    <code>{setup.envVar}</code>
                  </dd>
                </div>
                <div>
                  <dt>模型目录</dt>
                  <dd>
                    <code>
                      {setup.protocol === null
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
            )}

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
              {addAuthMode === 'env'
                ? `只从环境变量 ${addEnvVar.trim() === '' ? (setup?.envVar ?? '') : addEnvVar.trim()} 读取，不加密、不写入本机。`
                : '环境变量名可改；现在存本机，切到环境变量时再用这个名字。'}
            </p>

            {addAuthMode === 'stored' ? (
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
            ) : null}

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
              <span className="settings-hint">
                保存后仍是未验证；成功对话一次会自动转已验证。
              </span>
            </div>
          </div>
        ) : (
          <CustomProviderForm
            existingProviderKeys={overview.providers.map(
              (provider) => provider.providerKey
            )}
            refresh={refresh}
            notify={notify}
          />
        )}
      </div>
    </section>
  )
}
