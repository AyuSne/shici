import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { askQuestion, createThread, readThreadView, saveAnswer } from '../chat/threads'
import { openDatabase, type AppDatabase } from '../db/database'
import { migrate } from '../db/migrations'
import {
  prepareProviderCredential,
  resolveProviderCredential,
  type CredentialReadOptions
} from './credentials'
import { updateProviderCredential } from './credential-writes'
import { listModelProviders, readModelProvider, type ModelProviderRecord } from './providers'
import type { SecretStore } from './secret-store'

let directory: string
let database: AppDatabase

const now = '2026-11-21T10:00:00.000Z'

type FakeSecrets = SecretStore & {
  encryptCalls: string[]
  decryptCalls: string[]
}

/** 可逆的假加密；记录调用次数，用来证明环境模式既不加密也不解密。 */
function fakeSecrets(): FakeSecrets {
  const encryptCalls: string[] = []
  const decryptCalls: string[] = []
  return {
    encryptCalls,
    decryptCalls,
    encrypt(plain) {
      encryptCalls.push(plain)
      return `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`
    },
    decrypt(sealed) {
      decryptCalls.push(sealed)
      return sealed.startsWith('sealed:')
        ? Buffer.from(sealed.slice('sealed:'.length), 'base64').toString('utf8')
        : null
    }
  }
}

let secrets: FakeSecrets

/** 与 fakeSecrets 相同格式的密文，但不用替身加密——避免测试准备混进调用计数。 */
function sealed(plain: string): string {
  return `sealed:${Buffer.from(plain, 'utf8').toString('base64')}`
}

const throwingSecrets: SecretStore = {
  encrypt: () => 'sealed:unused',
  decrypt: () => {
    throw new Error('DPAPI 解不开')
  }
}

const nullSecrets: SecretStore = {
  encrypt: () => 'sealed:unused',
  decrypt: () => null
}

type ProviderSeed = {
  id?: string
  authMode?: 'stored' | 'env'
  envVar?: string | null
  secretCiphertext?: string | null
  source?: 'builtin' | 'custom'
  verification?: 'verified' | 'unverified'
}

function insertProvider(seed: ProviderSeed = {}): string {
  const id = seed.id ?? 'provider-1'
  database
    .prepare(
      `INSERT INTO model_provider (
         id, provider_key, display_name, protocol, base_url, auth_mode, env_var,
         secret_ciphertext, retry_policy, verification, last_error, last_checked_at,
         last_verified_at, source, catalog_provider_id, default_model_id, created_at, updated_at
       ) VALUES (?, ?, '测试提供商', 'openai-completions', 'https://api.example.com',
                 ?, ?, ?, '{"mode":"normal"}', ?, NULL, NULL, NULL, ?, NULL, NULL, ?, ?)`
    )
    .run(
      id,
      `key-${id}`,
      seed.authMode ?? 'stored',
      seed.envVar === undefined ? null : seed.envVar,
      seed.secretCiphertext === undefined ? null : seed.secretCiphertext,
      seed.verification ?? 'verified',
      seed.source ?? 'builtin',
      now,
      now
    )
  database
    .prepare(
      `INSERT INTO model_provider_model (
         id, provider_id, model_id, display_name, api, base_url, context_window, max_tokens,
         input, reasoning, source, sort, created_at, updated_at
       ) VALUES (?, ?, 'test-model', 'test-model', 'openai-completions', NULL, NULL, NULL,
                 'text', 0, 'manual', 0, ?, ?)`
    )
    .run(`model-${id}`, id, now, now)
  return id
}

function recordOf(id: string): ModelProviderRecord {
  const record = readModelProvider(database, id)
  if (record === null) throw new Error(`provider ${id} 不在库里`)
  return record
}

function options(env: NodeJS.ProcessEnv = {}): CredentialReadOptions {
  return { secrets, env }
}

function seedHistory(): { threadId: string; before: ReturnType<typeof readThreadView> } {
  const created = createThread(database, { main: { kind: 'none' } })
  if (created.status !== 'created') throw new Error('线程没建起来')
  const asked = askQuestion(database, { threadId: created.thread.id, text: '问题' })
  if (asked.status !== 'asked') throw new Error('问题没写进去')
  const saved = saveAnswer(database, {
    threadId: created.thread.id,
    questionId: asked.questionId,
    text: '回答',
    thinking: '',
    phase: 'done'
  })
  if (saved.status !== 'saved') throw new Error('回答没存上')
  database
    .prepare(
      `INSERT INTO pin (
         id, thread_id, thread_title, answer_id, turn_index, model, captured_text,
         char_start, char_end, target_kind, created_at
       ) VALUES ('pin-credential', ?, '新的学习', ?, 0, 'test-model', '回答', 0, 2,
                 'unfiled', ?)`
    )
    .run(created.thread.id, saved.thread.turns[0]?.answer?.id ?? '', now)
  return { threadId: created.thread.id, before: readThreadView(database, created.thread.id) }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'english-learning-credentials-'))
  database = openDatabase(join(directory, 'test.db'))
  migrate(database)
  secrets = fakeSecrets()
})

afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

describe('resolveProviderCredential', () => {
  it('本机密文解密抛错时明确报解不开，不当作缺失，也不改用环境变量', () => {
    const id = insertProvider({ secretCiphertext: 'sealed:broken', envVar: 'DEEPSEEK_API_KEY' })

    const resolved = resolveProviderCredential(recordOf(id), {
      secrets: throwingSecrets,
      env: { DEEPSEEK_API_KEY: 'sk-env-must-not-be-used' }
    })

    expect(resolved).toEqual({ state: 'missing', problem: { kind: 'stored-decrypt-failed' } })
  })

  it('本机密文解密返回 null 时同样明确报解不开，不静默视为缺失', () => {
    const id = insertProvider({ secretCiphertext: 'not-a-sealed-value' })

    const resolved = resolveProviderCredential(recordOf(id), {
      secrets: nullSecrets,
      env: { DEEPSEEK_API_KEY: 'sk-env-must-not-be-used' }
    })

    expect(resolved).toEqual({ state: 'missing', problem: { kind: 'stored-decrypt-failed' } })
  })

  it('本机模式没有密文时是缺失，不是解不开', () => {
    const id = insertProvider({ secretCiphertext: null })

    expect(resolveProviderCredential(recordOf(id), options())).toEqual({
      state: 'missing',
      problem: { kind: 'stored-missing' }
    })
  })

  it('环境模式忽略库里遗留的旧密文：不解密，环境变量有值就用', () => {
    const id = insertProvider({
      authMode: 'env',
      envVar: 'MY_PROVIDER_KEY',
      secretCiphertext: 'sealed:stale-ciphertext'
    })

    const resolved = resolveProviderCredential(
      recordOf(id),
      options({ MY_PROVIDER_KEY: 'env-secret' })
    )

    expect(resolved).toEqual({ state: 'env', apiKey: 'env-secret', envVar: 'MY_PROVIDER_KEY' })
    expect(secrets.decryptCalls).toEqual([])
  })

  it('环境变量缺失时点名变量，旧密文也绝不顶上', () => {
    const id = insertProvider({
      authMode: 'env',
      envVar: 'MY_PROVIDER_KEY',
      secretCiphertext: 'sealed:stale-ciphertext'
    })

    const resolved = resolveProviderCredential(recordOf(id), options())

    expect(resolved).toEqual({
      state: 'missing',
      problem: { kind: 'env-missing', envVar: 'MY_PROVIDER_KEY' }
    })
    expect(secrets.decryptCalls).toEqual([])
  })

  it('环境模式没填变量名时明确报变量名没设置', () => {
    const id = insertProvider({ authMode: 'env', envVar: '  ' })

    expect(resolveProviderCredential(recordOf(id), options())).toEqual({
      state: 'missing',
      problem: { kind: 'env-var-unset' }
    })
  })

  it('变量名撞上对象继承属性时按缺失处理并点名变量，不抛 TypeError', () => {
    for (const [index, envVar] of ['constructor', '__proto__', 'toString'].entries()) {
      const id = insertProvider({
        id: `provider-inherited-${index}`,
        authMode: 'env',
        envVar
      })

      expect(() => resolveProviderCredential(recordOf(id), options()), envVar).not.toThrow()
      expect(resolveProviderCredential(recordOf(id), options()), envVar).toEqual({
        state: 'missing',
        problem: { kind: 'env-missing', envVar }
      })
    }
  })

  it('真实 process.env 上的继承字段也按缺失处理，设置页仍能读出三态', () => {
    const id = insertProvider({ authMode: 'env', envVar: 'constructor' })

    // process.env.constructor 继承自 Object.prototype；不读、不打印任何真实值。
    expect(() =>
      resolveProviderCredential(recordOf(id), { secrets, env: process.env })
    ).not.toThrow()
    expect(resolveProviderCredential(recordOf(id), { secrets, env: process.env })).toEqual({
      state: 'missing',
      problem: { kind: 'env-missing', envVar: 'constructor' }
    })
    expect(() =>
      listModelProviders(database, { secrets, env: process.env })
    ).not.toThrow()
    expect(listModelProviders(database, { secrets, env: process.env })[0]).toMatchObject({
      keyState: 'missing',
      envVar: 'constructor',
      credentialError: null
    })
  })

  it('自有属性但值不是字符串时也算缺失，不对它调用 trim', () => {
    const id = insertProvider({ authMode: 'env', envVar: 'E2E_NON_STRING_KEY' })
    const env = { E2E_NON_STRING_KEY: 42 } as unknown as NodeJS.ProcessEnv

    expect(() => resolveProviderCredential(recordOf(id), options(env))).not.toThrow()
    expect(resolveProviderCredential(recordOf(id), options(env))).toEqual({
      state: 'missing',
      problem: { kind: 'env-missing', envVar: 'E2E_NON_STRING_KEY' }
    })
  })
})

describe('prepareProviderCredential', () => {
  it('本机模式加密一次并给出三列', () => {
    const prepared = prepareProviderCredential(secrets, {
      authMode: 'stored',
      envVar: 'MY_PROVIDER_KEY',
      apiKey: ' sk-new-key '
    })

    expect(prepared).toEqual({
      ok: true,
      authMode: 'stored',
      envVar: 'MY_PROVIDER_KEY',
      secretCiphertext: sealed('sk-new-key')
    })
    expect(secrets.encryptCalls).toEqual(['sk-new-key'])
  })

  it('环境模式即使请求带着 key 也不加密、不落密文', () => {
    const prepared = prepareProviderCredential(secrets, {
      authMode: 'env',
      envVar: 'MY_PROVIDER_KEY',
      apiKey: 'sk-must-be-ignored'
    })

    expect(prepared).toEqual({
      ok: true,
      authMode: 'env',
      envVar: 'MY_PROVIDER_KEY',
      secretCiphertext: null
    })
    expect(secrets.encryptCalls).toEqual([])
  })

  it('环境模式没填环境变量名、或变量名不合法时拒绝', () => {
    expect(
      prepareProviderCredential(secrets, { authMode: 'env', envVar: '  ', apiKey: '' })
    ).toEqual({ ok: false, reason: 'invalid-env-var' })
    expect(
      prepareProviderCredential(secrets, {
        authMode: 'env',
        envVar: '2BAD-NAME',
        apiKey: ''
      })
    ).toEqual({ ok: false, reason: 'invalid-env-var' })
  })

  it('本机模式没有 key 时拒绝，不写半条配置', () => {
    expect(
      prepareProviderCredential(secrets, { authMode: 'stored', envVar: '', apiKey: '   ' })
    ).toEqual({ ok: false, reason: 'missing-key' })
    expect(secrets.encryptCalls).toEqual([])
  })

  it('允许把空密钥先存成缺失草稿：显式开关下本机模式留空不加密', () => {
    expect(
      prepareProviderCredential(secrets, {
        authMode: 'stored',
        envVar: 'LOCAL_ENV',
        apiKey: '',
        allowMissingStoredKey: true
      })
    ).toEqual({
      ok: true,
      authMode: 'stored',
      envVar: 'LOCAL_ENV',
      secretCiphertext: null
    })
    expect(secrets.encryptCalls).toEqual([])
  })
})

describe('updateProviderCredential', () => {
  it('本机模式换密钥：重新加密、状态回到未验证，历史线程与钉住一条不动', () => {
    const id = insertProvider({
      secretCiphertext: sealed('sk-old-key'),
      verification: 'verified'
    })
    const history = seedHistory()

    const result = updateProviderCredential(database, secrets, {
      providerId: id,
      authMode: 'stored',
      envVar: 'DEEPSEEK_API_KEY',
      apiKey: 'sk-new-key',
      confirmClearStored: false
    })

    expect(result).toEqual({ status: 'saved', authMode: 'stored', clearedStored: false })
    const provider = recordOf(id)
    expect(provider.authMode).toBe('stored')
    expect(provider.envVar).toBe('DEEPSEEK_API_KEY')
    expect(provider.secretCiphertext).toBe(sealed('sk-new-key'))
    expect(provider.verification).toBe('unverified')
    expect(provider.lastError).toBeNull()
    expect(provider.lastVerifiedAt).toBeNull()
    expect(readThreadView(database, history.threadId)).toEqual(history.before)
    expect(database.prepare('SELECT COUNT(*) AS count FROM pin').get()).toEqual({ count: 1 })
  })

  it('本机模式显式清除密钥：密文清空、显示缺失，历史不受影响', () => {
    const id = insertProvider({ secretCiphertext: sealed('sk-old-key') })
    const history = seedHistory()

    expect(
      updateProviderCredential(database, secrets, {
        providerId: id,
        authMode: 'stored',
        envVar: '',
        apiKey: '',
        confirmClearStored: false,
        clearStoredKey: true
      })
    ).toEqual({ status: 'saved', authMode: 'stored', clearedStored: true })

    expect(recordOf(id).secretCiphertext).toBeNull()
    expect(readThreadView(database, history.threadId)).toEqual(history.before)
    expect(database.prepare('SELECT COUNT(*) AS count FROM pin').get()).toEqual({ count: 1 })
  })

  it('本机切到环境但没显式确认时拒绝，原配置完全不变', () => {
    const ciphertext = sealed('sk-stored-key')
    const id = insertProvider({ secretCiphertext: ciphertext, envVar: 'DEEPSEEK_API_KEY' })

    const result = updateProviderCredential(database, secrets, {
      providerId: id,
      authMode: 'env',
      envVar: 'NEW_ENV_NAME',
      apiKey: 'sk-carried-key',
      confirmClearStored: false
    })

    expect(result).toEqual({ status: 'rejected', reason: 'confirm-required' })
    const provider = recordOf(id)
    expect(provider.authMode).toBe('stored')
    expect(provider.envVar).toBe('DEEPSEEK_API_KEY')
    expect(provider.secretCiphertext).toBe(ciphertext)
    expect(secrets.encryptCalls).toEqual([])
    expect(secrets.decryptCalls).toEqual([])
  })

  it('确认后切到环境：一次更新里清空密文，且请求带的 key 不解密也不加密', () => {
    const id = insertProvider({
      secretCiphertext: sealed('sk-stored-key'),
      envVar: 'DEEPSEEK_API_KEY',
      verification: 'verified'
    })

    const result = updateProviderCredential(database, secrets, {
      providerId: id,
      authMode: 'env',
      envVar: 'NEW_ENV_NAME',
      apiKey: 'sk-carried-key',
      confirmClearStored: true
    })

    expect(result).toEqual({ status: 'saved', authMode: 'env', clearedStored: true })
    const provider = recordOf(id)
    expect(provider.authMode).toBe('env')
    expect(provider.envVar).toBe('NEW_ENV_NAME')
    expect(provider.secretCiphertext).toBeNull()
    expect(provider.verification).toBe('unverified')
    expect(secrets.encryptCalls).toEqual([])
    expect(secrets.decryptCalls).toEqual([])
  })

  it('已经是环境模式时再保存：旧密文清掉，请求带 key 也不加密', () => {
    const id = insertProvider({
      authMode: 'env',
      envVar: 'OLD_ENV',
      secretCiphertext: 'sealed:stale'
    })

    const result = updateProviderCredential(database, secrets, {
      providerId: id,
      authMode: 'env',
      envVar: 'NEW_ENV',
      apiKey: 'sk-ignored',
      confirmClearStored: false
    })

    expect(result).toEqual({ status: 'saved', authMode: 'env', clearedStored: true })
    expect(recordOf(id).secretCiphertext).toBeNull()
    expect(recordOf(id).envVar).toBe('NEW_ENV')
    expect(secrets.encryptCalls).toEqual([])
    expect(secrets.decryptCalls).toEqual([])
  })

  it('环境模式只换变量名时也回到未验证，因为读的凭据换了', () => {
    const id = insertProvider({
      authMode: 'env',
      envVar: 'OLD_ENV',
      verification: 'verified'
    })

    expect(
      updateProviderCredential(database, secrets, {
        providerId: id,
        authMode: 'env',
        envVar: 'NEW_ENV',
        apiKey: '',
        confirmClearStored: false
      })
    ).toEqual({ status: 'saved', authMode: 'env', clearedStored: false })
    expect(recordOf(id)).toMatchObject({
      authMode: 'env',
      envVar: 'NEW_ENV',
      verification: 'unverified'
    })
  })

  it('环境找不到变量名或变量名不合法时拒绝', () => {
    const id = insertProvider({ authMode: 'env', envVar: 'OLD_ENV' })

    expect(
      updateProviderCredential(database, secrets, {
        providerId: id,
        authMode: 'env',
        envVar: '',
        apiKey: '',
        confirmClearStored: false
      })
    ).toEqual({ status: 'rejected', reason: 'invalid-env-var' })
    expect(
      updateProviderCredential(database, secrets, {
        providerId: id,
        authMode: 'env',
        envVar: 'bad name',
        apiKey: '',
        confirmClearStored: false
      })
    ).toEqual({ status: 'rejected', reason: 'invalid-env-var' })
  })

  it('本机模式没有密文又不填新 key 时拒绝；provider 不存在时明确缺失', () => {
    const id = insertProvider({ secretCiphertext: null })
    expect(
      updateProviderCredential(database, secrets, {
        providerId: id,
        authMode: 'stored',
        envVar: '',
        apiKey: '',
        confirmClearStored: false
      })
    ).toEqual({ status: 'rejected', reason: 'missing-key' })
    expect(
      updateProviderCredential(database, secrets, {
        providerId: 'missing',
        authMode: 'stored',
        envVar: '',
        apiKey: 'sk-x',
        confirmClearStored: false
      })
    ).toEqual({ status: 'missing' })
  })

  it('环境模式残留密文不能直接变成本机密钥：不填新 key 时拒绝', () => {
    const id = insertProvider({
      authMode: 'env',
      envVar: 'OLD_ENV',
      secretCiphertext: 'sealed:stale'
    })

    expect(
      updateProviderCredential(database, secrets, {
        providerId: id,
        authMode: 'stored',
        envVar: 'OLD_ENV',
        apiKey: '',
        confirmClearStored: false
      })
    ).toEqual({ status: 'rejected', reason: 'missing-key' })

    expect(recordOf(id)).toMatchObject({
      authMode: 'env',
      envVar: 'OLD_ENV',
      secretCiphertext: 'sealed:stale'
    })
  })

  it('本机模式只改环境变量名、不动密钥时保持原密文与已验证状态', () => {
    const ciphertext = sealed('sk-keep-me')
    const id = insertProvider({ secretCiphertext: ciphertext, verification: 'verified' })

    expect(
      updateProviderCredential(database, secrets, {
        providerId: id,
        authMode: 'stored',
        envVar: 'FUTURE_ENV',
        apiKey: '',
        confirmClearStored: false
      })
    ).toEqual({ status: 'saved', authMode: 'stored', clearedStored: false })

    const provider = recordOf(id)
    expect(provider.secretCiphertext).toBe(ciphertext)
    expect(provider.envVar).toBe('FUTURE_ENV')
    expect(provider.verification).toBe('verified')
    expect(secrets.encryptCalls).toEqual([])
  })
})
