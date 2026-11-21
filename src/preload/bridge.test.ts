import { describe, expect, it } from 'vitest'
import type { ChatStreamUpdate } from '../shared/chat'
import type { AppBootstrap } from '../shared/types'
import { createBridge, type IpcRendererLike } from './bridge'

const bootstrap: AppBootstrap = {
  appVersion: '0.1.0',
  isPackaged: false,
  schemaVersion: 3,
  theme: 'light',
  chatModel: 'deepseek-flash',
  corpusImport: { total: 0, imported: 0, updated: 0, skipped: 0, failed: [] }
}

function fakeRenderer(): {
  ipc: IpcRendererLike
  listeners: Map<string, (event: unknown, payload: unknown) => void>
  invocations: Array<{ channel: string; payload: unknown }>
} {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  const invocations: Array<{ channel: string; payload: unknown }> = []
  return {
    listeners,
    invocations,
    ipc: {
      async invoke(channel, payload) {
        invocations.push({ channel, payload })
        return bootstrap
      },
      on(channel, listener) {
        listeners.set(channel, listener)
      },
      removeListener(channel, listener) {
        if (listeners.get(channel) === listener) {
          listeners.delete(channel)
        }
      }
    }
  }
}

describe('createBridge', () => {
  it('把已知 channel 的请求转给主进程并返回结果', async () => {
    const { ipc, invocations } = fakeRenderer()

    const bridge = createBridge(ipc)

    await expect(bridge.invoke('app:bootstrap')).resolves.toEqual(bootstrap)
    expect(invocations).toEqual([{ channel: 'app:bootstrap', payload: undefined }])
  })

  it('按主对象查询及打开线程的请求可以经过白名单', async () => {
    const { ipc, invocations } = fakeRenderer()
    const bridge = createBridge(ipc)
    const main = { kind: 'entry', entryId: 'entry-1' } as const
    await bridge.invoke('chat:find-for-main', { main })
    await bridge.invoke('chat:open-for-main', { main, forceNew: true })
    expect(JSON.parse(JSON.stringify(invocations))).toEqual([
      { channel: 'chat:find-for-main', payload: { main } },
      { channel: 'chat:open-for-main', payload: { main, forceNew: true } }
    ])
  })

  it('用一组词开线程的请求穿过白名单', async () => {
    const { ipc, invocations } = fakeRenderer()
    const bridge = createBridge(ipc)

    await bridge.invoke('chat:create-group', { entryIds: ['entry-1', 'entry-2'] })

    expect(JSON.parse(JSON.stringify(invocations))).toEqual([
      { channel: 'chat:create-group', payload: { entryIds: ['entry-1', 'entry-2'] } }
    ])
  })

  it('删除线程的请求和结果穿过 preload 白名单', async () => {    const { ipc } = fakeRenderer()
    const calls: unknown[] = []
    const bridge = createBridge({
      ...ipc,
      async invoke(channel, payload) {
        calls.push({ channel, payload })
        return { status: 'deleted' }
      }
    })
    await expect(bridge.invoke('chat:delete', { threadId: 'thread-1' })).resolves.toEqual({ status: 'deleted' })
    expect(calls).toEqual([{ channel: 'chat:delete', payload: { threadId: 'thread-1' } }])
  })

  it('稍后看标记走同一份白名单', async () => {
    const { ipc } = fakeRenderer()
    const calls: unknown[] = []
    const bridge = createBridge({
      ...ipc,
      async invoke(channel, payload) {
        calls.push({ channel, payload })
        return { status: 'marked', markedAt: '2026-11-18T08:10:00.000Z' }
      }
    })

    await expect(
      bridge.invoke('entries:later', { entryId: 'entry-1', later: true })
    ).resolves.toEqual({ status: 'marked', markedAt: '2026-11-18T08:10:00.000Z' })
    expect(calls).toEqual([
      { channel: 'entries:later', payload: { entryId: 'entry-1', later: true } }
    ])
  })

  it('学习指令的列表、保存、修改、复制与删除都走同一份白名单', async () => {
    const { ipc, invocations } = fakeRenderer()
    const bridge = createBridge(ipc)

    await bridge.invoke('instructions:list')
    await bridge.invoke('instructions:create', { name: '我的问法', body: '请解释这个词。' })
    await bridge.invoke('instructions:update', {
      instructionId: 'instruction-1',
      name: '新名字',
      body: '新正文'
    })
    await bridge.invoke('instructions:copy', { instructionId: 'instruction-1' })
    await bridge.invoke('instructions:delete', { instructionId: 'instruction-1' })

    expect(JSON.parse(JSON.stringify(invocations))).toEqual([
      { channel: 'instructions:list', payload: undefined },
      {
        channel: 'instructions:create',
        payload: { name: '我的问法', body: '请解释这个词。' }
      },
      {
        channel: 'instructions:update',
        payload: { instructionId: 'instruction-1', name: '新名字', body: '新正文' }
      },
      {
        channel: 'instructions:copy',
        payload: { instructionId: 'instruction-1' }
      },
      {
        channel: 'instructions:delete',
        payload: { instructionId: 'instruction-1' }
      }
    ])
  })

  it('文章重命名与删除的请求和结果穿过 preload 白名单', async () => {
    const { ipc, invocations } = fakeRenderer()
    const bridge = createBridge(ipc)
    const confirmed = {
      articleId: 'article-1',
      sentenceAssociationCount: 0,
      affectedEntryCount: 0,
      disappearingEntryCount: 0,
      survivingEntryCount: 0,
      disappearingLearningNoteCount: 0,
      articlePinCount: 0
    }

    await bridge.invoke('library:rename', { articleId: 'article-1', title: '我的文章' })
    await bridge.invoke('library:delete-preview', { articleId: 'article-1' })
    await bridge.invoke('library:delete', { articleId: 'article-1', confirmed })
    await bridge.invoke('reading:complete', { articleId: 'article-1' })

    expect(JSON.parse(JSON.stringify(invocations))).toEqual([
      { channel: 'library:rename', payload: { articleId: 'article-1', title: '我的文章' } },
      { channel: 'library:delete-preview', payload: { articleId: 'article-1' } },
      { channel: 'library:delete', payload: { articleId: 'article-1', confirmed } },
      { channel: 'reading:complete', payload: { articleId: 'article-1' } }
    ])
  })

  it('提供商新增、默认模型、激活、删除与凭据编辑都走同一份白名单', async () => {
    const { ipc, invocations } = fakeRenderer()
    const bridge = createBridge(ipc)

    await bridge.invoke('settings:provider-add', {
      catalogProviderId: 'deepseek',
      apiKey: 'sk-write-only'
    })
    await bridge.invoke('settings:provider-default-model', {
      providerId: 'provider-1',
      modelRowId: 'model-1'
    })
    await bridge.invoke('settings:provider-activate', { providerId: 'provider-1' })
    await bridge.invoke('settings:provider-delete', { providerId: 'provider-1' })
    await bridge.invoke('settings:provider-credential', {
      providerId: 'provider-1',
      authMode: 'env',
      envVar: 'MY_PROVIDER_KEY',
      apiKey: '',
      confirmClearStored: true
    })

    expect(JSON.parse(JSON.stringify(invocations))).toEqual([
      {
        channel: 'settings:provider-add',
        payload: { catalogProviderId: 'deepseek', apiKey: 'sk-write-only' }
      },
      {
        channel: 'settings:provider-default-model',
        payload: { providerId: 'provider-1', modelRowId: 'model-1' }
      },
      { channel: 'settings:provider-activate', payload: { providerId: 'provider-1' } },
      { channel: 'settings:provider-delete', payload: { providerId: 'provider-1' } },
      {
        channel: 'settings:provider-credential',
        payload: {
          providerId: 'provider-1',
          authMode: 'env',
          envVar: 'MY_PROVIDER_KEY',
          apiKey: '',
          confirmClearStored: true
        }
      }
    ])
  })

  it('自定义 provider 与模型目录的写入都走同一份白名单', async () => {
    const { ipc, invocations } = fakeRenderer()
    const bridge = createBridge(ipc)

    await bridge.invoke('settings:provider-create', {
      providerKey: 'my-relay',
      displayName: '我的中转',
      protocol: 'openai-completions',
      baseUrl: 'https://relay.example.com/v1',
      apiKey: 'sk-write-only',
      model: { modelId: 'relay-model', source: 'fetched' },
      additionalModels: [{ modelId: 'deepseek-v4-pro', source: 'fetched' }]
    })
    await bridge.invoke('settings:provider-models-fetch', {
      source: 'custom',
      catalogProviderId: null,
      providerId: null,
      protocol: 'openai-completions',
      baseUrl: 'https://relay.example.com/v1',
      authMode: 'stored',
      apiKey: 'sk-write-only',
      knownModelIds: ['relay-model']
    })
    await bridge.invoke('settings:provider-update', {
      providerId: 'provider-1',
      displayName: '新名字',
      baseUrl: 'https://relay.example.com/v2'
    })
    await bridge.invoke('settings:provider-model-add', {
      providerId: 'provider-1',
      model: { modelId: 'new-model' }
    })
    await bridge.invoke('settings:provider-model-update', {
      providerId: 'provider-1',
      modelRowId: 'model-1',
      model: { modelId: 'renamed-model' }
    })
    await bridge.invoke('settings:provider-model-delete', {
      providerId: 'provider-1',
      modelRowId: 'model-2'
    })
    await bridge.invoke('settings:provider-model-reorder', {
      providerId: 'provider-1',
      modelRowIds: ['model-2', 'model-1']
    })

    expect(JSON.parse(JSON.stringify(invocations))).toEqual([
      {
        channel: 'settings:provider-create',
        payload: {
          providerKey: 'my-relay',
          displayName: '我的中转',
          protocol: 'openai-completions',
          baseUrl: 'https://relay.example.com/v1',
          apiKey: 'sk-write-only',
          model: { modelId: 'relay-model', source: 'fetched' },
          additionalModels: [{ modelId: 'deepseek-v4-pro', source: 'fetched' }]
        }
      },
      {
        channel: 'settings:provider-models-fetch',
        payload: {
          source: 'custom',
          catalogProviderId: null,
          providerId: null,
          protocol: 'openai-completions',
          baseUrl: 'https://relay.example.com/v1',
          authMode: 'stored',
          apiKey: 'sk-write-only',
          knownModelIds: ['relay-model']
        }
      },
      {
        channel: 'settings:provider-update',
        payload: {
          providerId: 'provider-1',
          displayName: '新名字',
          baseUrl: 'https://relay.example.com/v2'
        }
      },
      {
        channel: 'settings:provider-model-add',
        payload: { providerId: 'provider-1', model: { modelId: 'new-model' } }
      },
      {
        channel: 'settings:provider-model-update',
        payload: {
          providerId: 'provider-1',
          modelRowId: 'model-1',
          model: { modelId: 'renamed-model' }
        }
      },
      {
        channel: 'settings:provider-model-delete',
        payload: { providerId: 'provider-1', modelRowId: 'model-2' }
      },
      {
        channel: 'settings:provider-model-reorder',
        payload: { providerId: 'provider-1', modelRowIds: ['model-2', 'model-1'] }
      }
    ])
  })

  it('未知 channel 立即报错，且不发给主进程', async () => {
    const { ipc, invocations } = fakeRenderer()
    const bridge = createBridge(ipc)

    await expect(bridge.invoke('app:unknown' as never)).rejects.toThrow('Unknown IPC channel')
    await expect(bridge.invoke(42 as never)).rejects.toThrow('Unknown IPC channel')
    expect(invocations).toHaveLength(0)
  })

  it('把事件载荷交给订阅者，取消订阅后不再监听', () => {
    const { ipc, listeners } = fakeRenderer()
    const bridge = createBridge(ipc)
    const received: ChatStreamUpdate[] = []

    const unsubscribe = bridge.subscribe('chat:event', (update) => received.push(update))
    const update: ChatStreamUpdate = {
      streamId: 'stream-1',
      event: { type: 'text', text: '正文' }
    }
    listeners.get('chat:event')?.({}, update)

    unsubscribe()

    expect(listeners.has('chat:event')).toBe(false)
    expect(received).toEqual([update])
  })

  it('未知事件 channel 立即报错，且不注册监听', () => {
    const { ipc, listeners } = fakeRenderer()
    const bridge = createBridge(ipc)

    expect(() => bridge.subscribe('chat:unknown' as never, () => undefined)).toThrow(
      'Unknown IPC event channel'
    )
    expect(listeners.size).toBe(0)
  })
})
