import { app, BrowserWindow, nativeTheme } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  titleBarOverlayFor,
  THEME_PAPER,
  type TitleBarOverlay
} from '../shared/theme'
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
 * 主题偏好落到原生侧：themeSource、窗口底色与覆盖标题栏配色，返回解析后的实际配色。
 * 跟随系统时 Windows 改了深浅，调用方用 nativeTheme 的 updated 事件再调一次。
 */
export function applyThemePreference(preference: ThemePreference): Theme {
  nativeTheme.themeSource = preference
  const theme = resolveTheme(preference, nativeTheme.shouldUseDarkColors)
  for (const window of BrowserWindow.getAllWindows()) {
    window.setBackgroundColor(THEME_PAPER[theme])
    applyTitleBarOverlay(window, titleBarOverlayFor(theme))
  }
  return theme
}

/**
 * 右上角窗口控制区与暖纸 / 深墨 token 保持一致。覆盖标题栏只在 Windows / Linux
 * 生效；macOS 由系统交通灯接管，不调用这个接口，免得平台差异把启动弄挂。
 */
function applyTitleBarOverlay(window: BrowserWindow, overlay: TitleBarOverlay): void {
  if (process.platform === 'darwin') {
    return
  }
  window.setTitleBarOverlay(overlay)
}

export function createMainWindow(themePreference: ThemePreference): BrowserWindow {
  // 先让 Electron 按偏好解析系统配色，窗口底色与界面首帧才一致。
  const theme = applyThemePreference(themePreference)

  const icon = resolveWindowIcon()
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    // 900 是界面最后一个断点；融合标题栏后窗口不再有系统边框，
    // 最小宽度按内容给 884，等价于旧版 900 外框里的可用正文宽度。
    minWidth: 884,
    minHeight: 640,
    show: false,
    title: '拾词',
    // 融合式原生标题栏：渲染层画 34px 顶栏并留出右上角控制区，颜色随主题实时更新。
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? {}
      : { titleBarOverlay: titleBarOverlayFor(theme) }),
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
