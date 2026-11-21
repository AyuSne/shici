import { describe, expect, it } from 'vitest'
import {
  OPENCODE_GO_READ_ONLY,
  READ_ONLY_DIRECTORY_REJECTION,
  credentialRejectionText,
  readOnlyDirectoryHint
} from './messages'

describe('共享设置文案', () => {
  it('只读目录的说明与拒绝共用同一句前缀', () => {
    for (const scene of ['edit', 'discovery'] as const) {
      expect(readOnlyDirectoryHint(scene).startsWith(OPENCODE_GO_READ_ONLY)).toBe(true)
    }
    expect(READ_ONLY_DIRECTORY_REJECTION.startsWith(OPENCODE_GO_READ_ONLY)).toBe(true)
    expect(readOnlyDirectoryHint('edit')).toContain('不能手加')
    expect(readOnlyDirectoryHint('discovery')).toContain('不能加入')
  })

  it('三种凭据拒绝都有可操作文案', () => {
    expect(credentialRejectionText('confirm-required')).toContain('再确认')
    expect(credentialRejectionText('missing-key')).toContain('API 密钥')
    expect(credentialRejectionText('invalid-env-var')).toContain('字母')
  })
})
