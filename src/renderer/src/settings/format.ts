import type {
  ModelProviderModelSummary,
  ModelProviderSummary,
  ProviderProtocol
} from '../../../shared/model-providers'
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
  if (provider.verification === 'verified') {
    // 成功调用也会自动转已验证，这时用真正证实密钥可用的那个时刻。
    const moment = formatMoment(provider.lastVerifiedAt ?? provider.lastCheckedAt ?? '')
    return moment === '' ? '已验证' : `上次校验 ${moment} 通过`
  }
  const moment = formatMoment(provider.lastCheckedAt ?? '')
  const reason =
    provider.lastError === 'invalid-key'
      ? '密钥无效'
      : provider.lastError === 'invalid-config'
        ? '接口地址或模型名不对'
        : '未能完成'
  return `上次校验 ${moment} 未通过 · ${reason}`
}

const PROTOCOL_TEXT: Record<ProviderProtocol, string> = {
  'openai-completions': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  'anthropic-messages': 'Anthropic Messages',
  'google-generative-ai': 'Gemini API'
}

export function protocolText(protocol: ProviderProtocol | null): string {
  // 库里存了本版不认识的协议时如实说，不冒充另一种协议。
  return protocol === null ? '未识别协议' : PROTOCOL_TEXT[protocol]
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

/** 目录里的模型请求名，按保存顺序列出。 */
export function providerModelsText(provider: ModelProviderSummary): string {
  if (provider.models.length === 0) {
    return '还没有模型'
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
  model: Pick<ModelProviderModelSummary, 'reasoning'>
): string {
  return model.reasoning ? '支持思考' : '不支持思考'
}

/** 模型选择器每行的元数据；目录只读，这里只负责说清。 */
export function modelMetaText(model: ModelProviderModelSummary): string {
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
