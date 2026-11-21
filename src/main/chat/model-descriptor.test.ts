import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findModelProvider, findCatalogModel } from '../../shared/model-catalog'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import { readProviderModels, readModelProvider } from '../settings/providers'
import { addBuiltinProvider } from '../settings/provider-writes'
import type { SecretStore } from '../settings/secret-store'
import {
  UNKNOWN_CONTEXT_WINDOW,
  UNKNOWN_MAX_TOKENS,
  descriptorOfCatalogModel,
  descriptorOfProvider,
  readEnvChatConfig
} from './model-descriptor'

let directory: string
let database: AppDatabase

const secrets: SecretStore = {
  encrypt: (plain) => `sealed:${plain}`,
  decrypt: (sealed) => (sealed.startsWith('sealed:') ? sealed.slice('sealed:'.length) : null)
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-descriptor-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function addDeepSeek(): string {
  const result = addBuiltinProvider(database, secrets, {
    catalogProviderId: 'deepseek',
    apiKey: 'sk-test'
  })
  if (result.status !== 'saved') throw new Error('没存上')
  return result.providerId
}

describe('descriptorOfProvider', () => {
  it('内置 provider 的描述符带着目录容量、思考映射与兼容开关', () => {
    const providerId = addDeepSeek()
    const provider = readModelProvider(database, providerId)!
    const model = readProviderModels(database, providerId)[0]!

    expect(descriptorOfProvider(provider, model)).toEqual({
      provider: 'deepseek',
      model: 'deepseek-flash',
      api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
      contextWindow: 1000000,
      maxTokens: 384000,
      input: ['text'],
      reasoning: true,
      thinkingLevelMap: { minimal: null, low: 'low', medium: null, high: 'high', max: 'max' },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: 'max_tokens',
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: 'deepseek',
        supportsStrictMode: true
      }
    })
  })

  it('模型行地址优先于 provider 地址；缺元数据的迁移模型按通用容量与 text 兜底，不冒充 DeepSeek', () => {
    database
      .prepare(
        `INSERT INTO model_provider (
           id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
           secret_ciphertext, retry_policy, verification, last_error, last_checked_at,
           last_verified_at, source, catalog_provider_id, default_model_id, created_at,
           updated_at
         ) VALUES ('provider-custom', 'custom-gateway', '自定义中转', 'openai-completions',
                   'https://gateway.example.com/v1', 'env', 'GATEWAY_KEY', NULL,
                   '{"mode":"normal"}', 'unverified', NULL, NULL, NULL, 'custom', NULL,
                   'model-custom', '2026-11-21T00:00:00.000Z', '2026-11-21T00:00:00.000Z')`
      )
      .run()
    database
      .prepare(
        `INSERT INTO model_provider_model (
           id, provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
           input, reasoning, thinking_level_map, compat, source, sort, created_at, updated_at
         ) VALUES ('model-custom', 'provider-custom', 'mystery-model', 'mystery-model',
                   'openai-completions', 'https://gateway.example.com/model', NULL, NULL,
                   'text', 0, NULL, NULL, 'manual', 0, '2026-11-21T00:00:00.000Z',
                   '2026-11-21T00:00:00.000Z')`
      )
      .run()

    const descriptor = descriptorOfProvider(
      readModelProvider(database, 'provider-custom')!,
      readProviderModels(database, 'provider-custom')[0]!
    )!

    expect(descriptor).toEqual({
      provider: 'custom-gateway',
      model: 'mystery-model',
      api: 'openai-completions',
      baseUrl: 'https://gateway.example.com/model',
      contextWindow: UNKNOWN_CONTEXT_WINDOW,
      maxTokens: UNKNOWN_MAX_TOKENS,
      input: ['text'],
      reasoning: false
    })
    expect(UNKNOWN_CONTEXT_WINDOW).toBe(1_000_000)
    expect(UNKNOWN_MAX_TOKENS).toBe(128_000)
    expect(descriptor.thinkingLevelMap).toBeUndefined()
    expect(descriptor.compat).toBeUndefined()
  })

  it('模型行的协议本版不认识时没有描述符：不发请求，也不猜成别的协议', () => {
    const providerId = addDeepSeek()
    database
      .prepare(`UPDATE model_provider_model SET api = 'mistral-conversations' WHERE provider_id = ?`)
      .run(providerId)

    expect(
      descriptorOfProvider(
        readModelProvider(database, providerId)!,
        readProviderModels(database, providerId)[0]!
      )
    ).toBeNull()
  })
})

describe('descriptorOfCatalogModel', () => {
  it('按入口与模型各自的目录元数据构造，Kimi / GLM 不共用 DeepSeek 描述', () => {
    const kimi = findModelProvider('kimi')!
    const glm = findModelProvider('glm')!
    const kimiModel = findCatalogModel('kimi', 'kimi-k3')!
    const glmModel = findCatalogModel('glm', 'glm-4.7')!

    expect(descriptorOfCatalogModel(kimiModel, kimi.baseUrl!, 'kimi')).toMatchObject({
      provider: 'kimi',
      model: 'kimi-k3',
      api: 'openai-completions',
      baseUrl: 'https://api.moonshot.cn/v1',
      contextWindow: 1048576,
      maxTokens: 1048576,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: 'low',
        medium: null,
        high: 'high',
        xhigh: null,
        max: 'max'
      },
      compat: { thinkingFormat: 'openai', supportsReasoningEffort: true }
    })
    expect(descriptorOfCatalogModel(glmModel, glm.baseUrl!, 'glm')).toMatchObject({
      provider: 'glm',
      model: 'glm-4.7',
      contextWindow: 204800,
      maxTokens: 131072,
      input: ['text'],
      compat: { thinkingFormat: 'zai' }
    })
  })
})

describe('readEnvChatConfig', () => {
  it('环境变量退路也解析出真实目录描述符，unknown 模型不克隆 DeepSeek 元数据', () => {
    const known = readEnvChatConfig({
      DEEPSEEK_API_KEY: 'env-key',
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:9999/v1',
      DEEPSEEK_MODEL: 'deepseek-v4-pro'
    })
    expect(known).toMatchObject({
      apiKey: 'env-key',
      baseUrl: 'http://127.0.0.1:9999/v1',
      model: 'deepseek-v4-pro',
      descriptor: {
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
        baseUrl: 'http://127.0.0.1:9999/v1',
        contextWindow: 1000000,
        maxTokens: 384000,
        reasoning: true
      }
    })

    const unknown = readEnvChatConfig({
      DEEPSEEK_API_KEY: 'env-key',
      DEEPSEEK_MODEL: 'some-local-model'
    })
    expect(unknown?.descriptor).toMatchObject({
      model: 'some-local-model',
      contextWindow: UNKNOWN_CONTEXT_WINDOW,
      maxTokens: UNKNOWN_MAX_TOKENS,
      input: ['text'],
      reasoning: false
    })
    expect(unknown?.descriptor.thinkingLevelMap).toBeUndefined()
    expect(readEnvChatConfig({})).toBeNull()
  })
})
