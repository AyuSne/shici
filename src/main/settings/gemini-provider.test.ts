import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { resolveChatConfig } from '../chat/config'
import { createCustomProvider } from './provider-editing'
import {
  activateModelProvider,
  addBuiltinProvider,
  setDefaultProviderModel
} from './provider-writes'
import { readModelProvider, readProviderModels, listModelProviders } from './providers'
import type { SecretStore } from './secret-store'

let directory: string
let database: AppDatabase

const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${plain}`,
  decrypt: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-gemini-provider-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function addGemini(apiKey = 'synthetic-gemini-key'): string {
  const added = addBuiltinProvider(
    database,
    secrets,
    { catalogProviderId: 'gemini', apiKey },
    { now: '2026-11-21T00:00:00.000Z' }
  )
  if (added.status !== 'saved') {
    throw new Error(`Gemini 没存上：${added.reason}`)
  }
  expect(added.providerKey).toBe('gemini')
  return added.providerId
}

describe('Google Gemini 内置入口', () => {
  it('从目录添加：协议、官方端点、环境变量与模型目录都来自目录，密钥只写密文', () => {
    const providerId = addGemini()

    expect(readModelProvider(database, providerId)).toMatchObject({
      providerKey: 'gemini',
      displayName: 'Google Gemini',
      protocol: 'google-generative-ai',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      envVar: 'GEMINI_API_KEY',
      source: 'builtin',
      catalogProviderId: 'gemini',
      secretCiphertext: 'sealed:synthetic-gemini-key'
    })
    const models = readProviderModels(database, providerId)
    expect(models[0]?.api).toBe('google-generative-ai')
    expect(models.map((model) => model.modelId)).toContain('gemini-2.5-flash')
    expect(models.every((model) => model.api === 'google-generative-ai')).toBe(true)
    expect(listModelProviders(database, { secrets, env: {} })[0]).toMatchObject({
      protocol: 'google-generative-ai',
      keyState: 'stored'
    })
    expect(
      listModelProviders(database, { secrets, env: {} })[0]?.apiKeyMask
    ).not.toContain('synthetic-gemini-key')
  })

  it('使用中的 Gemini 解析出 Gemini 协议描述符；切默认模型后下一次调用才换模型', () => {
    const providerId = addGemini()
    activateModelProvider(database, providerId)

    const config = resolveChatConfig(database, secrets, {})
    expect(config).toMatchObject({
      apiKey: 'synthetic-gemini-key',
      descriptor: {
        provider: 'gemini',
        api: 'google-generative-ai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        reasoning: true
      }
    })
    expect(config?.model).toBe(readProviderModels(database, providerId)[0]?.modelId)

    const pro = readProviderModels(database, providerId).find(
      (model) => model.modelId === 'gemini-2.5-pro'
    )!
    expect(setDefaultProviderModel(database, providerId, pro.id)).toMatchObject({
      status: 'saved'
    })

    const switched = resolveChatConfig(database, secrets, {})
    expect(switched).toMatchObject({
      model: 'gemini-2.5-pro',
      descriptor: {
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        api: 'google-generative-ai',
        contextWindow: 1048576,
        maxTokens: 65536
      }
    })
  })

  it('环境变量模式只存变量名；GEMINI_API_KEY 缺失时发送前明确报缺失，不换源', () => {
    const added = addBuiltinProvider(database, secrets, {
      catalogProviderId: 'gemini',
      authMode: 'env',
      apiKey: ''
    })
    if (added.status !== 'saved') throw new Error('没存上')
    activateModelProvider(database, added.providerId)

    expect(readModelProvider(database, added.providerId)).toMatchObject({
      authMode: 'env',
      envVar: 'GEMINI_API_KEY',
      secretCiphertext: null
    })
    expect(
      listModelProviders(database, { secrets, env: {} })[0]
    ).toMatchObject({ keyState: 'missing', envVar: 'GEMINI_API_KEY' })

    const missing = resolveChatConfig(database, secrets, {})
    expect(missing).toMatchObject({
      apiKey: '',
      missingCredential: true,
      credentialProblem: { kind: 'env-missing', envVar: 'GEMINI_API_KEY' }
    })

    const present = resolveChatConfig(database, secrets, {
      GEMINI_API_KEY: 'synthetic-env-gemini-key'
    })
    expect(present).toMatchObject({
      apiKey: 'synthetic-env-gemini-key',
      descriptor: { api: 'google-generative-ai' }
    })
    expect(present?.missingCredential).toBeUndefined()
  })
})

describe('Gemini API 自定义协议', () => {
  it('自定义 provider 可选 Gemini API；模型行保留该协议，描述符按它构造', () => {
    const created = createCustomProvider(
      database,
      secrets,
      {
        providerKey: 'my-gemini',
        displayName: '我的 Gemini 中转',
        protocol: 'google-generative-ai',
        baseUrl: 'https://gemini-gateway.example.com/v1beta',
        apiKey: 'synthetic-relay-key',
        model: { modelId: 'relay-gemini-model', reasoning: true }
      },
      { now: '2026-11-21T00:00:00.000Z' }
    )
    if (created.status !== 'saved') throw new Error(`没存上：${created.reason}`)
    activateModelProvider(database, created.providerId)

    expect(readModelProvider(database, created.providerId)).toMatchObject({
      protocol: 'google-generative-ai',
      baseUrl: 'https://gemini-gateway.example.com/v1beta',
      source: 'custom'
    })
    expect(readProviderModels(database, created.providerId)[0]).toMatchObject({
      modelId: 'relay-gemini-model',
      api: 'google-generative-ai',
      reasoning: true
    })

    const config = resolveChatConfig(database, secrets, {})
    expect(config).toMatchObject({
      apiKey: 'synthetic-relay-key',
      model: 'relay-gemini-model',
      baseUrl: 'https://gemini-gateway.example.com/v1beta',
      descriptor: {
        provider: 'my-gemini',
        model: 'relay-gemini-model',
        api: 'google-generative-ai',
        baseUrl: 'https://gemini-gateway.example.com/v1beta',
        // 目录里没有的模型按通用容量兜底，不冒充任何厂商元数据。
        contextWindow: 1000000,
        maxTokens: 128000,
        reasoning: true
      }
    })
  })
})
