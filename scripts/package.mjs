import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { listPackage } from '@electron/asar'
import { packager } from '@electron/packager'

const root = resolve(import.meta.dirname, '..')
const outputDirectory = join(root, 'release')

const electronVersion = JSON.parse(
  readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8')
).version

// packager 交给 ignore 的是相对仓库根、带前导斜杠、分隔符统一成 / 的路径，
// 所以这里一律按这个形状写；`out` 是打包输入，不能忽略。
// release-installer 是旧的生成安装目录，promo 是与运行无关的用户文件：
// 两者都只从打包输入里排除，不删除、不移动源目录。
// node_modules 经 junction 指向共享依赖，里面的 .vitest-cache / .vite 是
// 测试与构建缓存，不是运行依赖，不能跟着进 app.asar。
const ignore = [
  /^\/(?:src|e2e|docs|tools|scripts|assets|out\/main\/dictionary|\.agents|\.git|\.vscode|\.tmp-[^/]*|test-results|playwright-report|release-installer|release|promo|真题PDF)(?:\/|$)/,
  /^\/node_modules\/(?:\.vitest-cache|\.vite)(?:\/|$)/,
  /^\/(?:\.env[^/]*|\.gitignore|\.tmp-[^/]*|[^/]+\.md|[^/]+\.pdf|package-lock\.json|skills-lock\.json|playwright\.config\.ts|vitest\.config\.ts|electron\.vite\.config\.ts|tsconfig[^/]*\.json)$/
]

// 词典是 SQLite 文件，native 驱动读不了 asar 内的路径，放进 resources/dictionary。
const extraResource = [join(root, 'assets', 'dictionary')]

const packagedPaths = await packager({
  dir: root,
  out: outputDirectory,
  name: 'english-learning',
  productName: '素读',
  executableName: '素读',
  electronVersion,
  overwrite: true,
  asar: { unpack: '**/*.node' },
  extraResource,
  ignore
})

const [appPath] = packagedPaths
if (!appPath) {
  throw new Error('打包没有产出应用目录')
}

// 黑盒成品检查：生成器 / 用户无关目录绝不能被卷进 app.asar。只看成品，
// 不依赖 ignore 规则本身，sentinel 与真实旧安装目录都能被这一步抓住。
const archivePath = join(appPath, 'resources', 'app.asar')
const entries = listPackage(archivePath).map((entry) => entry.replaceAll('\\', '/'))
const forbidden = entries.filter(
  (entry) =>
    entry === '/release-installer' ||
    entry.startsWith('/release-installer/') ||
    entry === '/promo' ||
    entry.startsWith('/promo/') ||
    entry === '/node_modules/.vitest-cache' ||
    entry.startsWith('/node_modules/.vitest-cache/') ||
    entry === '/node_modules/.vite' ||
    entry.startsWith('/node_modules/.vite/')
)
if (forbidden.length > 0) {
  throw new Error(
    `打包输入混入了非运行目录（${forbidden.length} 项），例如：${forbidden.slice(0, 5).join('、')}`
  )
}
if (!entries.includes('/out/main/index.js')) {
  throw new Error('打包产物缺少 out/main/index.js')
}

const executablePath =
  process.platform === 'win32'
    ? join(appPath, '素读.exe')
    : process.platform === 'darwin'
      ? join(appPath, '素读.app', 'Contents', 'MacOS', '素读')
      : join(appPath, '素读')

const manifestPath = join(outputDirectory, 'packaged-app.json')
await writeFile(manifestPath, `${JSON.stringify({ appPath, executablePath }, null, 2)}\n`, 'utf8')

console.log(`打包完成：${appPath}`)
console.log(`可执行文件：${executablePath}`)
