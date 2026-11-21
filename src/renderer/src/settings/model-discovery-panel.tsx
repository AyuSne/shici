import { useEffect, useState } from 'react'
import type { FetchedModelCandidate } from '../../../shared/model-discovery'
import type { ProviderProtocol } from '../../../shared/model-providers'
import type { ProviderCredentialDraft } from '../../../shared/provider-credentials'
import { fetchProviderModels } from '../api'
import { failureText } from '../errors'
import { CredentialEditor } from './credential-editor'
import { modelCapacityText, modelThinkingText } from './format'
import {
  discoveryFailureText,
  discoverySourceHint,
  selectedCandidates,
  toggleSelectedModelId
} from './model-discovery'

export type ModelDiscoveryPanelProps = {
  /** 内置身份返回本地目录（零 HTTP）；自定义按当前地址请求。 */
  source: 'builtin' | 'custom'
  catalogProviderId: string | null
  /** 只有明确编辑同一套自定义 provider 时才用于复用已存密钥。 */
  providerId: string | null
  protocol: ProviderProtocol | null
  /** 同一编辑表单里当前（可能尚未保存）的地址。 */
  baseUrl: string
  /** 当前（可能尚未保存）的密钥来源草稿。 */
  credential: ProviderCredentialDraft
  onCredentialChange: (next: ProviderCredentialDraft) => void
  /**
   * 新建自定义表单已经在上方渲染凭据输入；已有 provider 的编辑面板
   * 由这里补一块「用哪把密钥获取」，与保存凭据仍然分开。
   */
  showCredentialFields: boolean
  defaultEnvVar?: string
  hasStoredKey?: boolean
  storedKeyUnreadable?: boolean
  /** 已经在目录/草稿里的模型：主进程返回候选时会排除它们。 */
  knownModelIds: readonly string[]
  /** 已有 provider：显式把勾选结果一次事务加入目录。 */
  onApply?: (candidates: readonly FetchedModelCandidate[]) => Promise<void>
  /** 新建草稿：勾选变化时把选中候选交给父组件，保存时才入库。 */
  onDraftSelectionChange?: (candidates: readonly FetchedModelCandidate[]) => void
  /** OpenCode GO 这类只读目录：可获取查看，但不能加入。 */
  readOnly?: boolean
  /** 父组件保存/应用成功后递增，清空候选与勾选。 */
  resetToken?: number
  disabled?: boolean
}

/**
 * 设置卡片/新建表单里的「获取可用模型」。
 *
 * 获取与勾选都不写库：候选只活在这个面板里，勾选只改变本地列表。已有 provider
 * 要再点「加入所选模型」才由父组件一次事务追加；新建自定义 provider 则要等
 * 「保存自定义提供商」时与 provider 同一笔事务写入。失败只给原因，不动已有目录。
 */
export function ModelDiscoveryPanel({
  source,
  catalogProviderId,
  providerId,
  protocol,
  baseUrl,
  credential,
  onCredentialChange,
  showCredentialFields,
  defaultEnvVar = '',
  hasStoredKey = false,
  storedKeyUnreadable = false,
  knownModelIds,
  onApply,
  onDraftSelectionChange,
  readOnly = false,
  resetToken = 0,
  disabled = false
}: ModelDiscoveryPanelProps) {
  const [candidates, setCandidates] = useState<FetchedModelCandidate[] | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [fetching, setFetching] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setCandidates(null)
    setSelectedIds([])
    setError(null)
  }, [resetToken])

  const busy = disabled || fetching || applying
  const selected = candidates === null ? [] : selectedCandidates(candidates, selectedIds)

  async function onFetch(): Promise<void> {
    if (fetching || applying) {
      return
    }
    setFetching(true)
    setError(null)
    try {
      const result = await fetchProviderModels({
        source,
        catalogProviderId,
        providerId,
        protocol,
        baseUrl,
        authMode: credential.authMode,
        envVar: credential.envVar,
        apiKey: credential.apiKey,
        knownModelIds: [...knownModelIds]
      })
      if (result.status === 'rejected') {
        setError(discoveryFailureText(result))
        return
      }
      setCandidates(result.candidates)
      setSelectedIds([])
      onDraftSelectionChange?.([])
    } catch (caught) {
      setError(failureText(caught, '获取可用模型没有完成，再试一次。'))
    } finally {
      setFetching(false)
    }
  }

  function onToggle(modelId: string): void {
    const next = toggleSelectedModelId(selectedIds, modelId)
    setSelectedIds(next)
    setError(null)
    onDraftSelectionChange?.(selectedCandidates(candidates ?? [], next))
  }

  async function onApplySelected(): Promise<void> {
    if (onApply === undefined || selected.length === 0 || applying) {
      return
    }
    setApplying(true)
    setError(null)
    try {
      await onApply(selected)
      setCandidates((current) =>
        current === null
          ? null
          : current.filter(
              (candidate) => !selected.some((chosen) => chosen.modelId === candidate.modelId)
            )
      )
      setSelectedIds([])
      onDraftSelectionChange?.([])
    } catch (caught) {
      setError(
        caught instanceof Error && caught.message !== ''
          ? caught.message
          : '所选模型没有加入成功，再试一次。'
      )
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="model-discovery" data-model-discovery="true">
      <div className="model-discovery-head">
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          onClick={() => void onFetch()}
        >
          获取可用模型
        </button>
        <span className="settings-hint" aria-live="polite">
          {fetching ? '正在获取…' : candidateCountText(candidates)}
        </span>
      </div>
      <p className="field-hint">{discoverySourceHint(source)}</p>

      {showCredentialFields ? (
        <>
          <p className="settings-field-label">获取时使用的密钥 · 只读，不改已保存凭据</p>
          <CredentialEditor
            idPrefix={`discovery-${providerId ?? 'provider'}`}
            value={credential}
            onChange={onCredentialChange}
            hasStoredKey={hasStoredKey}
            storedKeyUnreadable={storedKeyUnreadable}
            defaultEnvVar={defaultEnvVar}
            disabled={busy}
          />
        </>
      ) : null}

      {error === null ? null : (
        <p className="field-error" role="alert" data-discovery-error="true">
          {error}
        </p>
      )}

      {candidates === null ? null : candidates.length === 0 ? (
        <p className="settings-hint" data-discovery-empty="true">
          没有可加入的新模型。
        </p>
      ) : (
        <ul className="model-options discovery-candidates" aria-label="可用模型候选">
          {candidates.map((candidate) => (
            <li key={candidate.modelId} data-discovery-candidate={candidate.modelId}>
              <label className="model-option">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(candidate.modelId)}
                  disabled={busy || readOnly}
                  aria-label={`选择模型 ${candidate.modelId}`}
                  onChange={() => onToggle(candidate.modelId)}
                />
                <code className="model-id">{candidate.modelId}</code>
                {candidate.displayName === candidate.modelId ? null : (
                  <span className="model-display">{candidate.displayName}</span>
                )}
                <span className="model-meta">
                  {modelCapacityText(candidate)} · {modelThinkingText(candidate)}
                </span>
                <span className={source === 'builtin' ? 'model-chip' : 'model-chip is-fetched'}>
                  {source === 'builtin' ? '本地目录' : '获取'}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {onApply !== undefined ? (
        <div className="settings-actions">
          <button
            type="button"
            className="button button-small"
            disabled={busy || readOnly || selected.length === 0}
            onClick={() => void onApplySelected()}
          >
            加入所选模型
          </button>
          <span className="settings-hint" data-discovery-apply-hint="true">
            {readOnly
              ? 'OpenCode GO 的模型目录首版只读：可以获取查看，不能加入。'
              : selected.length === 0
                ? '先勾选要加入目录的模型；获取和勾选都不会自动保存。'
                : `已选 ${selected.length} 个；加入后追加到目录末尾，不改已有模型、默认模型与顺序。`}
          </span>
        </div>
      ) : selected.length === 0 ? null : (
        <p className="field-hint" data-discovery-draft-hint="true">
          已选 {selected.length} 个模型；保存提供商时一起写入，现在还没入库。
        </p>
      )}
    </div>
  )
}

function candidateCountText(candidates: readonly FetchedModelCandidate[] | null): string {
  if (candidates === null) {
    return '还没获取。'
  }
  return candidates.length === 0 ? '没有候选。' : `共 ${candidates.length} 个候选。`
}
