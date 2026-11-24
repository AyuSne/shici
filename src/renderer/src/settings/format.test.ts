import { describe, expect, it } from 'vitest'
import type { BackupSummary } from '../../../shared/settings'
import type {
  ModelProviderSummary,
  ProviderCheckError
} from '../../../shared/model-providers'
import type { ProviderTestFailure } from '../../../shared/provider-test'
import {
  backupSummaryText,
  checkText,
  credentialIssueText,
  credentialRepairs,
  fileNameOf,
  formatBytes,
  formatMoment,
  keyStateText,
  modelCapacityText,
  modelMetaText,
  modelThinkingText,
  protocolText,
  providerBaseUrlText,
  providerCheckReasonText,
  providerModelsText,
  providerProtocolText,
  providerSourceText,
  providerTestFailureText,
  providerTestRepairs,
  providerTestRequestId,
  providerTestVerifiedText,
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
    hasStoredCiphertext: true,
    credentialError: null,
    retryPolicy: { mode: 'normal' },
    verification: 'unverified',
    lastError: null,
    lastCheckedAt: null,
    lastVerifiedAt: null,
    source: 'custom',
    catalogProviderId: null,
    active: false,
    defaultModelRowId: 'model-1',
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
    ['network', '网络异常']
  ] as const)('校验没过时说明原因：%s', (lastError, part) => {
    expect(checkText(provider({ lastError, lastCheckedAt: checkedAt }))).toBe(
      `上次校验 ${formatMoment(checkedAt)} 未通过 · ${part}`
    )
  })

  it('失败原因不把 request id 混进主文案：诊断字符另有折叠区', () => {
    expect(
      checkText(
        provider({
          lastError: 'invalid-key',
          lastErrorRequestId: 'req-401',
          lastCheckedAt: checkedAt
        })
      )
    ).toBe(`上次校验 ${formatMoment(checkedAt)} 未通过 · 密钥无效`)
  })

  it('已验证但最近一次真实调用失败时，同时说清两件事', () => {
    expect(
      checkText(
        provider({
          verification: 'verified',
          lastError: 'server',
          lastErrorRequestId: 'req-500',
          lastCheckedAt: checkedAt,
          lastVerifiedAt: checkedAt
        })
      )
    ).toBe(`上次校验 ${formatMoment(checkedAt)} 通过；最近一次失败 · 服务繁忙`)
  })
})

describe('providerCheckReasonText', () => {
  it.each([
    ['invalid-key', '密钥无效'],
    ['invalid-config', '接口地址或模型名不对'],
    ['quota', '余额不足'],
    ['rate-limit', '请求太频繁'],
    ['server', '服务繁忙'],
    ['timeout', '超时'],
    ['network', '网络异常'],
    ['empty-response', '返回了空回答'],
    ['missing-credential', '没有可用的密钥'],
    ['unsupported-protocol', '协议不受支持'],
    ['no-model', '没有可用的模型'],
    ['unknown', '未能完成'],
    [null, '未能完成']
  ] as const)('%s → %s', (reason, text) => {
    expect(providerCheckReasonText(reason)).toBe(text)
  })
})

describe('测试连接的结果文案与就地修复动作', () => {
  const failed = {
    status: 'failed' as const,
    checkedAt,
    persisted: true,
    reason: 'invalid-key' as const,
    error: {
      code: 'invalid-key' as const,
      kind: 'AUTH' as const,
      status: 401,
      requestId: 'req-401'
    },
    requestId: 'req-401'
  }

  function failure(
    reason: ProviderCheckError,
    error: Partial<ProviderTestFailure['error']> = {}
  ): ProviderTestFailure {
    return {
      status: 'failed',
      checkedAt,
      persisted: true,
      reason,
      error: { code: 'unknown', ...error }
    }
  }

  it('主文案只说自然原因；诊断字符与路径指引都不混进来', () => {
    const text = providerTestFailureText(failed)
    expect(text).toBe('测试没通过：密钥无效')
    expect(text).not.toContain('请求 ID')
    expect(text).not.toContain('到设置')
    expect(text).not.toContain('编辑凭据')
  })

  it('测试期间配置变了：如实说这次结果没有保存', () => {
    const text = providerTestFailureText({ ...failed, persisted: false })
    expect(text).toContain('测试期间配置已改动，结果没有保存，请重新测试')
    expect(text).not.toContain('请求 ID')
  })

  it('request id 单独取出，给折叠诊断区', () => {
    expect(providerTestRequestId(failed)).toBe('req-401')
    expect(providerTestRequestId(failure('timeout'))).toBeNull()
    expect(providerTestRequestId({ ...failed, requestId: '   ' })).toBeNull()
  })

  it.each([
    ['invalid-key', 'stored', ['replace-key']],
    ['invalid-key', 'env', ['use-stored-key']],
    ['quota', 'env', ['use-stored-key']],
    ['invalid-config', 'stored', ['edit-connection']],
    ['no-model', 'stored', ['manage-models']],
    ['network', 'stored', ['retry-test']],
    ['server', 'env', ['retry-test']],
    ['unsupported-protocol', 'stored', []]
  ] as const)('%s（%s）给出对应的就地修复动作', (reason, authMode, expected) => {
    expect(providerTestRepairs(failure(reason), authMode)).toEqual(expected)
  })

  it('缺凭据按来源给「改用本机密钥」或「更换密钥」，并点名环境变量', () => {
    const envMissing = failure('missing-credential', {
      code: 'not-configured',
      credential: { kind: 'env-missing', envVar: 'DEEPSEEK_API_KEY' },
      detail: 'server secret text'
    })
    expect(providerTestRepairs(envMissing, 'env')).toEqual(['use-stored-key'])
    expect(providerTestFailureText(envMissing)).toBe(
      '测试没通过：系统里还没有设置环境变量 DEEPSEEK_API_KEY'
    )
    expect(providerTestFailureText(envMissing)).not.toContain('server secret text')

    const decryptFailed = failure('missing-credential', {
      code: 'not-configured',
      credential: { kind: 'stored-decrypt-failed' }
    })
    expect(providerTestRepairs(decryptFailed, 'stored')).toEqual(['replace-key'])
    expect(providerTestFailureText(decryptFailed)).toBe(
      '测试没通过：本机保存的密钥解不开'
    )
  })

  it('通过时说明已验证；没有写回时也要说清', () => {
    expect(
      providerTestVerifiedText({ status: 'verified', checkedAt, persisted: true })
    ).toBe('测试连接通过，已标为已验证。')
    expect(
      providerTestVerifiedText({ status: 'verified', checkedAt, persisted: false })
    ).toBe('测试连接通过，但测试期间配置已改动，结果未保存；请重新测试。')
  })
})

describe('protocolText', () => {
  it('四种协议各有明确名字', () => {
    expect(protocolText('openai-completions')).toBe('OpenAI Chat Completions')
    expect(protocolText('openai-responses')).toBe('OpenAI Responses')
    expect(protocolText('anthropic-messages')).toBe('Anthropic Messages')
    expect(protocolText('google-generative-ai')).toBe('Gemini API')
  })

  it('库里存了不认识的协议时如实说，不冒充另一种协议', () => {
    expect(protocolText(null)).toBe('未识别协议')
  })
})

describe('providerProtocolText 与 providerBaseUrlText', () => {
  it('聚合入口说「按模型混合 / 按模型给」，不误报未识别协议', () => {
    const aggregate = provider({
      protocol: null,
      baseUrl: null,
      source: 'builtin',
      catalogProviderId: 'opencode-go'
    })
    expect(providerProtocolText(aggregate)).toBe('多种协议')
    expect(providerBaseUrlText(aggregate)).toBe('各模型分别提供')
  })

  it('真正的未知协议仍如实说；单协议与空地址照旧', () => {
    expect(
      providerProtocolText(provider({ protocol: null, catalogProviderId: null }))
    ).toBe('未识别协议')
    expect(providerProtocolText(provider())).toBe('OpenAI Chat Completions')
    expect(providerBaseUrlText(provider())).toBe('https://api.deepseek.com')
    expect(providerBaseUrlText(provider({ baseUrl: null }))).toBe('未填写')
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

  it('本机密文解不开时仍算本机，但明确说解不开', () => {
    expect(
      keyStateText(
        provider({
          keyState: 'stored',
          apiKeyMask: null,
          credentialError: 'stored-decrypt-failed'
        })
      )
    ).toBe('本机 · 解不开')
  })
})

describe('credentialIssueText 与 credentialRepairs', () => {
  it('本机密文解不开：自然说明原因与不换源，动作是更换密钥', () => {
    const broken = provider({
      keyState: 'stored',
      apiKeyMask: null,
      credentialError: 'stored-decrypt-failed'
    })
    const text = credentialIssueText(broken)

    expect(text).toMatch(/本机保存的密钥解不开/)
    expect(text).toMatch(/不会自动改用环境变量/)
    expect(text).not.toContain('到设置')
    expect(text).not.toContain('编辑凭据里')
    expect(credentialRepairs(broken)).toEqual(['replace-key'])
  })

  it('环境变量缺失：点名变量，动作是改用本机密钥', () => {
    const missingEnv = provider({
      authMode: 'env',
      envVar: 'DEEPSEEK_API_KEY',
      keyState: 'missing',
      apiKeyMask: null
    })
    const text = credentialIssueText(missingEnv)

    expect(text).toContain('DEEPSEEK_API_KEY')
    expect(text).toMatch(/改用本机保存的密钥/)
    expect(text).not.toContain('到设置')
    expect(credentialRepairs(missingEnv)).toEqual(['use-stored-key'])
  })

  it('本机模式没有密钥：说明还差一把密钥，动作是更换密钥', () => {
    const missingStored = provider({ keyState: 'missing', apiKeyMask: null })

    expect(credentialIssueText(missingStored)).toMatch(/还没有可用的密钥/)
    expect(credentialRepairs(missingStored)).toEqual(['replace-key'])
  })

  it('正常与环境模式可用时不额外报警', () => {
    expect(credentialIssueText(provider())).toBeNull()
    expect(credentialRepairs(provider())).toEqual([])
    expect(
      credentialIssueText(
        provider({ authMode: 'env', keyState: 'env', envVar: 'KEY', apiKeyMask: null })
      )
    ).toBeNull()
    expect(
      credentialRepairs(
        provider({ authMode: 'env', keyState: 'env', envVar: 'KEY', apiKeyMask: null })
      )
    ).toEqual([])
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

  it('聚合入口的卡片不把 32 个 ID 挤成一行，只说清数量与按模型给', () => {
    expect(
      providerModelsText(
        provider({
          source: 'builtin',
          catalogProviderId: 'opencode-go',
          protocol: null,
          models: [
            { ...provider().models[0]!, id: 'm1', modelId: 'beam-free' },
            { ...provider().models[0]!, id: 'm2', modelId: 'gemini-4-argon' }
          ]
        })
      )
    ).toBe('2 个模型')
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
    expect(modelCapacityText(model)).toBe('目录未提供容量')
    expect(modelThinkingText(model)).toBe('不支持思考')
    expect(modelMetaText(model)).toBe('目录未提供容量 · 不支持思考')
  })

  it('获取的候选没给思考能力时写「未知」，不冒充不支持思考', () => {
    expect(modelThinkingText({ reasoning: null })).toBe('思考能力未知')
    expect(
      modelMetaText({ ...model, contextWindow: 64_000, maxTokens: 4_096, reasoning: null })
    ).toBe('上下文 64,000 · 输出 4,096 · 思考能力未知')
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
