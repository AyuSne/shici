#!/usr/bin/env node
/**
 * 从已安装的 pi-ai 目录生成共享模型目录，再合并人工核对的端点/环境变量/鉴权头表。
 *
 * 约束：
 * - 不联网：只读 node_modules 里的 pi-ai 包与仓库内的覆盖表。
 * - 确定性：模型按 id 排序、字段顺序固定、不写时间戳；同一 pi 版本重复生成逐字一致。
 * - 人工表优先：单协议入口的协议、端点、环境变量、鉴权头一律取覆盖表，
 *   不把 pi 的 coding 套餐地址（zai coding、kimi-coding 等）带进产物。
 *
 * 用法：
 *   node scripts/generate-model-catalog.mjs                 写入 src/shared/model-catalog.json
 *   node scripts/generate-model-catalog.mjs --stdout        只输出到 stdout
 *   node scripts/generate-model-catalog.mjs --check         校验已提交产物是否最新
 *   node scripts/generate-model-catalog.mjs --output <path> 写到指定路径
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OVERRIDES_FILE = join(ROOT, 'src/shared/model-provider-overrides.json')
const DEFAULT_OUTPUT = join(ROOT, 'src/shared/model-catalog.json')

export const MODEL_PROTOCOLS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
])

const INPUT_MODALITIES = Object.freeze(['text', 'image'])
const PROVIDER_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const ENV_VAR = /^[A-Z][A-Z0-9_]*$/
const PI_PACKAGE = '@earendil-works/pi-ai'
const PI_CATALOG_ENTRY = `${PI_PACKAGE}/providers/all`
const OPENCODE_GO_BASE_PREFIX = 'https://opencode.ai/inference/go/'

/**
 * pi 里面向 coding agent 的套餐地址与协议入口不能出现在目录里。
 * 单协议入口的端点来自人工表；OpenCode GO 的模型地址必须来自它自己的网关。
 */
const FORBIDDEN_ENDPOINT_PARTS = Object.freeze([
  'api.z.ai/api/coding',
  'api.kimi.com/coding',
  'kimi-coding',
  'zai-coding',
  'qwen-token-plan',
  'xiaomi-token-plan'
])

function fail(message) {
  throw new Error(`模型目录：${message}`)
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${label} 必须是非空字符串`)
  }
  return value
}

function requireHttpsUrl(value, label) {
  requireText(value, label)
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${label} 不是合法 URL：${value}`)
  }
  if (url.protocol !== 'https:') {
    fail(`${label} 必须是 https：${value}`)
  }
  for (const part of FORBIDDEN_ENDPOINT_PARTS) {
    if (value.includes(part)) {
      fail(`${label} 不能使用 pi 的 coding 套餐入口：${value}`)
    }
  }
  return value
}

function requirePositiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} 必须是正整数`)
  }
  return value
}

function cloneJson(value, label) {
  if (!isPlainObject(value)) {
    fail(`${label} 必须是可序列化对象`)
  }
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    fail(`${label} 不能序列化为 JSON`)
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function readOverrides(path = OVERRIDES_FILE) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`读不到人工核对表 ${relative(ROOT, path)}：${error instanceof Error ? error.message : error}`)
  }
  return parsed
}

function normalizeThinkingLevelMap(value, label) {
  const map = cloneJson(value, label)
  for (const [level, mapped] of Object.entries(map)) {
    if (mapped !== null && typeof mapped !== 'string') {
      fail(`${label}.${level} 必须是字符串或 null`)
    }
  }
  return map
}

function normalizeInput(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} 必须是非空数组`)
  }
  for (const modality of value) {
    if (!INPUT_MODALITIES.includes(modality)) {
      fail(`${label} 含首版不支持的输入类型：${modality}`)
    }
  }
  if (!value.includes('text')) {
    fail(`${label} 必须支持 text`)
  }
  return [...value]
}

function normalizeCost(value, label) {
  if (!isPlainObject(value)) {
    fail(`${label} 必须是对象`)
  }
  const cost = cloneJson(value, label)
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (typeof cost[key] !== 'number' || !Number.isFinite(cost[key]) || cost[key] < 0) {
      fail(`${label}.${key} 必须是非负数`)
    }
  }
  return cost
}

/**
 * 只保留 #59 首版需要的可序列化 Model 元数据。
 * 明确保留 thinkingLevelMap 与 compat：后续 getSupportedThinkingLevels 做 high 降级要用，
 * 不能只留一个 reasoning 布尔。
 */
function normalizeModel(provider, source) {
  if (!isPlainObject(source)) {
    fail(`${provider.piProvider} 的模型数据不是对象`)
  }
  const modelId = requireText(source.id, `${provider.piProvider} 模型 id`)
  if (source.provider !== provider.piProvider) {
    fail(`${provider.piProvider} 的模型 ${modelId} 来源 provider 不一致：${source.provider}`)
  }
  if (source.type !== undefined && source.type !== 'chat') {
    return null
  }
  if (!MODEL_PROTOCOLS.includes(source.api)) {
    return null
  }
  if (provider.protocol !== null && source.api !== provider.protocol) {
    return null
  }

  const api = provider.protocol ?? source.api
  const model = {
    id: modelId,
    name: requireText(source.name, `${provider.piProvider}/${modelId} name`),
    api
  }

  if (provider.protocol === null) {
    model.baseUrl = requireHttpsUrl(source.baseUrl, `${provider.piProvider}/${modelId} baseUrl`)
  }

  if (typeof source.reasoning !== 'boolean') {
    fail(`${provider.piProvider}/${modelId} reasoning 必须是布尔值`)
  }
  model.reasoning = source.reasoning

  if (source.thinkingLevelMap !== undefined) {
    model.thinkingLevelMap = normalizeThinkingLevelMap(
      source.thinkingLevelMap,
      `${provider.piProvider}/${modelId} thinkingLevelMap`
    )
  }

  model.input = normalizeInput(source.input, `${provider.piProvider}/${modelId} input`)
  if (source.inputLimits !== undefined) {
    model.inputLimits = cloneJson(source.inputLimits, `${provider.piProvider}/${modelId} inputLimits`)
  }
  model.contextWindow = requirePositiveInteger(
    source.contextWindow,
    `${provider.piProvider}/${modelId} contextWindow`
  )
  model.maxTokens = requirePositiveInteger(
    source.maxTokens,
    `${provider.piProvider}/${modelId} maxTokens`
  )
  model.cost = normalizeCost(source.cost, `${provider.piProvider}/${modelId} cost`)

  for (const key of [
    'promptCache',
    'compat',
    'samplingParams',
    'samplingParamsByThinkingLevel'
  ]) {
    if (source[key] !== undefined) {
      model[key] = cloneJson(source[key], `${provider.piProvider}/${modelId} ${key}`)
    }
  }

  return model
}

function normalizeProvider(override, modelsByProvider) {
  if (!isPlainObject(override)) {
    fail('人工核对表的 provider 条目必须是对象')
  }
  const id = requireText(override.id, 'provider id')
  if (!PROVIDER_ID.test(id)) {
    fail(`provider id 不合法：${id}`)
  }
  const piProvider = requireText(override.piProvider, `${id} piProvider`)
  const rawModels = modelsByProvider[piProvider]
  if (!Array.isArray(rawModels) || rawModels.length === 0) {
    fail(`pi 内置 provider ${piProvider} 没有可用 chat 模型`)
  }

  const protocol = override.protocol
  if (protocol !== null && !MODEL_PROTOCOLS.includes(protocol)) {
    fail(`${id} 的协议不在首版四种协议内：${protocol}`)
  }
  const baseUrl =
    override.baseUrl === null || override.baseUrl === undefined
      ? null
      : requireHttpsUrl(override.baseUrl, `${id} baseUrl`)
  if (protocol === null && baseUrl !== null) {
    fail(`${id} 是多协议入口，不能设统一 baseUrl`)
  }
  if (protocol !== null && baseUrl === null) {
    fail(`${id} 是单协议入口，必须提供默认 baseUrl`)
  }

  const envVar = requireText(override.envVar, `${id} envVar`)
  if (!ENV_VAR.test(envVar)) {
    fail(`${id} 的 envVar 不是合法的环境变量名：${envVar}`)
  }

  if (!isPlainObject(override.auth)) {
    fail(`${id} 缺少 auth`)
  }
  const header = requireText(override.auth.header, `${id} auth.header`)
  const auth = { header }
  if (override.auth.scheme !== undefined) {
    auth.scheme = requireText(override.auth.scheme, `${id} auth.scheme`)
  }

  if (!Array.isArray(override.sources) || override.sources.length === 0) {
    fail(`${id} 至少需要一条官方来源`)
  }
  const sources = override.sources.map((source, index) => {
    if (!isPlainObject(source)) {
      fail(`${id} 的来源条目必须是对象`)
    }
    return {
      title: requireText(source.title, `${id} sources[${index}].title`),
      url: requireHttpsUrl(source.url, `${id} sources[${index}].url`)
    }
  })

  const models = []
  const seenModels = new Set()
  for (const source of rawModels) {
    const model = normalizeModel(
      { piProvider, protocol },
      source
    )
    if (!model) {
      continue
    }
    if (seenModels.has(model.id)) {
      fail(`${id} 的模型 id 重复：${model.id}`)
    }
    seenModels.add(model.id)
    models.push(model)
  }
  if (models.length === 0) {
    fail(`${id} 没有符合首版协议的 chat 模型`)
  }
  if (id === 'opencode-go') {
    for (const model of models) {
      if (!model.baseUrl.startsWith(OPENCODE_GO_BASE_PREFIX)) {
        fail(`${id} 的模型 ${model.id} 地址不在 OpenCode GO 网关下：${model.baseUrl}`)
      }
    }
  }
  models.sort((left, right) => compareText(left.id, right.id))

  const provider = {
    id,
    displayName: requireText(override.displayName, `${id} displayName`),
    piProvider,
    protocol,
    baseUrl,
    envVar,
    auth
  }
  if (override.region !== undefined) {
    provider.region = requireText(override.region, `${id} region`)
  }
  if (override.notes !== undefined) {
    provider.notes = requireText(override.notes, `${id} notes`)
  }
  provider.sources = sources
  provider.models = models
  return provider
}

/**
 * 纯函数入口：给命令行与测试共用，不读文件、不联网。
 */
export function buildModelCatalog({ overrides, modelsByProvider, piVersion }) {
  if (!isPlainObject(overrides)) {
    fail('人工核对表必须是对象')
  }
  if (overrides.schemaVersion !== 1) {
    fail(`不支持的人工核对表版本：${overrides.schemaVersion}`)
  }
  if (!Array.isArray(overrides.providers) || overrides.providers.length === 0) {
    fail('人工核对表没有 providers')
  }
  requireText(piVersion, 'piVersion')

  const seenProviders = new Set()
  const providers = overrides.providers.map((override) => {
    const provider = normalizeProvider(override, modelsByProvider)
    if (seenProviders.has(provider.id)) {
      fail(`provider id 重复：${provider.id}`)
    }
    seenProviders.add(provider.id)
    return provider
  })

  return {
    schemaVersion: 1,
    piVersion,
    providers
  }
}

function loadPiModuleVersion() {
  // pi-ai 只导出 ESM，没有 require 条件，所以按 import 条件解析入口再读它的 package.json。
  const entry = fileURLToPath(import.meta.resolve(PI_PACKAGE))
  const packageFile = join(dirname(entry), '..', 'package.json')
  const pkg = JSON.parse(readFileSync(packageFile, 'utf8'))
  return requireText(pkg.version, 'piVersion')
}

async function loadModelsByProvider(overrides) {
  const { getBuiltinModels, getBuiltinProviders } = await import(PI_CATALOG_ENTRY)
  const known = new Set(getBuiltinProviders())
  const modelsByProvider = {}
  for (const provider of overrides.providers) {
    if (!known.has(provider.piProvider)) {
      fail(`pi 内置 provider 中找不到 ${provider.piProvider}`)
    }
    modelsByProvider[provider.piProvider] = getBuiltinModels(provider.piProvider)
  }
  return modelsByProvider
}

export async function generateModelCatalog() {
  const overrides = readOverrides()
  const [piVersion, modelsByProvider] = await Promise.all([
    loadPiModuleVersion(),
    loadModelsByProvider(overrides)
  ])
  const catalog = buildModelCatalog({ overrides, modelsByProvider, piVersion })
  return { catalog, text: `${JSON.stringify(catalog, null, 2)}\n` }
}

function parseArguments(argv) {
  const options = { mode: 'write', output: DEFAULT_OUTPUT }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--stdout') {
      options.mode = 'stdout'
      continue
    }
    if (argument === '--check') {
      options.mode = 'check'
      continue
    }
    if (argument === '--output') {
      const next = argv[index + 1]
      if (!next) {
        fail('--output 后面缺少路径')
      }
      options.output = resolve(process.cwd(), next)
      index += 1
      continue
    }
    fail(`未知参数：${argument}`)
  }
  return options
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const { text } = await generateModelCatalog()

  if (options.mode === 'stdout') {
    process.stdout.write(text)
    return
  }

  if (options.mode === 'check') {
    if (!existsSync(options.output)) {
      fail(`产物不存在：${relative(ROOT, options.output)}；请先运行 npm run generate:catalog`)
    }
    const current = readFileSync(options.output, 'utf8')
    if (current !== text) {
      fail(`产物不是最新：${relative(ROOT, options.output)}；请重新运行 npm run generate:catalog`)
    }
    return
  }

  writeFileSync(options.output, text, 'utf8')
  console.log(`模型目录已生成：${relative(ROOT, options.output)}`)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
