import { describe, expect, it } from 'vitest'
import { isModelDirectoryReadOnly } from '../../../shared/model-directory'
import {
  baseUrlError,
  customProviderErrorText,
  displayNameError,
  modelDirectoryHint,
  modelIdError,
  modelInDirectory,
  modelWriteErrorText,
  moveModelId,
  parseCapacity,
  protocolOptionLabel,
  providerIdError,
  providerUpdateErrorText
} from './provider-editing'
import { credentialRejectionText } from './messages'

const builtinDeepSeek = {
  source: 'builtin' as const,
  catalogProviderId: 'deepseek',
  protocol: 'openai-completions' as const
}

const customOpenAI = {
  source: 'custom' as const,
  catalogProviderId: null,
  protocol: 'openai-completions' as const
}

describe('providerIdError', () => {
  it('精确接受小写字母开头的单连字符单词', () => {
    for (const value of ['a', 'my-relay', 'relay-2', 'a1-b2-c3']) {
      expect(providerIdError(value, []), value).toBeNull()
    }
  })

  it('非法、空与重复的 Provider ID 都给出字段错误', () => {
    for (const value of ['Bad_Relay', '1relay', 'my_relay', 'my--relay', 'my-relay-', '-relay']) {
      expect(providerIdError(value, [])).toContain('小写字母开头')
    }
    expect(providerIdError('   ', [])).toBe('先填 Provider ID。')
    expect(providerIdError('my-relay', ['deepseek', 'my-relay'])).toBe(
      '这个 Provider ID 已经有了，换一个。'
    )
  })
})

describe('显示名、地址与模型 ID 的字段错误', () => {
  it('显示名不能为空', () => {
    expect(displayNameError('我的中转')).toBeNull()
    expect(displayNameError('   ')).toBe('先填显示名。')
  })

  it('接口地址必须是可解析的 http(s) 地址', () => {
    expect(baseUrlError('https://relay.example.com/v1')).toBeNull()
    expect(baseUrlError('http://127.0.0.1:8080')).toBeNull()
    expect(baseUrlError('')).toBe('先填接口地址。')
    expect(baseUrlError('relay.example.com/v1')).toBe('接口地址要是 http(s) 开头的完整地址。')
    expect(baseUrlError('ftp://relay.example.com')).toBe(
      '接口地址要是 http(s) 开头的完整地址。'
    )
  })

  it('模型 ID 不能为空或与已有一行重名', () => {
    expect(modelIdError('relay-model', [])).toBeNull()
    expect(modelIdError('  ', [])).toBe('先填模型 ID。')
    expect(modelIdError('relay-model', ['other', 'relay-model'])).toBe(
      '这个模型已经在目录里了。'
    )
  })
})

describe('modelDirectoryHint 与 modelInDirectory', () => {
  it('内置 provider 认自己目录里的模型并带出容量', () => {
    expect(modelInDirectory(builtinDeepSeek, 'deepseek-v4-pro')).toBe(true)
    expect(modelDirectoryHint(builtinDeepSeek, 'deepseek-v4-pro')).toBe(
      '目录收录：上下文 1,000,000 · 输出 384,000 · 支持思考'
    )
  })

  it('目录外的 ID 明确说不在目录，但仍说明可以加入并发送、容量有兜底', () => {
    expect(modelInDirectory(builtinDeepSeek, 'brand-new-model')).toBe(false)
    expect(modelDirectoryHint(builtinDeepSeek, 'brand-new-model')).toBe(
      '不在目录：仍可加入并发送；缺容量时按默认值兜底（上下文 1,000,000 · 输出 128,000 · text）。'
    )
    expect(modelDirectoryHint(builtinDeepSeek, '   ')).toBe('')
  })

  it('自定义 provider 按协议从共享目录里认出常见模型，协议不一致就算不在目录', () => {
    expect(modelInDirectory(customOpenAI, 'deepseek-v4-pro')).toBe(true)
    expect(modelInDirectory(customOpenAI, 'MiniMax-M3')).toBe(false)
    expect(modelDirectoryHint(customOpenAI, 'MiniMax-M3')).toContain('不在目录')
  })
})

describe('isModelDirectoryReadOnly', () => {
  it('只对 OpenCode GO 的聚合目录返回只读，内置单协议与自定义都可编辑', () => {
    expect(isModelDirectoryReadOnly({ catalogProviderId: 'opencode-go' })).toBe(true)
    expect(isModelDirectoryReadOnly({ catalogProviderId: 'deepseek' })).toBe(false)
    expect(isModelDirectoryReadOnly({ catalogProviderId: null })).toBe(false)
  })
})

describe('moveModelId', () => {
  const ids = ['a', 'b', 'c']

  it('把一行移到目标位置，返回新顺序', () => {
    expect(moveModelId(ids, 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveModelId(ids, 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveModelId(ids, 1, 1)).toBe(ids)
    expect(moveModelId(ids, -1, 2)).toBe(ids)
    expect(moveModelId(ids, 0, 3)).toBe(ids)
  })
})

describe('协议下拉文案', () => {
  it('选项名来自共享协议表，已开放的协议不带「后续版本」', () => {
    expect(protocolOptionLabel('openai-completions')).toBe('OpenAI Chat Completions')
    expect(protocolOptionLabel('anthropic-messages')).toBe('Anthropic Messages')
    expect(protocolOptionLabel('openai-responses')).toBe('OpenAI Responses（后续版本）')
    expect(protocolOptionLabel('google-generative-ai')).toBe('Gemini API（后续版本）')
  })
})

describe('容量输入解析', () => {
  it('空串表示目录未提供；只接受正的安全整数', () => {
    expect(parseCapacity('')).toBeNull()
    expect(parseCapacity('   ')).toBeNull()
    expect(parseCapacity('1000000')).toBe(1000000)
    expect(parseCapacity('0')).toBe('invalid')
    expect(parseCapacity('1.5')).toBe('invalid')
    expect(parseCapacity('9007199254740993')).toBe('invalid')
    expect(parseCapacity('-1')).toBe('invalid')
    expect(parseCapacity('abc')).toBe('invalid')
  })
})

describe('错误文案', () => {
  it('自定义创建与 provider 编辑的拒绝都有可操作的说明', () => {
    expect(customProviderErrorText('invalid-provider-id')).toContain('小写字母开头')
    expect(customProviderErrorText('duplicate-provider-id')).toContain('已经有了')
    expect(customProviderErrorText('unsupported-protocol')).toContain('OpenAI Chat Completions')
    expect(customProviderErrorText('missing-model')).toContain('至少要有一个模型')
    expect(providerUpdateErrorText('invalid-base-url')).toContain('http(s)')
  })

  it('凭据类拒绝与凭据编辑共用同一份文案，不再各抄一句', () => {
    expect(customProviderErrorText('missing-key')).toBe(credentialRejectionText('missing-key'))
    expect(customProviderErrorText('invalid-env-var')).toBe(
      credentialRejectionText('invalid-env-var')
    )
  })

  it('默认模型与最后一条模型给出各自的原因', () => {
    expect(modelWriteErrorText('default-model')).toContain('先另选一个默认模型')
    expect(modelWriteErrorText('last-model')).toContain('至少要留一个模型')
    expect(modelWriteErrorText('duplicate-model-id')).toContain('已经在目录里')
    expect(modelWriteErrorText('order-mismatch')).toContain('刷新后再排序')
    expect(modelWriteErrorText('read-only')).toContain('OpenCode GO')
  })
})
