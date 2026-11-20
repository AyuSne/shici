import type { SettingsOverview } from '../../../shared/settings'
import {
  checkText,
  keyStateText,
  protocolText,
  providerModelsText,
  verificationText
} from './format'

/**
 * 模型服务：#61 只把迁移后的 provider 显示成只读卡片。
 * 名称、协议、模型、验证状态与使用中一眼看全；编辑、删除、切换留给后续版本。
 */
export function ModelSection({ overview }: { overview: SettingsOverview }) {
  return (
    <section className="settings-section" aria-labelledby="settings-model-title">
      <h2 id="settings-model-title">模型服务</h2>
      <p className="settings-desc">
        这里是迁移后的提供商列表，只读：名称、协议、模型、验证状态与使用中都会保留。
        切换使用中的提供商只影响之后的调用。
      </p>

      {overview.providers.length === 0 ? (
        <p className="settings-empty">
          还没有模型提供商。升级会把旧的模型配置自动迁到这里；也可以先用环境变量。
        </p>
      ) : (
        <ul className="profile-list">
          {overview.providers.map((provider) => (
            <li
              key={provider.id}
              className={provider.active ? 'profile-card is-active' : 'profile-card'}
            >
              <div className="profile-head">
                <b className="profile-name">{provider.displayName}</b>
                {provider.active ? <span className="profile-chip is-current">使用中</span> : null}
                <span
                  className={
                    provider.verification === 'verified'
                      ? 'profile-chip is-verified'
                      : 'profile-chip'
                  }
                >
                  {verificationText(provider)}
                </span>
              </div>

              <dl className="profile-facts">
                <div>
                  <dt>Provider ID</dt>
                  <dd>
                    <code>{provider.providerKey}</code>
                  </dd>
                </div>
                <div>
                  <dt>协议</dt>
                  <dd>{protocolText(provider.protocol)}</dd>
                </div>
                <div>
                  <dt>接口地址</dt>
                  <dd>
                    <code>{provider.baseUrl ?? '未填写'}</code>
                  </dd>
                </div>
                <div>
                  <dt>模型</dt>
                  <dd>
                    <code>{providerModelsText(provider)}</code>
                  </dd>
                </div>
                <div>
                  <dt>默认模型</dt>
                  <dd>
                    <code>{provider.defaultModel ?? '还没有'}</code>
                  </dd>
                </div>
                <div>
                  <dt>密钥</dt>
                  <dd>
                    <code>{keyStateText(provider)}</code>
                  </dd>
                </div>
              </dl>
              <p className="profile-check">{checkText(provider)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
