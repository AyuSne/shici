import { findProviderCatalogModel } from '../../../shared/model-directory'
import {
  MODEL_PROTOCOL_LABELS,
  isCustomProviderProtocol,
  type ModelProtocol
} from '../../../shared/model-protocols'
import type {
  CustomProviderRejection,
  ModelProviderSummary,
  ProviderModelRejection,
  UpdateProviderRejection
} from '../../../shared/model-providers'
import { isValidProviderId } from '../../../shared/model-providers'
import { modelCapacityText, modelThinkingText } from './format'
import { READ_ONLY_DIRECTORY_REJECTION, credentialRejectionText } from './messages'

/**
 * 设置页「自定义 provider / 模型目录编辑」的纯显示与校验逻辑。
 *
 * 主进程仍是唯一权威：这里只做即时字段提示与目录预览，避免把非法值先写出去。
 * 目录预览与服务端用同一个共享查找规则（`findProviderCatalogModel`），
 * 所以「不在目录」的提示与真正保存后的元数据不会出现两套判断。
 */

type ProviderCatalogIdentity = Pick<
  ModelProviderSummary,
  'source' | 'catalogProviderId' | 'protocol'
>

const PROVIDER_ID_ERROR =
  'Provider ID 要以小写字母开头，只用小写字母、数字和单个连字符，例如 my-relay。'

export function providerIdError(
  value: string,
  existingProviderKeys: readonly string[]
): string | null {
  const trimmed = value.trim()
  if (trimmed === '') {
    return '先填 Provider ID。'
  }
  if (!isValidProviderId(trimmed)) {
    return PROVIDER_ID_ERROR
  }
  if (existingProviderKeys.includes(trimmed)) {
    return '这个 Provider ID 已经有了，换一个。'
  }
  return null
}

export function displayNameError(value: string): string | null {
  return value.trim() === '' ? '先填显示名。' : null
}

export function baseUrlError(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '') {
    return '先填接口地址。'
  }
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? null
      : '接口地址要是 http(s) 开头的完整地址。'
  } catch {
    return '接口地址要是 http(s) 开头的完整地址。'
  }
}

export function modelIdError(
  value: string,
  existingModelIds: readonly string[]
): string | null {
  const trimmed = value.trim()
  if (trimmed === '') {
    return '先填模型 ID。'
  }
  return existingModelIds.includes(trimmed)
    ? '这个模型已经在目录里了。'
    : null
}

/** 模型 ID 是否在当前 provider 的目录里；与主进程保存时的查找规则一致。 */
export function modelInDirectory(
  provider: ProviderCatalogIdentity,
  modelId: string
): boolean {
  return (
    findProviderCatalogModel(
      {
        source: provider.source,
        catalogProviderId: provider.catalogProviderId,
        protocol: provider.protocol
      },
      modelId
    ) !== null
  )
}

/**
 * 手填模型时的预览：目录里有就带出容量与思考能力，没有就明确说「不在目录」，
 * 同时说清仍可加入与发送、缺容量按什么兜底。
 */
export function modelDirectoryHint(
  provider: ProviderCatalogIdentity,
  modelId: string
): string {
  const trimmed = modelId.trim()
  if (trimmed === '') {
    return ''
  }
  const catalog = findProviderCatalogModel(
    {
      source: provider.source,
      catalogProviderId: provider.catalogProviderId,
      protocol: provider.protocol
    },
    trimmed
  )
  if (catalog !== null) {
    return `目录收录：${modelCapacityText(catalog)} · ${modelThinkingText(catalog)}`
  }
  return '不在目录：仍可加入并发送；缺容量时按默认值兜底（上下文 1,000,000 · 输出 128,000 · text）。'
}

/** 协议选项仍由共享协议表生成；本票未开放的只加后缀并禁用。 */
export function protocolOptionLabel(protocol: ModelProtocol): string {
  return isCustomProviderProtocol(protocol)
    ? MODEL_PROTOCOL_LABELS[protocol]
    : `${MODEL_PROTOCOL_LABELS[protocol]}（后续版本）`
}

export function moveModelId(
  modelRowIds: readonly string[],
  fromIndex: number,
  toIndex: number
): readonly string[] {
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= modelRowIds.length ||
    toIndex >= modelRowIds.length
  ) {
    return modelRowIds
  }
  const next = [...modelRowIds]
  const [moved] = next.splice(fromIndex, 1)
  if (moved === undefined) {
    return modelRowIds
  }
  next.splice(toIndex, 0, moved)
  return next
}

/** 空输入表示「目录未提供」，交给发送层兜底；其余只接受正的安全整数。 */
export function parseCapacity(value: string): number | null | 'invalid' {
  const trimmed = value.trim()
  if (trimmed === '') {
    return null
  }
  const parsed = Number(trimmed)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 'invalid'
}

export function customProviderErrorText(reason: CustomProviderRejection): string {
  switch (reason) {
    case 'invalid-provider-id':
      return PROVIDER_ID_ERROR
    case 'duplicate-provider-id':
      return '这个 Provider ID 已经有了，换一个。'
    case 'missing-display-name':
      return '先填显示名。'
    case 'unsupported-protocol':
      return '本票只开放 OpenAI Chat Completions 与 Gemini API；其他协议请等后续版本。'
    case 'missing-base-url':
      return '先填接口地址。'
    case 'invalid-base-url':
      return '接口地址要是 http(s) 开头的完整地址。'
    case 'missing-model':
      return '自定义 provider 至少要有一个模型才能保存。'
    case 'duplicate-model-id':
      return '候选里有重复的模型 ID；刷新后重新勾选。'
    case 'invalid-capacity':
      return '容量要填正整数。'
    case 'missing-key':
      // 与凭据编辑共用同一句，避免两处文案漂移。
      return credentialRejectionText('missing-key')
    case 'invalid-env-var':
      return credentialRejectionText('invalid-env-var')
  }
}

export function providerUpdateErrorText(reason: UpdateProviderRejection): string {
  switch (reason) {
    case 'missing-display-name':
      return '先填显示名。'
    case 'missing-base-url':
      return '先填接口地址。'
    case 'invalid-base-url':
      return '接口地址要是 http(s) 开头的完整地址。'
  }
}

export function modelWriteErrorText(reason: ProviderModelRejection): string {
  switch (reason) {
    case 'missing-model-id':
      return '先填模型 ID。'
    case 'duplicate-model-id':
      return '这个模型已经在目录里了。'
    case 'unknown-model':
      return '这条模型已经不在目录里了，刷新后再试。'
    case 'unknown-protocol':
      return '这套 provider 的协议无法识别，不能编辑模型目录。'
    case 'invalid-capacity':
      return '容量要填正整数。'
    case 'default-model':
      return '这是默认模型：先另选一个默认模型，再删除。'
    case 'last-model':
      return '至少要留一个模型，不能把目录删空。'
    case 'order-mismatch':
      return '模型目录刚刚变过，刷新后再排序。'
    case 'read-only':
      return READ_ONLY_DIRECTORY_REJECTION
  }
}
