import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const generator = resolve(root, 'scripts/generate-model-catalog.mjs')
const overridesFile = resolve(root, 'src/shared/model-provider-overrides.json')
const catalogFile = resolve(root, 'src/shared/model-catalog.json')

function generate(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [generator, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

function parseGeneratedCatalog() {
  const result = generate(['--stdout'])
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as {
    schemaVersion: number
    piVersion: string
    providers: Array<{
      id: string
      piProvider: string
      protocol: string | null
      models: Array<{
        id: string
        api: string
        thinkingLevelMap?: unknown
        compat?: unknown
        cost: unknown
        contextWindow: number
        maxTokens: number
      }>
    }>
  }
}

/**
 * 目录是构建期数据，不是随手的常量：这里通过生成脚本的公开命令行观察结果。
 * 端点、环境变量与鉴权头以人工核对表为准，不允许把 pi 的 coding 套餐地址带进来。
 */
describe('共享模型目录生成', () => {
  it('生成九个入口的协议、默认端点、环境变量与鉴权头', () => {
    const result = generate(['--stdout'])

    expect(result.status, result.stderr).toBe(0)
    const catalog = JSON.parse(result.stdout) as {
      providers: Array<{
        id: string
        displayName: string
        protocol: string | null
        baseUrl: string | null
        envVar: string
        auth: { header: string; scheme?: string }
      }>
    }

    expect(
      catalog.providers.map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        envVar: provider.envVar,
        header: provider.auth.header,
        scheme: provider.auth.scheme
      }))
    ).toEqual([
      {
        id: 'deepseek',
        displayName: 'DeepSeek',
        protocol: 'openai-completions',
        baseUrl: 'https://api.deepseek.com',
        envVar: 'DEEPSEEK_API_KEY',
        header: 'Authorization',
        scheme: 'Bearer'
      },
      {
        id: 'kimi',
        displayName: 'Kimi',
        protocol: 'openai-completions',
        baseUrl: 'https://api.moonshot.cn/v1',
        envVar: 'MOONSHOT_API_KEY',
        header: 'Authorization',
        scheme: 'Bearer'
      },
      {
        id: 'glm',
        displayName: '智谱 GLM',
        protocol: 'openai-completions',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        envVar: 'ZAI_API_KEY',
        header: 'Authorization',
        scheme: 'Bearer'
      },
      {
        id: 'minimax',
        displayName: 'MiniMax',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.minimax.io/anthropic',
        envVar: 'MINIMAX_API_KEY',
        header: 'x-api-key',
        scheme: undefined
      },
      {
        id: 'openai',
        displayName: 'OpenAI',
        protocol: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        envVar: 'OPENAI_API_KEY',
        header: 'Authorization',
        scheme: 'Bearer'
      },
      {
        id: 'anthropic',
        displayName: 'Anthropic',
        protocol: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
        envVar: 'ANTHROPIC_API_KEY',
        header: 'x-api-key',
        scheme: undefined
      },
      {
        id: 'gemini',
        displayName: 'Google Gemini',
        protocol: 'google-generative-ai',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        envVar: 'GEMINI_API_KEY',
        header: 'x-goog-api-key',
        scheme: undefined
      },
      {
        id: 'xai',
        displayName: 'xAI',
        protocol: 'openai-responses',
        baseUrl: 'https://api.x.ai/v1',
        envVar: 'XAI_API_KEY',
        header: 'Authorization',
        scheme: 'Bearer'
      },
      {
        id: 'opencode-go',
        displayName: 'OpenCode GO',
        protocol: null,
        baseUrl: null,
        envVar: 'OPENCODE_GO_API_KEY',
        header: 'Authorization',
        scheme: 'Bearer'
      }
    ])
  })

  it('重复生成逐字一致，产物已提交且不写时间戳', () => {
    const first = generate(['--stdout'])
    const second = generate(['--stdout'])

    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    expect(second.stdout).toBe(first.stdout)
    expect(first.stdout.endsWith('\n')).toBe(true)
    expect(readFileSync(catalogFile, 'utf8')).toBe(first.stdout)
    expect(first.stdout).not.toMatch(
      /generatedAt|lastGenerated|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
    )
    expect(generate(['--check']).status).toBe(0)
  })

  it('--check 能发现未重新生成的产物', () => {
    const directory = mkdtempSync(join(tmpdir(), 'model-catalog-check-'))
    try {
      const stale = join(directory, 'model-catalog.json')
      writeFileSync(stale, '{}\n', 'utf8')

      const result = generate(['--check', '--output', stale])

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('不是最新')
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('生成过程不依赖网络', () => {
    const directory = mkdtempSync(join(tmpdir(), 'model-catalog-offline-'))
    try {
      const preload = join(directory, 'disable-network.mjs')
      writeFileSync(
        preload,
        "globalThis.fetch = () => { throw new Error('network disabled') }\n",
        'utf8'
      )

      const result = spawnSync(
        process.execPath,
        ['--import', pathToFileURL(preload).href, generator, '--stdout'],
        { cwd: root, encoding: 'utf8' }
      )

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toBe(readFileSync(catalogFile, 'utf8'))

      const source = readFileSync(generator, 'utf8')
      expect(source).not.toMatch(/from ['"]node:(?:http|https|net)['"]/)
      expect(source).not.toMatch(/\bfetch\s*\(/)
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  it('模型清单与思考元数据来自已安装的 pi 目录', async () => {
    const { getBuiltinModels } = await import(
      '@earendil-works/pi-ai/providers/all'
    )
    const modelProtocols = [
      'openai-completions',
      'openai-responses',
      'anthropic-messages',
      'google-generative-ai'
    ]
    const overrides = JSON.parse(readFileSync(overridesFile, 'utf8')) as {
      providers: Array<{
        id: string
        piProvider: string
        protocol: string | null
      }>
    }
    const catalog = parseGeneratedCatalog()

    for (const entry of overrides.providers) {
      const sourceModels = getBuiltinModels(
        entry.piProvider as Parameters<typeof getBuiltinModels>[0]
      )
      const expectedIds = sourceModels
        .filter(
          (model) =>
            (model.type === undefined || model.type === 'chat') &&
            modelProtocols.includes(model.api) &&
            (entry.protocol === null || model.api === entry.protocol)
        )
        .map((model) => model.id)
        .sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0
        )
      const provider = catalog.providers.find(
        (candidate) => candidate.id === entry.id
      )

      expect(provider, entry.id).toBeDefined()
      if (!provider) {
        continue
      }
      expect(provider.models.map((model) => model.id)).toEqual(expectedIds)
      for (const model of provider.models) {
        const source = sourceModels.find(
          (candidate) => candidate.id === model.id
        )
        expect(source, `${entry.id}/${model.id}`).toBeDefined()
        if (!source) {
          continue
        }
        expect(model.api).toBe(entry.protocol ?? source.api)
        expect(model.thinkingLevelMap).toEqual(source.thinkingLevelMap)
        expect(model.compat).toEqual(source.compat)
        expect(model.cost).toEqual(source.cost)
        expect(model.contextWindow).toBe(source.contextWindow)
        expect(model.maxTokens).toBe(source.maxTokens)
      }
    }
  })

  it('构建与开发前自动生成目录', () => {
    const pkg = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    expect(pkg.scripts['generate:catalog']).toBe(
      'node scripts/generate-model-catalog.mjs'
    )
    expect(pkg.scripts.prebuild).toBe('npm run generate:catalog')
    expect(pkg.scripts.predev).toBe('npm run generate:catalog')
  })

  it('拒绝把 pi 的 coding 套餐端点写进人工表', async () => {
    const { buildModelCatalog } = await import(pathToFileURL(generator).href)

    expect(() =>
      buildModelCatalog({
        overrides: {
          schemaVersion: 1,
          providers: [
            {
              id: 'glm-coding',
              displayName: 'GLM Coding',
              piProvider: 'zai',
              protocol: 'openai-completions',
              baseUrl: 'https://api.z.ai/api/coding/paas/v4',
              envVar: 'GLM_API_KEY',
              auth: { header: 'Authorization', scheme: 'Bearer' },
              sources: [
                {
                  title: 'official',
                  url: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction'
                }
              ]
            }
          ]
        },
        modelsByProvider: {
          zai: [
            {
              id: 'glm-5.3',
              name: 'GLM-5.3',
              api: 'openai-completions',
              provider: 'zai',
              baseUrl: 'https://api.z.ai/api/coding/paas/v4',
              reasoning: true,
              input: ['text'],
              contextWindow: 1,
              maxTokens: 1,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        },
        piVersion: 'test'
      })
    ).toThrow(/coding 套餐入口/)
  })

  it('拒绝不合法的环境变量名与空来源表', async () => {
    const { buildModelCatalog } = await import(pathToFileURL(generator).href)
    const model = {
      id: 'm',
      name: 'M',
      api: 'openai-completions',
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      reasoning: true,
      input: ['text'],
      contextWindow: 1,
      maxTokens: 1,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }
    const provider = {
      id: 'bad',
      displayName: 'Bad',
      piProvider: 'deepseek',
      protocol: 'openai-completions',
      baseUrl: 'https://api.deepseek.com',
      envVar: 'bad-env',
      auth: { header: 'Authorization', scheme: 'Bearer' },
      sources: [{ title: 'official', url: 'https://api-docs.deepseek.com/en/' }]
    }

    expect(() =>
      buildModelCatalog({
        overrides: { schemaVersion: 1, providers: [provider] },
        modelsByProvider: { deepseek: [model] },
        piVersion: 'test'
      })
    ).toThrow(/envVar/)

    expect(() =>
      buildModelCatalog({
        overrides: {
          schemaVersion: 1,
          providers: [{ ...provider, envVar: 'BAD_API_KEY', sources: [] }]
        },
        modelsByProvider: { deepseek: [model] },
        piVersion: 'test'
      })
    ).toThrow(/官方来源/)
  })
})
