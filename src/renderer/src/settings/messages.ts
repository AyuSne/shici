import type { CredentialRejectionReason } from '../../../shared/provider-credentials'

/**
 * 设置页共享文案。
 *
 * OpenCode GO 只读与凭据拒绝原因散在多个组件里时，新增入口或新增拒绝原因
 * 很容易漏改一层；这里各留一份，组件只引用不重抄。
 */

/** 模型服务页顶部说明；内置名单由页面传入，组件只引用不重抄。 */
export function modelSectionDescription(builtinNames: string): string {
  return `${builtinNames} 等内置服务填上密钥就能用；想接别处，也可以自定义。保存之后再测试连接。`
}

/** 只读目录的统一前缀：主进程拒绝与界面提示用同一句。 */
export const OPENCODE_GO_READ_ONLY = 'OpenCode GO 的模型目录不可编辑'

/** 目录编辑器 / 获取候选面板的说明；动作范围不同，后缀不同。 */
export function readOnlyDirectoryHint(scene: 'edit' | 'discovery'): string {
  return scene === 'edit'
    ? `${OPENCODE_GO_READ_ONLY}：可以搜索并选择默认模型。`
    : `${OPENCODE_GO_READ_ONLY}：可以查看可用模型。`
}

/** 主进程拒绝写只读目录时的原因文案。 */
export const READ_ONLY_DIRECTORY_REJECTION = `${OPENCODE_GO_READ_ONLY}，只能选默认模型。`

/**
 * 凭据编辑的拒绝原因 → 可操作文案。
 * 新增 `CredentialRejectionReason` 时这里会编译报错，避免落到含糊的兜底句。
 */
export function credentialRejectionText(reason: CredentialRejectionReason): string {
  switch (reason) {
    case 'confirm-required':
      return '从本机切到环境变量会清除已存密钥，需要再确认一次。'
    case 'missing-key':
      return '本机模式要填一个 API 密钥；或改用环境变量。'
    case 'invalid-env-var':
      return '环境变量名要字母或下划线开头，只含字母、数字与下划线。'
    default:
      return assertNever(reason)
  }
}

function assertNever(value: never): never {
  throw new Error(`未知的凭据拒绝原因：${String(value)}`)
}
