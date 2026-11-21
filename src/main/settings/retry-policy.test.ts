import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { UpdateProviderRequest } from '../../shared/model-providers'
import { resolveChatConfig, readChatConfig } from '../chat/config'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { updateModelProvider } from './provider-editing'
import { addBuiltinProvider, activateModelProvider } from './provider-writes'
import { listModelProviders, readModelProvider } from './providers'
import type { SecretStore } from './secret-store'

/**
 * #69 的 provider 重试策略持久化：写入后列表、聊天配置与重启都读到同一个值；
 * 非法值整笔拒绝，旧调用不传字段时保持原策略。只走设置服务层与临时数据库。
 */

let directory: string
let database: AppDatabase

const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`,
  decrypt: (sealed) =>
    sealed.startsWith('sealed:')
      ? Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')
      : null
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-retry-policy-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function addDeepSeek(): string {
  const added = addBuiltinProvider(
    database,
    secrets,
    { catalogProviderId: 'deepseek', apiKey: 'sk-retry-0001' },
    { now: '2026-11-21T00:00:00.000Z' }
  )
  if (added.status !== 'saved') {
    throw new Error(`DeepSeek 没存上：${JSON.stringify(added)}`)
  }
  activateModelProvider(database, added.providerId)
  return added.providerId
}

function updateRequest(
  providerId: string,
  patch: Partial<UpdateProviderRequest> = {}
): UpdateProviderRequest {
  return {
    providerId,
    displayName: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    ...patch
  }
}

describe('provider 重试策略持久化', () => {
  it('保存 always 后 provider 行、设置页列表与聊天配置读到同一个策略', () => {
    const providerId = addDeepSeek()
    expect(readModelProvider(database, providerId)?.retryPolicy).toEqual({ mode: 'normal' })

    expect(
      updateModelProvider(
        database,
        updateRequest(providerId, { retryPolicy: { mode: 'always' } }),
        { now: '2026-11-21T01:00:00.000Z' }
      )
    ).toEqual({ status: 'saved' })

    expect(readModelProvider(database, providerId)?.retryPolicy).toEqual({ mode: 'always' })
    expect(
      listModelProviders(database, { secrets, env: {} })[0]?.retryPolicy
    ).toEqual({ mode: 'always' })
    expect(resolveChatConfig(database, secrets, {})?.retryPolicy).toEqual({ mode: 'always' })
  })

  it('只改显示名/地址时不传策略字段，原策略保持不变', () => {
    const providerId = addDeepSeek()
    updateModelProvider(database, updateRequest(providerId, {
      retryPolicy: { mode: 'always' }
    }))

    expect(
      updateModelProvider(database, {
        providerId,
        displayName: '新名字',
        baseUrl: 'https://api.deepseek.com'
      })
    ).toEqual({ status: 'saved' })

    expect(readModelProvider(database, providerId)).toMatchObject({
      displayName: '新名字',
      retryPolicy: { mode: 'always' }
    })
  })

  it('非法策略值整笔拒绝，已存策略与其它字段都不动', () => {
    const providerId = addDeepSeek()
    updateModelProvider(database, updateRequest(providerId, {
      retryPolicy: { mode: 'always' }
    }))

    expect(
      updateModelProvider(database, {
        providerId,
        displayName: '不该保存的名字',
        baseUrl: 'https://api.deepseek.com',
        retryPolicy: { mode: 'sometimes' } as never
      })
    ).toEqual({ status: 'rejected', reason: 'invalid-retry-policy' })

    expect(readModelProvider(database, providerId)).toMatchObject({
      displayName: 'DeepSeek 官方',
      retryPolicy: { mode: 'always' }
    })
  })

  it('策略随数据库重启保留；环境变量退路没有 provider 行，按 normal 处理', () => {
    const providerId = addDeepSeek()
    updateModelProvider(database, updateRequest(providerId, {
      retryPolicy: { mode: 'always' }
    }))
    database.close()

    database = openDatabase(join(directory, 'test.db'))
    migrate(database)
    expect(readModelProvider(database, providerId)?.retryPolicy).toEqual({ mode: 'always' })

    expect(readChatConfig({ DEEPSEEK_API_KEY: 'env-key' })?.retryPolicy).toEqual({
      mode: 'normal'
    })
  })

  it('改地址仍会重置验证状态，但只改策略不会动验证状态', () => {
    const providerId = addDeepSeek()
    database
      .prepare(
        `UPDATE model_provider
            SET verification = 'verified', last_error = NULL,
                last_checked_at = '2026-11-20T08:00:00.000Z',
                last_verified_at = '2026-11-20T08:00:00.000Z'
          WHERE id = ?`
      )
      .run(providerId)

    updateModelProvider(database, updateRequest(providerId, {
      retryPolicy: { mode: 'always' }
    }))
    expect(readModelProvider(database, providerId)?.verification).toBe('verified')

    updateModelProvider(database, updateRequest(providerId, {
      baseUrl: 'https://api.deepseek.com/v1',
      retryPolicy: { mode: 'always' }
    }))
    expect(readModelProvider(database, providerId)).toMatchObject({
      verification: 'unverified',
      lastVerifiedAt: null,
      retryPolicy: { mode: 'always' }
    })
  })
})
