import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

// 渲染层不加载任何远程内容：脚本、样式、图片都取自应用包内。开发态由 Vite 注入
// 内联的 React Refresh 预置脚本与 HMR WebSocket，因此单独放宽这两项。
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'app-content-security-policy',
    transformIndexHtml(_html, context) {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content: context.server ? DEV_CSP : PROD_CSP
          },
          injectTo: 'head-prepend'
        }
      ]
    }
  }
}

/**
 * 语料是数据文件，不进主进程的 JS 产物：构建时把 docs/corpus 的 JSON 复制到
 * out/main/corpus，主进程按 `__dirname/corpus` 读。打包只带 out/，所以放在这里。
 */
function corpusAssets(): Plugin {
  return {
    name: 'app-corpus-assets',
    // 用 writeBundle 而不是 closeBundle：开发态 watch 每次重建都要重新放一份。
    writeBundle() {
      const source = resolve(process.cwd(), 'docs/corpus')
      const target = resolve(process.cwd(), 'out/main/corpus')
      mkdirSync(target, { recursive: true })
      for (const file of readdirSync(source)) {
        if (!file.endsWith('.json')) continue
        cpSync(join(source, file), join(target, file))
      }
    }
  }
}

/**
 * 内置词典同样是数据文件：构建时把 assets/dictionary 的库与版权声明复制到
 * out/main/dictionary，打包只带 out/，所以放在这里。
 */
function dictionaryAssets(): Plugin {
  return {
    name: 'app-dictionary-assets',
    writeBundle() {
      const source = resolve(process.cwd(), 'assets/dictionary')
      const target = resolve(process.cwd(), 'out/main/dictionary')
      mkdirSync(target, { recursive: true })
      for (const file of readdirSync(source)) {
        cpSync(join(source, file), join(target, file))
      }
    }
  }
}

/**
 * 应用图标复制到 out/main/icon.ico，供开发态 BrowserWindow 指定窗口与任务栏图标；
 * 打包后由 @electron/packager / electron-builder 直接把 build/icon.ico 嵌进可执行文件。
 */
function iconAssets(): Plugin {
  return {
    name: 'app-icon-assets',
    writeBundle() {
      const source = resolve(process.cwd(), 'build/icon.ico')
      const target = resolve(process.cwd(), 'out/main')
      mkdirSync(target, { recursive: true })
      cpSync(source, join(target, 'icon.ico'))
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), corpusAssets(), dictionaryAssets(), iconAssets()],
    build: {
      rollupOptions: {
        output: {
          // pi-ai 只导出 ESM；主进程产物是 CJS，靠 import() 在运行时加载。
          // 这个选项让 Rollup 原样保留 import()，不要改写成 require()。
          dynamicImportInCjs: true
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), contentSecurityPolicy()]
  }
})
