import { useState, type DragEvent } from 'react'
import {
  isAggregateModelProvider,
  isModelDirectoryReadOnly
} from '../../../shared/model-directory'
import type { ModelProviderModelSummary, ModelProviderSummary } from '../../../shared/model-providers'
import {
  addProviderModel,
  deleteProviderModel,
  reorderProviderModels,
  setDefaultProviderModel,
  updateProviderModel
} from '../api'
import { failureText } from '../errors'
import { modelMetaText, protocolText } from './format'
import { readOnlyDirectoryHint } from './messages'
import {
  filterModelsByQuery,
  modelDirectoryHint,
  modelIdError,
  modelInDirectory,
  modelWriteErrorText,
  moveModelId,
  parseCapacity
} from './provider-editing'

type ProviderModelEditorProps = {
  provider: ModelProviderSummary
  refresh: () => Promise<void>
  notify: (message: string) => void
}

type EditDraft = {
  modelId: string
  displayName: string
  contextWindow: string
  maxTokens: string
  reasoning: boolean
}

/**
 * 单协议 provider 的模型目录编辑器：默认模型单选、手加模型、编辑、删除、
 * 拖拽排序与可键盘操作的上移/下移按钮。所有写入立即落库（排序即保存顺序），
 * 未知模型 ID 明确标「不在目录」，但仍可加入与发送。
 */
export function ProviderModelEditor({
  provider,
  refresh,
  notify
}: ProviderModelEditorProps) {
  const models = provider.models
  const modelIds = models.map((model) => model.modelId)
  const readOnly = isModelDirectoryReadOnly(provider)
  const aggregate = isAggregateModelProvider(provider)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [addModelId, setAddModelId] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<EditDraft | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const addHint = modelDirectoryHint(provider, addModelId)
  const searching = query.trim() !== ''
  const visibleModels = filterModelsByQuery(models, query)
  const defaultModel = models.find((model) => model.id === provider.defaultModelRowId)
  const defaultHidden =
    searching &&
    defaultModel !== undefined &&
    !visibleModels.some((model) => model.id === defaultModel.id)

  async function onSetDefault(model: ModelProviderModelSummary): Promise<void> {
    setBusy(`default:${model.id}`)
    setError(null)
    try {
      const result = await setDefaultProviderModel({
        providerId: provider.id,
        modelRowId: model.id
      })
      if (result.status === 'rejected') {
        setError('这个模型已经不在目录里了，刷新后再选。')
        return
      }
      if (result.status === 'missing') {
        setError('这套提供商已经不在了，刷新后再试。')
        return
      }
      await refresh()
      notify('已换默认模型；正在生成的回答不受影响')
    } catch (caught) {
      setError(failureText(caught, '默认模型没有换成，再试一次。'))
    } finally {
      setBusy(null)
    }
  }

  async function onAdd(): Promise<void> {
    const clientError = modelIdError(addModelId, modelIds)
    if (clientError !== null) {
      setAddError(clientError)
      return
    }
    setBusy('add')
    setAddError(null)
    setError(null)
    try {
      const result = await addProviderModel({
        providerId: provider.id,
        model: { modelId: addModelId.trim() }
      })
      if (result.status === 'missing') {
        setError('这套提供商已经不在了，刷新后再试。')
        return
      }
      if (result.status === 'rejected') {
        setAddError(modelWriteErrorText(result.reason))
        return
      }
      const added = addModelId.trim()
      setAddModelId('')
      await refresh()
      notify(`已加入模型 ${added}`)
    } catch (caught) {
      setAddError(failureText(caught, '这个模型没有加入成功，再试一次。'))
    } finally {
      setBusy(null)
    }
  }

  function startEdit(model: ModelProviderModelSummary): void {
    setEditingId(model.id)
    setDraft({
      modelId: model.modelId,
      displayName: model.displayName,
      contextWindow: model.contextWindow === null ? '' : String(model.contextWindow),
      maxTokens: model.maxTokens === null ? '' : String(model.maxTokens),
      reasoning: model.reasoning
    })
    setError(null)
  }

  async function onSaveEdit(): Promise<void> {
    if (editingId === null || draft === null) {
      return
    }
    const otherIds = models
      .filter((model) => model.id !== editingId)
      .map((model) => model.modelId)
    const clientError = modelIdError(draft.modelId, otherIds)
    if (clientError !== null) {
      setError(clientError)
      return
    }
    const contextWindow = parseCapacity(draft.contextWindow)
    const maxTokens = parseCapacity(draft.maxTokens)
    if (contextWindow === 'invalid' || maxTokens === 'invalid') {
      setError(modelWriteErrorText('invalid-capacity'))
      return
    }

    setBusy(`edit:${editingId}`)
    setError(null)
    try {
      const result = await updateProviderModel({
        providerId: provider.id,
        modelRowId: editingId,
        model: {
          modelId: draft.modelId.trim(),
          displayName: draft.displayName.trim(),
          contextWindow,
          maxTokens,
          reasoning: draft.reasoning
        }
      })
      if (result.status === 'missing') {
        setError('这套提供商已经不在了，刷新后再试。')
        return
      }
      if (result.status === 'rejected') {
        setError(modelWriteErrorText(result.reason))
        return
      }
      setEditingId(null)
      setDraft(null)
      await refresh()
      notify('已保存模型；之后的调用按新值发送')
    } catch (caught) {
      setError(failureText(caught, '这个模型没有保存成功，再试一次。'))
    } finally {
      setBusy(null)
    }
  }

  async function onDelete(model: ModelProviderModelSummary): Promise<void> {
    setBusy(`delete:${model.id}`)
    setError(null)
    try {
      const result = await deleteProviderModel({
        providerId: provider.id,
        modelRowId: model.id
      })
      if (result.status === 'missing') {
        setError('这套提供商已经不在了，刷新后再试。')
        return
      }
      if (result.status === 'rejected') {
        setError(modelWriteErrorText(result.reason))
        return
      }
      if (editingId === model.id) {
        setEditingId(null)
        setDraft(null)
      }
      await refresh()
      notify(`已删除模型 ${model.modelId}`)
    } catch (caught) {
      setError(failureText(caught, '这个模型没有删掉，再试一次。'))
    } finally {
      setBusy(null)
    }
  }

  async function move(fromIndex: number, toIndex: number): Promise<void> {
    const current = models.map((model) => model.id)
    const next = moveModelId(current, fromIndex, toIndex)
    if (next === current) {
      return
    }
    setBusy('reorder')
    setError(null)
    try {
      const result = await reorderProviderModels({
        providerId: provider.id,
        modelRowIds: [...next]
      })
      if (result.status === 'missing') {
        setError('这套提供商已经不在了，刷新后再试。')
        return
      }
      if (result.status === 'rejected') {
        setError(modelWriteErrorText(result.reason))
        return
      }
      await refresh()
      notify('已保存模型顺序')
    } catch (caught) {
      setError(failureText(caught, '模型顺序没有保存成功，再试一次。'))
    } finally {
      setBusy(null)
    }
  }

  function onDragStart(event: DragEvent<HTMLLIElement>, index: number): void {
    if (busy !== null) {
      event.preventDefault()
      return
    }
    setDragIndex(index)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', models[index]?.id ?? '')
  }

  function onDragOver(event: DragEvent<HTMLLIElement>, index: number): void {
    if (dragIndex === null || busy !== null) {
      return
    }
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    if (dropIndex !== index) {
      setDropIndex(index)
    }
  }

  function onDrop(event: DragEvent<HTMLLIElement>, index: number): void {
    event.preventDefault()
    const from = dragIndex
    setDragIndex(null)
    setDropIndex(null)
    if (from === null || from === index) {
      return
    }
    void move(from, index)
  }

  return (
    <div className="model-editor">
      <div className="model-picker" role="group" aria-label="默认模型">
        <span className="settings-field-label">
          {readOnly
            ? '模型目录 · 只读；可按 ID 或显示名搜索并选默认模型'
            : '模型目录 · 拖动或用上移/下移排序；默认模型用单选'}
        </span>
        <label className="settings-field model-search">
          <span>搜索模型</span>
          <input
            type="search"
            aria-label="搜索模型"
            placeholder="按模型 ID 或显示名搜索"
            autoComplete="off"
            spellCheck={false}
            value={query}
            disabled={busy !== null}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {models.length === 0 ? (
          <p className="settings-hint">这套提供商还没有模型。</p>
        ) : visibleModels.length === 0 ? (
          <p className="settings-hint" data-model-search-empty="true">
            没有匹配的模型；换一个 ID 或显示名。
          </p>
        ) : (
          <ul className="model-options editable-model-list">
            {visibleModels.map((model) => {
              const index = models.findIndex((candidate) => candidate.id === model.id)
              return (
              <li
                key={model.id}
                data-model-row={model.modelId}
                className={
                  [
                    'model-row',
                    dragIndex === index ? 'is-dragging' : '',
                    dropIndex === index ? 'is-drop-target' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')
                }
                draggable={busy === null && !readOnly && !searching}
                onDragStart={(event) => onDragStart(event, index)}
                onDragOver={(event) => onDragOver(event, index)}
                onDrop={(event) => onDrop(event, index)}
                onDragEnd={() => {
                  setDragIndex(null)
                  setDropIndex(null)
                }}
              >
                <div className="model-row-main">
                  {readOnly ? null : (
                    <span className="model-drag-handle" aria-hidden="true" title="拖动排序">
                      ⠿
                    </span>
                  )}
                  <label className="model-option">
                    <input
                      type="radio"
                      name={`default-model-${provider.id}`}
                      checked={provider.defaultModelRowId === model.id}
                      disabled={busy !== null}
                      onChange={() => void onSetDefault(model)}
                    />
                    <code className="model-id">{model.modelId}</code>
                    {model.displayName === model.modelId ? null : (
                      <span className="model-display">{model.displayName}</span>
                    )}
                    <span className="model-meta">{modelMetaText(model)}</span>
                    {aggregate ? (
                      <span className="model-chip">{protocolText(model.api)}</span>
                    ) : null}
                    {model.source === 'fetched' ? (
                      <span className="model-chip is-fetched">获取</span>
                    ) : null}
                    {modelInDirectory(provider, model.modelId) ? null : (
                      <span className="model-chip is-unknown">不在目录</span>
                    )}
                  </label>
                  {readOnly ? null : (
                    <div className="model-row-actions">
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`上移模型 ${model.modelId}`}
                        disabled={busy !== null || searching || index === 0}
                        onClick={() => void move(index, index - 1)}
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`下移模型 ${model.modelId}`}
                        disabled={busy !== null || searching || index === models.length - 1}
                        onClick={() => void move(index, index + 1)}
                      >
                        下移
                      </button>
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`编辑模型 ${model.modelId}`}
                        disabled={busy !== null}
                        onClick={() => startEdit(model)}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="link-button is-danger"
                        aria-label={`移除模型 ${model.modelId}`}
                        disabled={busy !== null}
                        onClick={() => void onDelete(model)}
                      >
                        删除
                      </button>
                    </div>
                  )}
                </div>

                {editingId === model.id && draft !== null ? (
                  <div className="model-edit-form">
                    <label className="settings-field">
                      <span>模型 ID</span>
                      <input
                        aria-label="编辑模型 ID"
                        spellCheck={false}
                        value={draft.modelId}
                        disabled={busy !== null}
                        onChange={(event) =>
                          setDraft({ ...draft, modelId: event.target.value })
                        }
                      />
                    </label>
                    <label className="settings-field">
                      <span>显示名</span>
                      <input
                        aria-label="编辑模型显示名"
                        value={draft.displayName}
                        disabled={busy !== null}
                        onChange={(event) =>
                          setDraft({ ...draft, displayName: event.target.value })
                        }
                      />
                    </label>
                    <div className="model-edit-capacities">
                      <label className="settings-field">
                        <span>上下文窗口</span>
                        <input
                          aria-label="编辑上下文窗口"
                          inputMode="numeric"
                          placeholder="目录未提供"
                          value={draft.contextWindow}
                          disabled={busy !== null}
                          onChange={(event) =>
                            setDraft({ ...draft, contextWindow: event.target.value })
                          }
                        />
                      </label>
                      <label className="settings-field">
                        <span>最大输出</span>
                        <input
                          aria-label="编辑最大输出"
                          inputMode="numeric"
                          placeholder="目录未提供"
                          value={draft.maxTokens}
                          disabled={busy !== null}
                          onChange={(event) =>
                            setDraft({ ...draft, maxTokens: event.target.value })
                          }
                        />
                      </label>
                      <label className="settings-toggle">
                        <input
                          type="checkbox"
                          aria-label="编辑支持思考"
                          checked={draft.reasoning}
                          disabled={busy !== null}
                          onChange={(event) =>
                            setDraft({ ...draft, reasoning: event.target.checked })
                          }
                        />
                        支持思考
                      </label>
                    </div>
                    <div className="settings-actions">
                      <button
                        type="button"
                        className="button"
                        disabled={busy !== null}
                        onClick={() => void onSaveEdit()}
                      >
                        保存模型
                      </button>
                      <button
                        type="button"
                        className="button"
                        disabled={busy !== null}
                        onClick={() => {
                          setEditingId(null)
                          setDraft(null)
                        }}
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
              )
            })}
          </ul>
        )}
        {defaultHidden ? (
          <p className="settings-hint" data-default-model-hidden="true">
            {`默认模型 ${defaultModel?.modelId ?? ''} 不在当前搜索结果里；清空搜索可看到它的单选。`}
          </p>
        ) : null}
        <p className="settings-hint" data-model-count="true">
          {searching
            ? `匹配 ${visibleModels.length} / ${models.length} 个模型。`
            : `共 ${models.length} 个模型。`}
        </p>
      </div>

      {error === null ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}

      {readOnly ? (
        <p className="settings-hint">{readOnlyDirectoryHint('edit')}</p>
      ) : (
        <div className="model-add-form">
          <label className="settings-field">
            <span>添加模型</span>
            <input
              aria-label="添加模型 ID"
              spellCheck={false}
              autoComplete="off"
              placeholder="模型 ID，例如 deepseek-v4-pro"
              value={addModelId}
              disabled={busy !== null}
              onChange={(event) => {
                setAddModelId(event.target.value)
                setAddError(null)
              }}
            />
          </label>
          {addError === null ? (
            addHint === '' ? (
              <p className="field-hint">目录外的 ID 也可以加入，发送时按默认容量兜底。</p>
            ) : (
              <p className="field-hint model-add-hint">{addHint}</p>
            )
          ) : (
            <p className="field-error" role="alert">
              {addError}
            </p>
          )}
          <div className="settings-actions">
            <button
              type="button"
              className="button button-small"
              disabled={busy !== null}
              onClick={() => void onAdd()}
            >
              加入目录
            </button>
            <span className="settings-hint">排序立即保存；单选决定下一次对话用哪条。</span>
          </div>
        </div>
      )}
    </div>
  )
}
