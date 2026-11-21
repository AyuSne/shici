import type { ChatError } from '../../../shared/chat'

export type ChatErrorPresentation = {
  title: string
  detail: string
  /** 非重试类错误的下一步；可重试类由重试按钮承担动作。 */
  action?: string
  retryable: boolean
}

/**
 * 错误文案与动作按类型分开。只有网络、限流、服务端繁忙给出重试；
 * 密钥、余额、上下文这类问题重试也没用，改成一句具体的下一步。
 */
export function describeChatError(error: ChatError): ChatErrorPresentation {
  switch (error.code) {
    case 'invalid-key':
      return {
        title: withStatus('密钥无效', error),
        detail: '这次生成没有开始。',
        action: '到设置 → 模型服务里换一个有效的 API 密钥。',
        retryable: false
      }
    case 'insufficient-balance':
      return {
        title: withStatus('余额不足', error),
        detail: '这套密钥没有可用余额。',
        action: '换一个有余额的密钥后再来。',
        retryable: false
      }
    case 'context-too-long':
      return {
        title: withStatus('上下文过长', error),
        detail: '这次带上的内容太多。',
        action: '删减上下文后再发。',
        retryable: false
      }
    case 'rate-limited':
      return {
        title: withStatus('请求太频繁', error),
        detail: '稍等几秒再试。已输出的内容会留在本条里。',
        retryable: true
      }
    case 'server-busy':
      return {
        title: withStatus('服务繁忙', error),
        detail: '模型服务暂时不可用。已输出的内容会留在本条里。',
        retryable: true
      }
    case 'network':
      return {
        title: '网络异常',
        detail: '没连上模型服务，或连接在生成中断了。',
        retryable: true
      }
    case 'empty-response':
      return {
        title: '模型没有返回内容',
        detail: '服务这次返回了空回答。已输出的内容会留在本条里。',
        retryable: true
      }
    case 'not-configured':
      if (error.credential?.kind === 'env-missing') {
        return {
          title: '环境变量没有设置',
          detail: `这套提供商要读环境变量 ${error.credential.envVar}，但这次运行时它没有值；生成没有开始。`,
          action: `在系统环境里补上 ${error.credential.envVar}，或到设置 → 模型服务里改用本机保存的密钥。`,
          retryable: false
        }
      }
      if (error.credential?.kind === 'env-var-unset') {
        return {
          title: '环境变量名没有填',
          detail: '这套提供商使用环境变量，但变量名是空的；生成没有开始。',
          action: '到设置 → 模型服务 → 编辑凭据里填上环境变量名。',
          retryable: false
        }
      }
      if (error.credential?.kind === 'stored-decrypt-failed') {
        return {
          title: '本机密钥解不开',
          detail:
            '本机保存的密钥解不开（可能换过电脑或系统账户）；生成没有开始，也不会改用环境变量。',
          action: '到设置 → 模型服务 → 编辑凭据里重新填一个密钥。',
          retryable: false
        }
      }
      if (error.credential?.kind === 'stored-missing') {
        return {
          title: '这套提供商还没有密钥',
          detail: '本机没有保存这套提供商的密钥；生成没有开始。',
          action: '到设置 → 模型服务 → 编辑凭据里填一个密钥。',
          retryable: false
        }
      }
      return {
        title: '还没有配置模型服务',
        detail: '这次生成没有开始。',
        action: '到设置 → 模型服务里查看提供商配置；也可以先用 DEEPSEEK_API_KEY 环境变量。',
        retryable: false
      }
    case 'unknown':
      return {
        title: '生成失败',
        detail: '模型服务返回了预料之外的错误。已输出的内容会留在本条里。',
        action: '稍后再试。',
        retryable: false
      }
  }
}

function withStatus(title: string, error: ChatError): string {
  return error.status === undefined ? title : `${title}（${error.status}）`
}

/**
 * 换密钥 / 余额 / 没配置这三类要去设置页动手；界面在错误块里给一个「去设置」，
 * 不让「下一步」只停在文案。上下文过长要去删上下文，不在设置里。
 */
export function suggestsSettings(error: ChatError): boolean {
  return (
    error.code === 'invalid-key' ||
    error.code === 'insufficient-balance' ||
    error.code === 'not-configured'
  )
}
