import type { ChatError, ChatStreamEvent } from '../../../shared/chat'

/**
 * 一条正在生成的回答。回答本身要到生成结束才落库，生成途中的正文、思维链与
 * 计时先放在这里；停止、出错与结束都只把状态改成 finishing，落库由调用方发起。
 */

export type GenerationPhase = 'waiting' | 'thinking' | 'writing'

export type LiveGeneration = {
  threadId: string
  streamId: string
  mode: 'answer' | 'continue'
  /** `answer` 时是回答挂在哪一问下；`continue` 时为 null。 */
  questionId: string | null
  /** `continue` 时是接在哪一版回答后面。 */
  answerId: string | null
  /** 继续生成时这条回答已经写出的部分。 */
  baseText: string
  baseThinking: string
  /** 继续生成之前那条回答的思考时长，用来把计时接上。 */
  baseThinkingMs: number
  text: string
  thinking: string
  thinkingStartedAt: number | null
  thinkingEndedAt: number | null
  phase: GenerationPhase
  error: ChatError | null
  /** 结束的方式；落库时按它决定 done / stopped / error。 */
  terminal: 'done' | 'stopped' | 'error' | null
  /** live 表示还在流；finishing 表示已结束、等落库。 */
  status: 'live' | 'finishing'
  startedAt: number
  /** 生成这一条时使用的模型；落库与重试保存都用这份快照，不跟之后改的默认。 */
  model: string
  /** 发起时这一问已有的回答版本数，用于重试前读回判断是否其实已保存。 */
  baseAnswerVersions: number
  /** 发起继续生成时已有的续写段数，用于同样的读回确认。 */
  baseContinuationCount: number
}

export type ChatSessionState = {
  generation: LiveGeneration | null
}

export const initialChatSession: ChatSessionState = {
  generation: null
}

export type ChatSessionAction =
  | {
      type: 'begin'
      threadId: string
      streamId: string
      mode: 'answer' | 'continue'
      questionId: string | null
      answerId: string | null
      baseText: string
      baseThinking: string
      baseThinkingMs: number
      now: number
      model?: string
      baseAnswerVersions?: number
      baseContinuationCount?: number
    }
  | { type: 'stream'; streamId: string; event: ChatStreamEvent; now: number }
  | { type: 'stop'; now: number }
  | { type: 'clear'; streamId?: string }

export function chatSessionReducer(
  state: ChatSessionState,
  action: ChatSessionAction
): ChatSessionState {
  switch (action.type) {
    case 'begin':
      return {
        ...state,
        generation: {
          threadId: action.threadId,
          streamId: action.streamId,
          mode: action.mode,
          questionId: action.questionId,
          answerId: action.answerId,
          baseText: action.baseText,
          baseThinking: action.baseThinking,
          baseThinkingMs: action.baseThinkingMs,
          text: '',
          thinking: '',
          thinkingStartedAt: null,
          thinkingEndedAt: null,
          phase: 'waiting',
          error: null,
          terminal: null,
          status: 'live',
          startedAt: action.now,
          model: action.model ?? '',
          baseAnswerVersions: action.baseAnswerVersions ?? 0,
          baseContinuationCount: action.baseContinuationCount ?? 0
        }
      }

    case 'stream':
      return applyStreamEvent(state, action.streamId, action.event, action.now)

    case 'stop': {
      const generation = state.generation
      if (!generation || generation.status !== 'live') {
        return state
      }
      return {
        ...state,
        generation: {
          ...generation,
          status: 'finishing',
          terminal: 'stopped',
          thinkingEndedAt: finishTime(generation, action.now)
        }
      }
    }

    case 'clear':
      // 落库是异步的；清掉的必须还是同一条，否则会把之后新起的那条一起抹掉。
      if (state.generation === null) {
        return state
      }
      if (action.streamId !== undefined && state.generation.streamId !== action.streamId) {
        return state
      }
      return { ...state, generation: null }

  }
}

function applyStreamEvent(
  state: ChatSessionState,
  streamId: string,
  event: ChatStreamEvent,
  now: number
): ChatSessionState {
  const generation = state.generation
  if (!generation || generation.streamId !== streamId || generation.status !== 'live') {
    return state
  }

  switch (event.type) {
    case 'thinking': {
      if (event.text === '' || generation.phase === 'writing') {
        return state
      }
      return {
        ...state,
        generation: {
          ...generation,
          phase: 'thinking',
          thinking: generation.thinking + event.text,
          thinkingStartedAt: generation.thinkingStartedAt ?? now
        }
      }
    }

    case 'text': {
      if (event.text === '') {
        return state
      }
      return {
        ...state,
        generation: {
          ...generation,
          phase: 'writing',
          text: generation.text + event.text,
          thinkingEndedAt: finishTime(generation, now)
        }
      }
    }

    case 'done': {
      return {
        ...state,
        generation: {
          ...generation,
          status: 'finishing',
          terminal: 'done',
          thinkingEndedAt: finishTime(generation, now)
        }
      }
    }

    case 'error': {
      return {
        ...state,
        generation: {
          ...generation,
          error: event.error,
          status: 'finishing',
          terminal: 'error',
          thinkingEndedAt: finishTime(generation, now)
        }
      }
    }
  }
}

function finishTime(generation: LiveGeneration, now: number): number | null {
  return generation.thinkingStartedAt !== null && generation.thinkingEndedAt === null
    ? now
    : generation.thinkingEndedAt
}

export function isGenerating(state: ChatSessionState): boolean {
  return state.generation !== null && state.generation.status === 'live'
}

/** 这一条显示出来的正文：继续生成时接在底稿后面。 */
export function liveAnswerText(generation: LiveGeneration): string {
  return generation.baseText + generation.text
}

/** 思维链按段拼起来，继续生成的思考接在后面。 */
export function liveAnswerThinking(generation: LiveGeneration): string {
  return [generation.baseThinking, generation.thinking]
    .filter((text) => text.trim() !== '')
    .join('\n\n')
}

/** 这一条总共花了多少秒思考：继续生成时把底稿的时长接上。 */
export function liveThinkingSeconds(generation: LiveGeneration, now: number): number {
  const end = generation.thinkingEndedAt ?? now
  const elapsed =
    generation.thinkingStartedAt === null
      ? 0
      : Math.max(0, end - generation.thinkingStartedAt)
  return Math.floor((generation.baseThinkingMs + elapsed) / 1000)
}

export function thinkingExpandedFor(
  thinkingOpen: boolean | null,
  options: { hasThinking: boolean; active: boolean }
): boolean {
  if (!options.hasThinking) {
    return false
  }
  if (thinkingOpen !== null) {
    return thinkingOpen
  }
  return options.active
}

/**
 * 流式思考时默认展开；正文一到自动折起。学习者手动点过之后，
 * 这个选择在本线程内一直有效。
 */
export function thinkingExpanded(
  thinkingOpen: boolean | null,
  generation: LiveGeneration
): boolean {
  return thinkingExpandedFor(thinkingOpen, {
    hasThinking: generation.thinkingStartedAt !== null || generation.baseThinking !== '',
    active: generation.phase === 'thinking'
  })
}
