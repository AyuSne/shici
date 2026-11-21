import { app, BrowserWindow, nativeTheme } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { THEME_PAPER } from '../shared/theme'
import { resolveTheme, type Theme, type ThemePreference } from '../shared/types'

/**
 * 开发态窗口宿主仍是通用 electron.exe，需显式指到随产物复制的 icon.ico；
 * 打包产物已把 build/icon.ico 嵌进拾词.exe 资源段，无需再从 asar 读文件路径。
 */
function resolveWindowIcon(): string | undefined {
  if (app.isPackaged) {
    return undefined
  }
  const devIcon = join(__dirname, 'icon.ico')
  return existsSync(devIcon) ? devIcon : undefined
}

/**
 * 主题偏好落到原生侧：themeSource、窗口底色，返回解析后的实际配色。
 * 跟随系统时 Windows 改了深浅，调用方用 nativeTheme 的 updated 事件再调一次。
 */
export function applyThemePreference(preference: ThemePreference): Theme {
  nativeTheme.themeSource = preference
  const theme = resolveTheme(preference, nativeTheme.shouldUseDarkColors)
  for (const window of BrowserWindow.getAllWindows()) {
    window.setBackgroundColor(THEME_PAPER[theme])
  }
  return theme
}

export function createMainWindow(themePreference: ThemePreference): BrowserWindow {
  // 先让 Electron 按偏好解析系统配色，窗口底色与界面首帧才一致。
  const theme = applyThemePreference(themePreference)

  const icon = resolveWindowIcon()
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    // 900 是界面最后一个断点：再小就不再收栏，而是开始压正文列。
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: '拾词',
    ...(icon === undefined ? {} : { icon }),
    backgroundColor: THEME_PAPER[theme],
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  window.once('ready-to-show', () => window.show())

  // 应用内不打开窗口、不离开本地页面：所有跳转都由渲染层的视图切换完成。
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    try {
      if (new URL(url).origin !== new URL(window.webContents.getURL()).origin) {
        event.preventDefault()
      }
    } catch {
      event.preventDefault()
    }
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
