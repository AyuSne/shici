import { useState } from 'react'
import {
  MODEL_PROTOCOLS,
  isCustomProviderProtocol
} from '../../../shared/model-protocols'
import type { ProviderProtocol } from '../../../shared/model-providers'
import {
  isValidEnvVarName,
  type ProviderCredentialDraft
} from '../../../shared/provider-credentials'
import { createCustomProvider } from '../api'
import { failureText } from '../errors'
import {
  CredentialEditor,
  emptyCredentialDraft
} from './credential-editor'
import {
  baseUrlError,
  customProviderErrorText,
  displayNameError,
  modelDirectoryHint,
  modelIdError,
  protocolOptionLabel,
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
  notify: (message: string) => void
}

/**
 * 「自定义模型 API」入口：手填 Provider ID、显示名、协议、地址、密钥与首个模型。
 *
 * 表单只做即时字段提示；Provider ID 的唯一性、精确 regex、协议开放范围与
 * 「至少一个模型」仍由主进程再校验一次。协议选项由共享协议表生成，
 * 本票未开放的协议显示为「后续版本」并禁用，不在界面另抄一份协议清单。
 */
export function CustomProviderForm({
  existingProviderKeys,
  refresh,
  notify
}: CustomProviderFormProps) {
  const [providerId, setProviderId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [protocol, setProtocol] = useState<ProviderProtocol>('openai-completions')
  const [baseUrl, setBaseUrl] = useState('')
  const [credential, setCredential] = useState<ProviderCredentialDraft>(emptyCredentialDraft())
  const [modelId, setModelId] = useState('')
  const [errors, setErrors] = useState<FieldErrors>(NO_ERRORS)
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const modelHint = modelDirectoryHint(
    { source: 'custom', catalogProviderId: null, protocol },
    modelId
  )

  function validate(): FieldErrors {
    return {
      providerId: providerIdError(providerId, existingProviderKeys),
      displayName: displayNameError(displayName),
      baseUrl: baseUrlError(baseUrl),
      modelId: modelIdError(modelId, [])
    }
  }

  async function onSave(): Promise<void> {
    const next = validate()
    setErrors(next)
    setFormError(null)
    if (Object.values(next).some((message) => message !== null)) {
      return
    }
    // 环境模式先做一次即时提示；主进程仍会再校验。
    if (credential.authMode === 'env' && !isValidEnvVarName(credential.envVar)) {
      setFormError('环境变量名要字母或下划线开头，只含字母、数字与下划线。')
      return
    }

    setBusy(true)
    try {
      const result = await createCustomProvider({
        providerId: providerId.trim(),
        displayName: displayName.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        authMode: credential.authMode,
        envVar: credential.envVar,
        apiKey: credential.apiKey,
        model: { modelId: modelId.trim() }
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
        } else if (result.reason === 'missing-model') {
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
      setErrors(NO_ERRORS)
      await refresh()
      notify(
        credential.authMode === 'env'
          ? `已保存自定义提供商「${savedName}」（使用环境变量）；未验证（保存时不联网）`
          : `已保存自定义提供商「${savedName}」；未验证（保存时不联网）`
      )
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
        填 Provider ID、显示名、协议、地址与密钥，并至少带一个模型。Provider ID
        与协议创建后不可改；保存只写本机，不联网校验。
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
            <option
              key={value}
              value={value}
              disabled={!isCustomProviderProtocol(value)}
            >
              {protocolOptionLabel(value)}
            </option>
          ))}
        </select>
      </label>
      <p className="field-hint">本票只开放 OpenAI Chat Completions，其余协议后续开放。</p>

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
        keyHint="留空表示这个地址不需要密钥（自部署 / 本地中转）；密钥只经系统密钥库加密保存。"
        disabled={busy}
      />
      <p className="field-hint">
        环境变量模式不写密文；切回本机或更换来源时由主进程按确认规则处理。
      </p>

      <label className="settings-field">
        <span>首个模型</span>
        <input
          aria-label="首个模型 ID"
          autoComplete="off"
          spellCheck={false}
          value={modelId}
          disabled={busy}
          placeholder="relay-model"
          onChange={(event) => {
            setModelId(event.target.value)
            setErrors((current) => ({ ...current, modelId: null }))
            setFormError(null)
          }}
        />
      </label>
      {errors.modelId === null ? (
        modelHint === '' ? (
          <p className="field-hint">自定义 provider 至少要有一个模型才能保存。</p>
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

      {formError === null ? null : (
        <p className="field-error" role="alert">
          {formError}
        </p>
      )}

      <div className="settings-actions">
        <button type="button" className="button" disabled={busy} onClick={() => void onSave()}>
          保存自定义提供商
        </button>
        <span className="settings-hint">保存后仍是未验证；成功对话一次会自动转已验证。</span>
      </div>
    </div>
  )
}
