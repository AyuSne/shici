import type { ProviderTestResult } from '../../../shared/provider-test'
import { testProviderConnection } from '../api'
import { showToast } from '../components/toast-store'
import { providerTestFailureText, providerTestVerifiedText } from './format'

/**
 * 保存提供商后的统一回执：一条 Toast + 「立即测试连接」。
 * 内置卡片与自定义表单共用同一份文案与失败回执；各自只在 onTested 里刷新自己的
 * 卡片状态（内置卡片需要重新读设置、把失败留在对应卡片上，自定义表单不需要）。
 */
export type ProviderTestOutcome = Exclude<ProviderTestResult, { status: 'missing' }>

export function showProviderSavedToast(input: {
  message: string
  providerId: string
  displayName: string
  onTested?: (result: ProviderTestOutcome) => void | Promise<void>
}): void {
  showToast({
    message: input.message,
    action: {
      label: '立即测试连接',
      run: async () => {
        const tested = await testProviderConnection({ providerId: input.providerId })
        // 保存后立刻删除时，迟到结果不写回任何状态。
        if (tested.status === 'missing') return
        await input.onTested?.(tested)
        if (tested.status === 'verified') {
          showToast({
            message: `「${input.displayName}」${providerTestVerifiedText(tested)}`
          })
          return
        }
        showToast({
          message: `「${input.displayName}」${providerTestFailureText(tested)}`,
          tone: 'error'
        })
      },
      failureMessage: '测试连接没有完成，再试一次。'
    }
  })
}
