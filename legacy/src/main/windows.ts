// 主窗口创建与当前窗口引用：createWindow 响应 app ready 与 macOS activate 触发，
// currentWindow 供 window:getBounds 等 IPC 读取窗口状态。
import { shell, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'

const DEFAULT_WIDTH = 1100
const DEFAULT_HEIGHT = 750

// dev 模式窗口藏左下角：窗口右上角位于工作区左下角右上方 (DEV_CORNER_X, DEV_CORNER_Y) 处，
// 主体藏在屏幕左/下之外，避免 -w 重启/启动时弹到屏幕中央打断操作
const DEV_CORNER_X = 100
const DEV_CORNER_Y = 100

let currentWindow: BrowserWindow | undefined

export function getCurrentWindow(): BrowserWindow | undefined {
  return currentWindow
}

/** dev 窗口初始位置：窗口右上角位于工作区左下角右上方 (DEV_CORNER_X, DEV_CORNER_Y) 处 */
function devCornerBounds(): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea
  return {
    x: wa.x + DEV_CORNER_X - DEFAULT_WIDTH,
    y: wa.y + wa.height - DEV_CORNER_Y
  }
}

export function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: 800,
    minHeight: 600,
    // 无标题栏：macOS 用 hiddenInset（隐藏标题栏、保留红绿灯），
    // Windows/Linux 用 titleBarOverlay（隐藏标题栏、保留系统窗口按钮）
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform !== 'darwin'
      ? {
          titleBarOverlay: {
            color: '#ffffff',
            symbolColor: '#52525b',
            height: 32
          }
        }
      : {}),
    // dev 藏角落：不在构造参数里传屏外坐标（macOS 会拉回屏内），改为显示后 setBounds
    show: false,
    autoHideMenuBar: true,
    title: '哆灵',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: false,
      // 允许渲染层用 <webview> 承载工具详情页：独立 webContents，可挂 preload 注入 window.cap + 心跳
      webviewTag: true
    }
  })
  currentWindow = mainWindow

  mainWindow.once('ready-to-show', () => {
    if (is.dev) {
      // 透明 + showInactive（不抢焦点）→ setBounds 移到屏外角落 → 恢复不透明，
      // 既避免 macOS 把屏外窗口拉回屏内，也避免启动闪现打断操作
      const bounds = devCornerBounds()
      mainWindow.setOpacity(0)
      mainWindow.showInactive()
      mainWindow.setBounds({ ...bounds, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT })
      setImmediate(() => mainWindow.setOpacity(1))
    } else {
      mainWindow.show()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}
