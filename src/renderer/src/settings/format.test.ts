import { describe, expect, it } from 'vitest'
import type { BackupSummary } from '../../../shared/settings'
import type { ModelProviderSummary } from '../../../shared/model-providers'
import {
  backupSummaryText,
  checkText,
  fileNameOf,
  formatBytes,
  formatMoment,
  keyStateText,
  modelCapacityText,
  modelMetaText,
  modelThinkingText,
  protocolText,
  providerModelsText,
  providerSourceText,
  readingDefaultsText,
  restoreRejectionText,
  themeText,
  verificationText
} from './format'

function provider(patch: Partial<ModelProviderSummary> = {}): ModelProviderSummary {
  return {
    id: 'provider-1',
    providerKey: 'deepseek',
    displayName: 'DeepSeek 官方',
    protocol: 'openai-completions',
    baseUrl: 'https://api.deepseek.com',
    authMode: 'stored',
    envVar: null,
    apiKeyMask: 'sk-·············0001',
    keyState: 'stored',
    retryPolicy: { mode: 'normal' },
    verification: 'unverified',
    lastError: null,
    lastCheckedAt: null,
    lastVerifiedAt: null,
    source: 'custom',
    catalogProviderId: null,
    active: false,
    defaultModelId: 'model-1',
    defaultModel: 'deepseek-flash',
    models: [
      {
        id: 'model-1',
        modelId: 'deepseek-flash',
        displayName: 'deepseek-flash',
        api: 'openai-completions',
        baseUrl: null,
        contextWindow: null,
        maxTokens: null,
        input: 'text',
        reasoning: false,
        source: 'manual',
        sort: 0
      }
    ],
    ...patch
  }
}

const checkedAt = new Date(2026, 10, 17, 9, 12).toISOString()

describe('verificationText', () => {
  it('只有通过校验的那份写已验证', () => {
    expect(verificationText(provider())).toBe('未验证')
    expect(verificationText(provider({ verification: 'verified' }))).toBe('已验证')
  })
})

describe('checkText', () => {
  it('从没校验过时直说', () => {
    expect(checkText(provider())).toBe('还没校验过')
  })

  it('校验通过写时间', () => {
    expect(
      checkText(
        provider({
          verification: 'verified',
          lastCheckedAt: checkedAt,
          lastVerifiedAt: checkedAt
        })
      )
    ).toBe(`上次校验 ${formatMoment(checkedAt)} 通过`)
  })

  it('成功调用自动转已验证时，用最后一次证实的时刻', () => {
    const verifiedAt = new Date(2026, 10, 18, 10, 30).toISOString()

    expect(
      checkText(
        provider({
          verification: 'verified',
          lastCheckedAt: checkedAt,
          lastVerifiedAt: verifiedAt,
          lastError: null
        })
      )
    ).toBe(`上次校验 ${formatMoment(verifiedAt)} 通过`)
  })

  it.each([
    ['invalid-key', '密钥无效'],
    ['invalid-config', '接口地址或模型名不对'],
    ['network', '未能完成']
  ] as const)('校验没过时说明原因：%s', (lastError, part) => {
    expect(checkText(provider({ lastError, lastCheckedAt: checkedAt }))).toBe(
      `上次校验 ${formatMoment(checkedAt)} 未通过 · ${part}`
    )
  })
})

describe('protocolText', () => {
  it('四种协议各有明确名字', () => {
    expect(protocolText('openai-completions')).toBe('OpenAI Chat Completions')
    expect(protocolText('openai-responses')).toBe('OpenAI Responses')
    expect(protocolText('anthropic-messages')).toBe('Anthropic Messages')
    expect(protocolText('google-generative-ai')).toBe('Gemini API')
  })
})

describe('keyStateText', () => {
  it('本机、环境、缺失三态都写清楚，缺失时带上变量名', () => {
    expect(keyStateText(provider())).toBe('本机 · sk-·············0001')
    expect(
      keyStateText(
        provider({
          authMode: 'env',
          envVar: 'DEEPSEEK_API_KEY',
          keyState: 'env',
          apiKeyMask: null
        })
      )
    ).toBe('环境 · DEEPSEEK_API_KEY')
    expect(
      keyStateText(
        provider({
          authMode: 'env',
          envVar: 'DEEPSEEK_API_KEY',
          keyState: 'missing',
          apiKeyMask: null
        })
      )
    ).toBe('缺失 · DEEPSEEK_API_KEY')
    expect(
      keyStateText(provider({ keyState: 'missing', apiKeyMask: null }))
    ).toBe('缺失')
  })
})

describe('providerModelsText', () => {
  it('模型目录按顺序列出请求名', () => {
    expect(providerModelsText(provider())).toBe('deepseek-flash')
    expect(
      providerModelsText(
        provider({
          models: [
            provider().models[0]!,
            { ...provider().models[0]!, id: 'model-2', modelId: 'deepseek-v4-pro' }
          ]
        })
      )
    ).toBe('deepseek-flash、deepseek-v4-pro')
    expect(providerModelsText(provider({ models: [] }))).toBe('还没有模型')
  })
})

describe('模型元数据文案', () => {
  const model = provider().models[0]!

  it('目录给了容量就显示实际值与思考能力', () => {
    const withMeta = {
      ...model,
      contextWindow: 1000000,
      maxTokens: 384000,
      reasoning: true
    }
    expect(modelCapacityText(withMeta)).toBe('上下文 1,000,000 · 输出 384,000')
    expect(modelThinkingText(withMeta)).toBe('支持思考')
    expect(modelMetaText(withMeta)).toBe('上下文 1,000,000 · 输出 384,000 · 支持思考')
  })

  it('迁移来的模型没有容量信息时不编造 DeepSeek 数字，说清按通用上限兜底', () => {
    expect(modelCapacityText(model)).toBe('目录未提供容量 · 按通用上限兜底')
    expect(modelThinkingText(model)).toBe('不支持思考')
    expect(modelMetaText(model)).toBe('目录未提供容量 · 按通用上限兜底 · 不支持思考')
  })
})

describe('providerSourceText', () => {
  it('内置目录标出目录身份，迁移来的 custom 不作假', () => {
    expect(
      providerSourceText(provider({ source: 'builtin', catalogProviderId: 'deepseek' }))
    ).toBe('内置目录 · deepseek')
    expect(providerSourceText(provider())).toBe('自定义')
    expect(
      providerSourceText(provider({ source: 'builtin', catalogProviderId: null }))
    ).toBe('内置目录')
  })
})

describe('formatMoment', () => {
  it('按本机时区写成 年-月-日 时:分', () => {
    const date = new Date(2026, 0, 2, 3, 4)
    expect(formatMoment(date.toISOString())).toBe('2026-01-02 03:04')
  })

  it('坏值不显示成假时间', () => {
    expect(formatMoment('nope')).toBe('')
  })
})

describe('themeText', () => {
  it('三档各有中文名', () => {
    expect(themeText('light')).toBe('浅色')
    expect(themeText('dark')).toBe('深色')
    expect(themeText('system')).toBe('跟随系统')
  })
})

describe('readingDefaultsText', () => {
  it('把全局默认写在一行里', () => {
    expect(
      readingDefaultsText({
        fontSize: 20,
        lineHeight: 1.8,
        annotationsVisible: true,
        weakHighlight: true
      })
    ).toBe('字号 20 · 行距 1.8 · 注释显示 · 弱高亮开')

    expect(
      readingDefaultsText({
        fontSize: 22,
        lineHeight: 2,
        annotationsVisible: false,
        weakHighlight: false
      })
    ).toBe('字号 22 · 行距 2.0 · 注释隐藏 · 弱高亮关')
  })
})

describe('formatBytes', () => {
  it('按 1024 进位，KB 与 MB 留一位小数', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB')
  })
})

describe('backupSummaryText', () => {
  const backupAt = new Date(2026, 10, 18, 19, 4).toISOString()

  function summary(patch: Partial<BackupSummary> = {}): BackupSummary {
    return {
      at: backupAt,
      file: 'C:/backups/backup.db',
      bytes: 2048,
      kind: 'manual',
      exists: true,
      ...patch
    }
  }

  it('写清时间与体积', () => {
    expect(backupSummaryText(summary())).toBe(`${formatMoment(backupAt)} · 2.0 KB`)
  })

  it('文件不在原处时直说，不报一个假的体积', () => {
    expect(backupSummaryText(summary({ exists: false }))).toBe(
      `${formatMoment(backupAt)} · 文件已不在原处`
    )
  })
})

describe('restoreRejectionText', () => {
  it('每种拒绝都有能看懂的说法', () => {
    expect(restoreRejectionText('missing')).toBe('这个备份文件已经不在了。')
    expect(restoreRejectionText('not-a-database')).toBe('这不是一个数据库文件。')
    expect(restoreRejectionText('not-a-library')).toBe('这不是本程序的资料库备份。')
    expect(restoreRejectionText('too-new')).toBe('这份备份来自更新的版本，当前程序打不开。')
    expect(restoreRejectionText('damaged')).toBe('这个备份文件已经损坏，没法恢复。')
    expect(restoreRejectionText('same-file')).toBe('不能拿正在用的资料库当备份。')
  })
})

describe('fileNameOf', () => {
  it('Windows 与 POSIX 路径都只留文件名', () => {
    expect(
      fileNameOf('C:\\Users\\a\\backups\\english-learning-backup-20261118-1904.db')
    ).toBe('english-learning-backup-20261118-1904.db')
    expect(fileNameOf('/home/a/exports/thread-a.jsonl')).toBe('thread-a.jsonl')
    expect(fileNameOf('thread-b.jsonl')).toBe('thread-b.jsonl')
  })
})
