/**
 * 读一个环境变量值的唯一入口。
 *
 * 变量名可由用户在设置里编辑，所以不能直接 `env[name]?.trim()`：
 * - `constructor`、`__proto__`、`toString` 会读到对象原型上的继承属性（函数/对象），
 *   对它们调用 `.trim()` 会抛 TypeError，而不是报「环境变量缺失」；
 * - 继承来的值、非字符串值都不算用户配置了环境变量。
 *
 * 只认自有属性且值是字符串；空串与纯空白都按「没有设置」处理。
 * 返回值已经 trim，调用方不要再 trim 一次。
 */
export function readEnvValue(env: NodeJS.ProcessEnv | undefined, name: string): string | null {
  const key = name.trim()
  if (env === undefined || key === '') {
    return null
  }
  if (!Object.prototype.hasOwnProperty.call(env, key)) {
    return null
  }
  const value = env[key]
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}
