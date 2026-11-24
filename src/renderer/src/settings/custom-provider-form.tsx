import { useState } from 'react'
import type { FetchedModelCandidate } from '../../../shared/model-discovery'
import {
  MODEL_PROTOCOL_LABELS,
  MODEL_PROTOCOLS
} from '../../../shared/model-protocols'
import type { ProviderProtocol } from '../../../shared/model-providers'
import {
  isValidEnvVarName,
  type ProviderCredentialDraft
} from '../../../shared/provider-credentials'
import { createCustomProvider, testProviderConnection } from '../api'
import { showToast } from '../components/toast-store'
import { failureText } from '../errors'
import {
  CredentialEditor,
  emptyCredentialDraft
} from './credential-editor'
import {
  combineCustomProviderModels
} from './model-discovery'
import { ModelDiscoveryPanel } from './model-discovery-panel'
import { providerTestFailureText, providerTestVerifiedText } from './format'
import { credentialRejectionText } from './messages'
import {
  baseUrlError,
  customProviderErrorText,
  displayNameError,
  modelDirectoryHint,
  openCustomProtocolsText,
  providerIdError
} from './provider-editing'

type FieldErrors = {
  providerId: string | null
  displayName: string | null
  baseUrl: string | null
  modelId: string | null
}

const NO_ERRORS: FieldErrors = {
  providerId: null,
  displayName: null,
  baseUrl: null,
  modelId: null
}

type CustomProviderFormProps = {
  existingProviderKeys: readonly string[]
  refresh: () => Promise<void>
}

/**
 * 「自定义模型 API」入口：手填 Provider ID、显示名、协议、地址、密钥与首个模型。
 *
 * 表单只做即时字段提示；Provider ID 的唯一性、精确 regex、协议接受范围与
 * 「至少一个模型」仍由主进程再校验一次。协议选项由共享协议表生成，四种协议
 * 当前都可用；这里不再保留「后续版本」占位，也不另抄一份协议清单。
 */
export function CustomProviderForm({
  existingProviderKeys,
  refresh
}: CustomProviderFormProps) {
  const [providerId, setProviderId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [protocol, setProtocol] = useState<ProviderProtocol>('openai-completions')
  const [baseUrl, setBaseUrl] = useState('')
  const [credential, setCredential] = useState<ProviderCredentialDraft>(emptyCredentialDraft())
  const [modelId, setModelId] = useState('')
  const [selectedFetched, setSelectedFetched] = useState<FetchedModelCandidate[]>([])
  const [discoveryReset, setDiscoveryReset] = useState(0)
  const [errors, setErrors] = useState<FieldErrors>(NO_ERRORS)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const modelHint = modelDirectoryHint(
    { source: 'custom', catalogProviderId: null, protocol },
    modelId
  )
  const draftModels = combineCustomProviderModels(modelId, selectedFetched)

  function validate(): FieldErrors {
    return {
      providerId: providerIdError(providerId, existingProviderKeys),
      displayName: displayNameError(displayName),
      baseUrl: baseUrlError(baseUrl),
      // 手填首个模型可留空：勾选了候选也算至少一个模型；合并时按 ID 去重。
      modelId:
        draftModels.length === 0
          ? '先填模型 ID，或先获取可用模型并勾选至少一个。'
          : null
    }
  }

  async function onSave(): Promise<void> {
    const next = validate()
    setErrors(next)
    setFormError(null)
    if (Object.values(next).some((message) => message !== null)) {
      return
    }
    // 环境模式先做一次即时提示；主进程仍会再校验。文案与凭据编辑共用一份。
    if (credential.authMode === 'env' && !isValidEnvVarName(credential.envVar)) {
      setFormError(credentialRejectionText('invalid-env-var'))
      return
    }

    setBusy(true)
    try {
      const first = draftModels[0]
      if (first === undefined) {
        setErrors({ ...NO_ERRORS, modelId: '至少要有一个模型才能保存。' })
        return
      }
      const result = await createCustomProvider({
        providerKey: providerId.trim(),
        displayName: displayName.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        authMode: credential.authMode,
        envVar: credential.envVar,
        apiKey: credential.apiKey,
        // 首个模型 + 勾选候选在同一笔事务里写入，保存前绝不先建 provider 再补模型。
        model: first,
        ...(draftModels.length > 1 ? { additionalModels: draftModels.slice(1) } : {})
      })
      if (result.status === 'rejected') {
        const message = customProviderErrorText(result.reason)
        if (result.reason === 'invalid-provider-id' || result.reason === 'duplicate-provider-id') {
          setErrors({ ...NO_ERRORS, providerId: message })
        } else if (result.reason === 'missing-display-name') {
          setErrors({ ...NO_ERRORS, displayName: message })
        } else if (
          result.reason === 'missing-base-url' ||
          result.reason === 'invalid-base-url'
        ) {
          setErrors({ ...NO_ERRORS, baseUrl: message })
        } else if (
          result.reason === 'missing-model' ||
          result.reason === 'duplicate-model-id' ||
          result.reason === 'invalid-capacity'
        ) {
          setErrors({ ...NO_ERRORS, modelId: message })
        } else {
          setFormError(message)
        }
        return
      }

      const savedName = displayName.trim()
      setProviderId('')
      setDisplayName('')
      setBaseUrl('')
      setCredential(emptyCredentialDraft())
      setModelId('')
      setSelectedFetched([])
      setDiscoveryReset((current) => current + 1)
      setErrors(NO_ERRORS)
      await refresh()
      showToast({
        message: `已保存自定义提供商「${savedName}」`,
        action: {
          label: '立即测试连接',
          run: async () => {
            const tested = await testProviderConnection({
              providerId: result.providerId
            })
            // 保存后立刻删除时，迟到结果不写回任何状态。
            if (tested.status === 'missing') {
              return
            }
            if (tested.status === 'verified') {
              showToast({
                message: `「${savedName}」${providerTestVerifiedText(tested)}`
              })
              return
            }
            showToast({
              message: `「${savedName}」${providerTestFailureText(tested)}`,
              tone: 'error'
            })
          },
          failureMessage: '测试连接没有完成，再试一次。'
        }
      })
    } catch (error) {
      setFormError(failureText(error, '自定义提供商没有保存成功，再试一次。'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="custom-provider-form" data-custom-provider-form="true">
      <h3>自定义模型 API</h3>
      <p className="settings-desc">
        填写服务信息，并至少添加一个模型。Provider ID 与协议创建后不可改。
      </p>

      <label className="settings-field">
        <span>Provider ID</span>
        <input
          aria-label="Provider ID"
          autoComplete="off"
          spellCheck={false}
          value={providerId}
          disabled={busy}
          placeholder="my-relay"
          onChange={(event) => {
            setProviderId(event.target.value)
            setErrors((current) => ({ ...current, providerId: null }))
            setFormError(null)
          }}
        />
      </label>
      {errors.providerId === null ? (
        <p className="field-hint">
          小写字母开头，只用小写字母、数字和单个连字符；唯一且创建后不可改。
        </p>
      ) : (
        <p className="field-error" role="alert" data-field-error="provider-id">
          {errors.providerId}
        </p>
      )}

      <label className="settings-field">
        <span>显示名</span>
        <input
          aria-label="显示名"
          autoComplete="off"
          value={displayName}
          disabled={busy}
          placeholder="我的中转"
          onChange={(event) => {
            setDisplayName(event.target.value)
            setErrors((current) => ({ ...current, displayName: null }))
            setFormError(null)
          }}
        />
      </label>
      {errors.displayName === null ? null : (
        <p className="field-error" role="alert" data-field-error="display-name">
          {errors.displayName}
        </p>
      )}

      <label className="settings-field">
        <span>协议</span>
        <select
          aria-label="协议"
          value={protocol}
          disabled={busy}
          onChange={(event) => setProtocol(event.target.value as ProviderProtocol)}
        >
          {MODEL_PROTOCOLS.map((value) => (
            <option key={value} value={value}>
              {MODEL_PROTOCOL_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <p className="field-hint">
        当前可用协议：{openCustomProtocolsText()}。
      </p>

      <label className="settings-field">
        <span>接口地址</span>
        <input
          aria-label="自定义接口地址"
          autoComplete="off"
          spellCheck={false}
          value={baseUrl}
          disabled={busy}
          placeholder="https://relay.example.com/v1"
          onChange={(event) => {
            setBaseUrl(event.target.value)
            setErrors((current) => ({ ...current, baseUrl: null }))
            setFormError(null)
          }}
        />
      </label>
      {errors.baseUrl === null ? null : (
        <p className="field-error" role="alert" data-field-error="base-url">
          {errors.baseUrl}
        </p>
      )}

      <CredentialEditor
        idPrefix="custom-provider-credential"
        value={credential}
        onChange={setCredential}
        apiKeyLabel="自定义 API 密钥"
        keyHint="可以先留空，使用前再填写密钥。"
        disabled={busy}
      />

      <label className="settings-field">
        <span>首个模型（可留空）</span>
        <input
          aria-label="首个模型 ID"
          autoComplete="off"
          spellCheck={false}
          value={modelId}
          disabled={busy}
          placeholder="relay-model；也可以先获取并勾选候选"
          onChange={(event) => {
            setModelId(event.target.value)
            setErrors((current) => ({ ...current, modelId: null }))
            setFormError(null)
          }}
        />
      </label>
      {errors.modelId === null ? (
        modelHint === '' ? (
          <p className="field-hint">
            手填可留空；勾选下面的候选后直接保存，首个勾选项会作为默认模型。
          </p>
        ) : (
          <p className="field-hint model-add-hint" data-model-hint="custom">
            {modelHint}
          </p>
        )
      ) : (
        <p className="field-error" role="alert" data-field-error="first-model">
          {errors.modelId}
        </p>
      )}

      <ModelDiscoveryPanel
        source="custom"
        catalogProviderId={null}
        providerId={null}
        protocol={protocol}
        baseUrl={baseUrl}
        credential={credential}
        onCredentialChange={setCredential}
        showCredentialFields={false}
        knownModelIds={modelId.trim() === '' ? [] : [modelId.trim()]}
        onDraftSelectionChange={(selected) => {
          setSelectedFetched([...selected])
          if (selected.length > 0) {
            setErrors((current) => ({ ...current, modelId: null }))
          }
        }}
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
          保存自定义提供商
        </button>
      </div>
    </div>
  )
}
