import { isAggregateModelProvider } from '../../../shared/model-directory'
import { MODEL_PROTOCOL_LABELS } from '../../../shared/model-protocols'
import type {
  ModelProviderModelSummary,
  ModelProviderSummary,
  ProviderCheckError,
  ProviderProtocol
} from '../../../shared/model-providers'
import type { ProviderTestFailure, ProviderTestResult } from '../../../shared/provider-test'
import type { ReadingPreferences } from '../../../shared/reading'
import type { BackupSummary, RestoreRejection } from '../../../shared/settings'
import type { ThemePreference } from '../../../shared/types'

/** 设置页的显示逻辑：把 provider 状态翻成中文。 */

export function verificationText(
  provider: Pick<ModelProviderSummary, 'verification'>
): '已验证' | '未验证' {
  return provider.verification === 'verified' ? '已验证' : '未验证'
}

/** 卡片上那句「上次校验 …」。 */
export function checkText(provider: ModelProviderSummary): string {
  if (provider.lastCheckedAt === null && provider.lastVerifiedAt === null) {
    return '还没校验过'
  }
  const requestId =
    provider.lastErrorRequestId === undefined || provider.lastErrorRequestId === null
      ? ''
      : ` · 请求 ID ${provider.lastErrorRequestId}`
  if (provider.verification === 'verified') {
    // 成功调用也会自动转已验证，这时用真正证实密钥可用的那个时刻。
    const moment = formatMoment(provider.lastVerifiedAt ?? provider.lastCheckedAt ?? '')
    const passed = moment === '' ? '已验证' : `上次校验 ${moment} 通过`
    return provider.lastError === null
      ? passed
      : `${passed}；最近一次失败 · ${providerCheckReasonText(provider.lastError)}${requestId}`
  }
  const moment = formatMoment(provider.lastCheckedAt ?? '')
  return `上次校验 ${moment} 未通过 · ${providerCheckReasonText(provider.lastError)}${requestId}`
}

/**
 * 失败原因 → 一句可操作的中文。测试连接与卡片上的「上次校验」共用这一份，
 * 新增分类时只改这里。
 */
export function providerCheckReasonText(reason: ProviderCheckError | null): string {
  switch (reason) {
    case 'invalid-key':
      return '密钥无效'
    case 'invalid-config':
      return '接口地址或模型名不对'
    case 'quota':
      return '余额不足'
    case 'rate-limit':
      return '请求太频繁'
    case 'server':
      return '服务繁忙'
    case 'timeout':
      return '超时'
    case 'empty-response':
      return '返回了空回答'
    case 'missing-credential':
      return '没有可用的密钥'
    case 'unsupported-protocol':
      return '协议不受支持'
    case 'no-model':
      return '没有可用的模型'
    case 'network':
    case 'unknown':
    case null:
      return '未能完成'
  }
}

/** 一次失败测试的卡片文案：原因 + request id；没写回时说明为什么。 */
export function providerTestFailureText(result: ProviderTestFailure): string {
  const parts = [`测试没通过：${providerCheckReasonText(result.reason)}`]
  if (result.requestId !== undefined && result.requestId.trim() !== '') {
    parts.push(`请求 ID ${result.requestId}`)
  }
  if (!result.persisted) {
    parts.push('测试期间配置已改动，这次结果没有写回；请重新测试')
  }
  return parts.join(' · ')
}

/** 一次通过测试的结果文案；请求成功但配置在测试期间变了，不能谎称已验证。 */
export function providerTestVerifiedText(
  result: Extract<ProviderTestResult, { status: 'verified' }>
): string {
  return result.persisted
    ? '测试连接通过，已标为已验证。'
    : '测试连接通过，但测试期间配置已改动，没有写回；请重新测试。'
}

export function protocolText(protocol: ProviderProtocol | null): string {
  // 库里存了本版不认识的协议时如实说，不冒充另一种协议。
  return protocol === null ? '未识别协议' : MODEL_PROTOCOL_LABELS[protocol]
}

/**
 * 聚合入口的固定文案。卡片与「从内置目录添加」的预览都引用这两句，
 * 判定则统一走 `isAggregateModelProvider`，不要再按 `protocol === null` 各写一份。
 */
export const AGGREGATE_PROTOCOL_TEXT = '按模型混合'
export const AGGREGATE_BASE_URL_TEXT = '按模型给（无统一地址）'

/**
 * provider 的协议文案。聚合入口（OpenCode GO）没有单一协议，说「按模型
 * 混合」；只有真正的未知持久化值才说「未识别协议」。两者不能混成一句。
 */
export function providerProtocolText(
  provider: Pick<ModelProviderSummary, 'protocol' | 'catalogProviderId'>
): string {
  return isAggregateModelProvider(provider)
    ? AGGREGATE_PROTOCOL_TEXT
    : protocolText(provider.protocol)
}

/** 聚合入口没有统一地址；空地址只对单协议 provider 才是「未填写」。 */
export function providerBaseUrlText(
  provider: Pick<ModelProviderSummary, 'baseUrl' | 'catalogProviderId'>
): string {
  return isAggregateModelProvider(provider)
    ? AGGREGATE_BASE_URL_TEXT
    : (provider.baseUrl ?? '未填写')
}

/** 密钥三态：本机（带掩码）、环境（带变量名）、缺失（带变量名）。 */
export function keyStateText(provider: ModelProviderSummary): string {
  if (provider.keyState === 'stored') {
    if (provider.credentialError === 'stored-decrypt-failed') {
      return '本机 · 解不开'
    }
    return provider.apiKeyMask === null
      ? '本机'
      : `本机 · ${provider.apiKeyMask}`
  }
  const variable = provider.envVar === null || provider.envVar.trim() === ''
    ? ''
    : provider.envVar.trim()
  if (provider.keyState === 'env') {
    return variable === '' ? '环境' : `环境 · ${variable}`
  }
  return variable === '' ? '缺失' : `缺失 · ${variable}`
}

/**
 * 本机密文解不开时的动作提示。只针对这一种情况：环境变量缺失时界面已经
 * 在密钥一栏写了变量名，不需要再叠一段。
 */
export function credentialIssueText(
  provider: Pick<ModelProviderSummary, 'credentialError'>
): string | null {
  if (provider.credentialError !== 'stored-decrypt-failed') {
    return null
  }
  return '本机保存的密钥解不开（可能换了电脑或系统账户）。点「编辑凭据」重填，或改用环境变量；发送不会自动改用环境变量。'
}

/**
 * 目录里的模型请求名，按保存顺序列出。聚合入口的 32 个模型不挤成一行：
 * 只说数量，逐条协议与地址留给卡片里的模型目录。
 */
export function providerModelsText(provider: ModelProviderSummary): string {
  if (provider.models.length === 0) {
    return '还没有模型'
  }
  if (isAggregateModelProvider(provider)) {
    return `${provider.models.length} 个模型（协议与地址按模型给）`
  }
  return provider.models.map((model) => model.modelId).join('、')
}

/** 容量按千分位显示；目录没给就不假装知道。 */
export function modelCapacityText(
  model: Pick<ModelProviderModelSummary, 'contextWindow' | 'maxTokens'>
): string {
  if (model.contextWindow === null || model.maxTokens === null) {
    return '目录未提供容量 · 按通用上限兜底'
  }
  return `上下文 ${model.contextWindow.toLocaleString('en-US')} · 输出 ${model.maxTokens.toLocaleString('en-US')}`
}

export function modelThinkingText(
  model: Pick<ModelProviderModelSummary, 'reasoning'> | { reasoning: boolean | null }
): string {
  if (model.reasoning === null) {
    return '思考能力未知'
  }
  return model.reasoning ? '支持思考' : '不支持思考'
}

/** 模型选择器每行的元数据；目录只读，这里只负责说清。 */
export function modelMetaText(
  model: Pick<ModelProviderModelSummary, 'contextWindow' | 'maxTokens'> & {
    reasoning: boolean | null
  }
): string {
  return `${modelCapacityText(model)} · ${modelThinkingText(model)}`
}

/** 卡片上的来源：内置的标出目录入口，迁移来的 custom 不冒充内置。 */
export function providerSourceText(provider: ModelProviderSummary): string {
  if (provider.source !== 'builtin') {
    return '自定义'
  }
  return provider.catalogProviderId === null
    ? '内置目录'
    : `内置目录 · ${provider.catalogProviderId}`
}

/** 时间按本机时区写成 年-月-日 时:分；坏值不假装成时间。 */
export function formatMoment(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`
}

export function themeText(theme: ThemePreference): string {
  return theme === 'dark' ? '深色' : theme === 'system' ? '跟随系统' : '浅色'
}

/** 备份体积：字节不带小数，到了 KB / MB 留一位。 */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, Math.round(bytes))
  if (value < 1024) {
    return `${value} B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** 「上次备份」那一行：时间 · 体积；文件被挪走时如实说。 */
export function backupSummaryText(summary: BackupSummary): string {
  const moment = formatMoment(summary.at)
  return summary.exists
    ? `${moment} · ${formatBytes(summary.bytes)}`
    : `${moment} · 文件已不在原处`
}

export function restoreRejectionText(reason: RestoreRejection): string {
  switch (reason) {
    case 'missing':
      return '这个备份文件已经不在了。'
    case 'not-a-database':
      return '这不是一个数据库文件。'
    case 'not-a-library':
      return '这不是本程序的资料库备份。'
    case 'too-new':
      return '这份备份来自更新的版本，当前程序打不开。'
    case 'damaged':
      return '这个备份文件已经损坏，没法恢复。'
    case 'same-file':
      return '不能拿正在用的资料库当备份。'
  }
}

/** 路径太长，界面上只留文件名；Windows 与 POSIX 的分隔符都认。 */
export function fileNameOf(file: string): string {
  const cut = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'))
  return cut === -1 ? file : file.slice(cut + 1)
}

export function readingDefaultsText(preferences: ReadingPreferences): string {
  const annotations = preferences.annotationsVisible ? '注释显示' : '注释隐藏'
  const weak = preferences.weakHighlight ? '弱高亮开' : '弱高亮关'
  return `字号 ${preferences.fontSize} · 行距 ${preferences.lineHeight.toFixed(1)} · ${annotations} · ${weak}`
}
