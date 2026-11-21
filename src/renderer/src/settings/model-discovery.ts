import type {
  FetchedModelCandidate,
  FetchProviderModelsFailure
} from '../../../shared/model-discovery'
import type {
  CustomProviderModelDraft,
  ProviderModelDraft
} from '../../../shared/model-providers'

/**
 * 「获取可用模型」的纯界面规则，不碰 IPC、不碰数据库。
 *
 * 返回值只用于界面草稿：勾选、取消勾选、合并成「保存时一次性提交」的模型数组。
 * 真正的去重与校验仍在主进程；这里只保证表单不会重复提交同一条。
 */

/** 勾选开关：已选就取消，否则加到末尾。 */
export function toggleSelectedModelId(
  selected: readonly string[],
  modelId: string
): string[] {
  return selected.includes(modelId)
    ? selected.filter((id) => id !== modelId)
    : [...selected, modelId]
}

/** 按候选返回顺序挑出已勾选项；未知 id 忽略。 */
export function selectedCandidates(
  candidates: readonly FetchedModelCandidate[],
  selectedIds: readonly string[]
): FetchedModelCandidate[] {
  const selected = new Set(selectedIds)
  return candidates.filter((candidate) => selected.has(candidate.modelId))
}

/**
 * 候选 → 保存用模型行；容量为 null 时不假装知道，交给目录/发送层兜底。
 * 思考能力为 null（上游没给）时不写 reasoning，保存时由目录值兜底；
 * 只有上游明确 true/false 才写进草稿。
 */
export function providerModelDraftOf(
  candidate: FetchedModelCandidate
): ProviderModelDraft {
  return {
    modelId: candidate.modelId,
    displayName: candidate.displayName,
    contextWindow: candidate.contextWindow ?? undefined,
    maxTokens: candidate.maxTokens ?? undefined,
    ...(candidate.reasoning === null ? {} : { reasoning: candidate.reasoning }),
    source: 'fetched'
  }
}

/**
 * 新建自定义 provider 时合并「手填首个模型 + 勾选候选」：
 * - 手填 ID 优先作第一条；如果它也在候选里，只保留一次并记 fetched；
 * - 其余候选按返回顺序追加、精确去重；
 * - 什么都不填/不勾返回空数组，由保存校验给出「至少要有一个模型」。
 */
export function combineCustomProviderModels(
  manualModelId: string,
  candidates: readonly FetchedModelCandidate[]
): CustomProviderModelDraft[] {
  const selected = new Map<string, FetchedModelCandidate>()
  for (const candidate of candidates) {
    const modelId = candidate.modelId.trim()
    if (modelId !== '' && !selected.has(modelId)) {
      selected.set(modelId, { ...candidate, modelId })
    }
  }

  const manual = manualModelId.trim()
  const drafts: CustomProviderModelDraft[] = []
  let firstId: string | null = null

  if (manual !== '') {
    const fetched = selected.get(manual)
    drafts.push(
      fetched === undefined
        ? { modelId: manual, source: 'manual' }
        : providerModelDraftOf(fetched)
    )
    firstId = manual
  } else {
    const first = selected.values().next().value as FetchedModelCandidate | undefined
    if (first !== undefined) {
      drafts.push(providerModelDraftOf(first))
      firstId = first.modelId
    }
  }

  for (const candidate of selected.values()) {
    if (candidate.modelId === firstId) {
      continue
    }
    drafts.push(providerModelDraftOf(candidate))
  }
  return drafts
}

/** 内置身份直说本地目录、零 HTTP；自定义强调用当前表单里尚未保存的值。 */
export function discoverySourceHint(source: 'builtin' | 'custom'): string {
  return source === 'builtin'
    ? '内置目录：直接返回随程序打包的本地目录，不联网，也不使用当前地址或密钥。'
    : '使用当前地址、协议与密钥来源获取；还没保存的修改也会生效，获取本身不写库。'
}

/** 失败原因写成可执行的中文提示；不包含上游响应正文或任何密钥。 */
export function discoveryFailureText(failure: FetchProviderModelsFailure): string {
  switch (failure.reason) {
    case 'invalid-base-url':
      return '接口地址要是 http(s) 开头的完整地址。'
    case 'unsupported-protocol':
      return '这套 provider 的协议无法识别，不能获取模型列表；请新建一套支持的协议。'
    case 'unknown-catalog':
      return '这套内置目录身份不在本版目录里，不能获取模型。'
    case 'unknown-provider':
      return '这套提供商已经不在了，刷新后再试。'
    case 'provider-mismatch':
      return '这套提供商的身份与当前请求不一致，不能借用它的密钥；刷新后再试。'
    case 'missing-credential':
      if (failure.problem === 'env-var-unset') {
        return '先填环境变量名。'
      }
      if (failure.problem === 'env-missing') {
        return `环境变量 ${failure.envVar ?? ''} 没有设置；获取不会改用本机密钥。`
      }
      if (failure.problem === 'stored-missing') {
        return '这套 provider 现在没有可用的本机密钥，先填一个新密钥，或改用环境变量。'
      }
      return '拿不到可用的密钥，先填写密钥或环境变量。'
    case 'credential-error':
      return '本机保存的密钥解不开（可能换了电脑或系统账户）；请重新填写，获取不会改用环境变量。'
    case 'http-error':
      return `服务端返回 HTTP ${failure.httpStatus ?? '错误'}；检查地址与密钥后再试。`
    case 'invalid-format':
      return '返回的内容不是可识别的模型列表。'
    case 'too-large':
      return '返回内容超过 4 MiB 上限，已停止读取。'
    case 'timeout':
      return '获取超时（等待响应头和读取正文都算）；检查地址与网络后再试。'
    case 'transport':
      return '连不上这个地址；检查地址、网络或代理后再试。'
  }
}
