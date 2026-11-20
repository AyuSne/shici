import { describe, expect, it } from 'vitest'
import type { ChatError, ChatErrorCode } from '../../../shared/chat'
import { describeChatError, suggestsSettings } from './errors'

describe('describeChatError', () => {
  it.each<{
    code: ChatErrorCode
    status?: number
    title: string
    detail: RegExp
    action?: RegExp
    retryable: boolean
  }>([
    {
      code: 'invalid-key',
      status: 401,
      title: '密钥无效（401）',
      detail: /这次生成没有开始/,
      action: /设置 → 模型服务/,
      retryable: false
    },
    {
      code: 'insufficient-balance',
      status: 402,
      title: '余额不足（402）',
      detail: /没有可用余额/,
      action: /换一个有余额的密钥/,
      retryable: false
    },
    {
      code: 'context-too-long',
      status: 413,
      title: '上下文过长（413）',
      detail: /内容太多/,
      action: /删减/,
      retryable: false
    },
    {
      code: 'rate-limited',
      status: 429,
      title: '请求太频繁（429）',
      detail: /稍等几秒再试/,
      retryable: true
    },
    {
      code: 'server-busy',
      status: 503,
      title: '服务繁忙（503）',
      detail: /暂时不可用/,
      retryable: true
    },
    {
      code: 'network',
      title: '网络异常',
      detail: /没连上模型服务/,
      retryable: true
    },
    {
      code: 'empty-response',
      title: '模型没有返回内容',
      detail: /空回答/,
      retryable: true
    },
    {
      code: 'not-configured',
      title: '还没有配置模型服务',
      detail: /这次生成没有开始/,
      action: /设置 → 模型服务/,
      retryable: false
    },
    {
      code: 'unknown',
      title: '生成失败',
      detail: /预料之外/,
      action: /稍后再试/,
      retryable: false
    }
  ])('$code 给出专属文案与动作', ({ code, status, title, detail, action, retryable }) => {
    const error: ChatError = { code, ...(status !== undefined ? { status } : {}) }
    const presentation = describeChatError(error)

    expect(presentation.title).toBe(title)
    expect(presentation.detail).toMatch(detail)
    if (action) {
      expect(presentation.action).toMatch(action)
    } else {
      expect(presentation.action).toBeUndefined()
    }
    expect(presentation.retryable).toBe(retryable)
  })

  it('只有可重试的三类会显示重试按钮', () => {
    const codes: ChatErrorCode[] = [
      'invalid-key',
      'insufficient-balance',
      'context-too-long',
      'rate-limited',
      'server-busy',
      'network',
      'empty-response',
      'not-configured',
      'unknown'
    ]
    const retryable = codes.filter((code) => describeChatError({ code }).retryable)

    expect(retryable.sort()).toEqual([
      'empty-response',
      'network',
      'rate-limited',
      'server-busy'
    ])
  })

  it('换密钥、余额与未配置这三类给出去设置的快捷动作', () => {
    const codes: ChatErrorCode[] = [
      'invalid-key',
      'insufficient-balance',
      'context-too-long',
      'rate-limited',
      'server-busy',
      'network',
      'empty-response',
      'not-configured',
      'unknown'
    ]
    const settingsCalls = codes.filter((code) => suggestsSettings({ code }))

    expect(settingsCalls.sort()).toEqual([
      'insufficient-balance',
      'invalid-key',
      'not-configured'
    ])
  })
})
