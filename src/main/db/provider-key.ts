const PROVIDER_KEY_MAX_LENGTH = 48

/** 小写、数字与连字符；保留给 Provider ID 的词干。 */
export function slugOf(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function hostSlugOf(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return slugOf(url.hostname.replace(/^www\./, '').replace(/\./g, '-'))
  } catch {
    return ''
  }
}

/**
 * 在已用的 Provider ID 里取一个合法且唯一的值：`base`、`base-2`、`base-3`…
 * 不合法（不是小写字母开头、超过长度）时先修词干，再补序号。
 */
export function uniqueProviderKey(
  base: string,
  used: ReadonlySet<string>
): string {
  let stem = base.slice(0, PROVIDER_KEY_MAX_LENGTH).replace(/-+$/g, '')
  if (!/^[a-z]/.test(stem)) {
    stem = 'provider'
  }
  let key = stem
  for (let suffix = 2; used.has(key); suffix += 1) {
    key = `${stem}-${suffix}`
  }
  return key
}

/**
 * 迁移旧配置时的 Provider ID：先从名字派生；名字全是中文等无法成词时退到地址；
 * 仍不合法就用 `provider`。同一份库里唯一。
 */
export function deriveProviderKey(
  name: string,
  baseUrl: string,
  used: ReadonlySet<string>
): string {
  let base = slugOf(name)
  if (!/^[a-z]/.test(base)) {
    base = hostSlugOf(baseUrl)
  }
  if (!/^[a-z]/.test(base)) {
    base = 'provider'
  }
  return uniqueProviderKey(base, used)
}
