import { describe, expect, it } from 'vitest'
import { retryPolicyText } from './format'

describe('retryPolicyText', () => {
  it('normal 说明只重试临时错误与最多 5 次', () => {
    expect(retryPolicyText({ mode: 'normal' })).toBe(
      '只重试临时错误（默认，最多 5 次）'
    )
  })

  it('always 说明所有失败都重试，仍受最多 5 次限制', () => {
    expect(retryPolicyText({ mode: 'always' })).toBe('所有失败都重试（最多 5 次）')
  })
})
