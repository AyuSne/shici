import { describe, expect, it } from 'vitest'
import { MODEL_PROTOCOLS } from '../../shared/model-catalog'
import { PROTOCOL_FACTORIES, loadProtocolApi } from './protocols'

describe('协议注册表', () => {
  it('四个协议 ID 都有一条懒加载的 pi API 工厂', () => {
    expect(Object.keys(PROTOCOL_FACTORIES).sort()).toEqual([...MODEL_PROTOCOLS].sort())
    for (const protocol of MODEL_PROTOCOLS) {
      expect(typeof PROTOCOL_FACTORIES[protocol]).toBe('function')
    }
  })

  it('按协议 ID 加载出 pi 的流实现；切换协议不用改请求代码', async () => {
    for (const protocol of MODEL_PROTOCOLS) {
      const api = await loadProtocolApi(protocol)
      expect(typeof api.stream).toBe('function')
      expect(typeof api.streamSimple).toBe('function')
    }
  })

  it('未知协议明确失败，不悄悄回退到 OpenAI 兼容', async () => {
    await expect(loadProtocolApi('openai-codex-responses' as never)).rejects.toThrow(
      '不支持的协议'
    )
  })
})
