import { describe, expect, it } from 'vitest'
import type { FetchedModelCandidate } from '../../../shared/model-discovery'
import {
  combineCustomProviderModels,
  discoveryFailureText,
  discoverySourceHint,
  providerModelDraftOf,
  selectedCandidates,
  toggleSelectedModelId
} from './model-discovery'

/**
 * 「获取可用模型」的纯界面规则：勾选只进草稿、保存时合并成一次请求、
 * 失败文案不包含上游正文或密钥。
 */

const alpha: FetchedModelCandidate = {
  modelId: 'alpha',
  displayName: 'Alpha',
  contextWindow: 128_000,
  maxTokens: 8_192,
  reasoning: true,
  origin: 'remote'
}

const beta: FetchedModelCandidate = {
  modelId: 'beta',
  displayName: 'beta',
  contextWindow: null,
  maxTokens: null,
  reasoning: false,
  origin: 'remote'
}

/** 上游列表没给思考能力：不能伪造 false 把本地目录的 true 覆盖掉。 */
const gamma: FetchedModelCandidate = {
  modelId: 'gamma',
  displayName: 'Gamma',
  contextWindow: 64_000,
  maxTokens: 4_096,
  reasoning: null,
  origin: 'remote'
}

describe('候选勾选与草稿合并', () => {
  it('勾选是幂等的开关：再点一次取消，不会重复', () => {
    expect(toggleSelectedModelId([], 'alpha')).toEqual(['alpha'])
    expect(toggleSelectedModelId(['alpha'], 'alpha')).toEqual([])
    expect(toggleSelectedModelId(['alpha'], 'beta')).toEqual(['alpha', 'beta'])
  })

  it('按候选顺序取已勾选项，未知 id 忽略', () => {
    expect(selectedCandidates([alpha, beta], ['beta', 'missing'])).toEqual([beta])
  })

  it('只选了候选、没填手填模型时，用候选组成保存草稿；null 容量留给目录/兜底', () => {
    expect(combineCustomProviderModels('', [alpha, beta])).toEqual([
      {
        modelId: 'alpha',
        displayName: 'Alpha',
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: true,
        source: 'fetched'
      },
      {
        modelId: 'beta',
        displayName: 'beta',
        contextWindow: undefined,
        maxTokens: undefined,
        reasoning: false,
        source: 'fetched'
      }
    ])
  })

  it('手填 ID 优先作第一条；若它也被勾选，只保留一次且按 fetched 记来源', () => {
    expect(combineCustomProviderModels('alpha', [alpha, beta])).toEqual([
      {
        modelId: 'alpha',
        displayName: 'Alpha',
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: true,
        source: 'fetched'
      },
      {
        modelId: 'beta',
        displayName: 'beta',
        contextWindow: undefined,
        maxTokens: undefined,
        reasoning: false,
        source: 'fetched'
      }
    ])

    expect(combineCustomProviderModels('manual-one', [alpha])).toEqual([
      { modelId: 'manual-one', source: 'manual' },
      {
        modelId: 'alpha',
        displayName: 'Alpha',
        contextWindow: 128_000,
        maxTokens: 8_192,
        reasoning: true,
        source: 'fetched'
      }
    ])
  })

  it('什么都没填/没勾选时草稿为空，由保存校验拦住', () => {
    expect(combineCustomProviderModels('   ', [])).toEqual([])
  })

  it('上游没给思考能力时草稿不带 reasoning，由目录/发送层兜底', () => {
    const draft = providerModelDraftOf(gamma)
    expect(draft).toEqual({
      modelId: 'gamma',
      displayName: 'Gamma',
      contextWindow: 64_000,
      maxTokens: 4_096,
      source: 'fetched'
    })
    expect(draft).not.toHaveProperty('reasoning')
    // 上游明确给了 false 就保留，不擅自改成 true。
    expect(providerModelDraftOf(beta).reasoning).toBe(false)
  })
})

describe('失败与来源文案', () => {
  it('内置目录明确说不联网；自定义说用当前表单值', () => {
    expect(discoverySourceHint('builtin')).toContain('本地目录')
    expect(discoverySourceHint('custom')).toContain('当前填写的地址')
    expect(discoverySourceHint('custom')).toContain('密钥')
  })

  it('缺环境变量时点名变量；本机解不开说明不会改用环境变量', () => {
    expect(
      discoveryFailureText({
        status: 'rejected',
        reason: 'missing-credential',
        problem: 'env-missing',
        envVar: 'MY_KEY'
      })
    ).toContain('MY_KEY')

    const unreadable = discoveryFailureText({
      status: 'rejected',
      reason: 'credential-error',
      problem: 'stored-decrypt-failed'
    })
    expect(unreadable).toContain('解不开')
    expect(unreadable).toContain('不会改用环境变量')
  })

  it('HTTP / 超时 / 过大 / 格式错误都有明确原因，且不包含上游正文', () => {
    expect(
      discoveryFailureText({ status: 'rejected', reason: 'http-error', httpStatus: 401 })
    ).toContain('HTTP 401')
    expect(discoveryFailureText({ status: 'rejected', reason: 'timeout' })).toContain('超时')
    expect(discoveryFailureText({ status: 'rejected', reason: 'too-large' })).toContain('4 MiB')
    expect(
      discoveryFailureText({ status: 'rejected', reason: 'invalid-format' })
    ).toContain('模型列表')
    const transport = discoveryFailureText({ status: 'rejected', reason: 'transport' })
    expect(transport).toContain('连不上')
    expect(transport).not.toContain('sk-')
  })
})
