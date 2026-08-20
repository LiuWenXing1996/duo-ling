import { app, shell, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'node:path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { listTasks, createTask, renameTask, saveTasks, type Task } from './store'
import { checkModelExists, getModelStatus, initModel, isModelReady, generateChatReply } from './llama-service'
import { listChatMessages, appendChatMessage, type ChatMessage } from './chat-store'

// 端测等场景可通过环境变量指定 userData 目录，避免写入系统默认位置
if (process.env['DUO_LING_USER_DATA_DIR']) {
  app.setPath('userData', process.env['DUO_LING_USER_DATA_DIR'])
}

// 开发环境开启 CDP 远程调试端口（渲染进程），
// 可通过 chrome://inspect 或 Playwright connectOverCDP 远程调试界面
if (is.dev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

let currentWindow: BrowserWindow | undefined

// 当前模型生成的中止控制器（模块级，供退出前中止使用）
let chatAbortController: AbortController | undefined
let quitConfirmed = false

/** 是否正在生成回复 */
function isGenerating(): boolean {
  return chatAbortController != null
}

/** 中止当前生成 */
function abortCurrentGeneration(): void {
  chatAbortController?.abort()
}

const DEFAULT_WIDTH = 1100
const DEFAULT_HEIGHT = 750

// dev 模式窗口藏左下角：窗口右上角位于工作区左下角右上方 (DEV_CORNER_X, DEV_CORNER_Y) 处，
// 主体藏在屏幕左/下之外，避免 -w 重启/启动时弹到屏幕中央打断操作
const DEV_CORNER_X = 100
const DEV_CORNER_Y = 100

/** dev 窗口初始位置：窗口右上角位于工作区左下角右上方 (DEV_CORNER_X, DEV_CORNER_Y) 处 */
function devCornerBounds(): { x: number; y: number } {
  const wa = screen.getPrimaryDisplay().workArea
  return {
    x: wa.x + DEV_CORNER_X - DEFAULT_WIDTH,
    y: wa.y + wa.height - DEV_CORNER_Y
  }
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: 800,
    minHeight: 600,
    // dev 藏角落：不在构造参数里传屏外坐标（macOS 会拉回屏内），改为显示后 setBounds
    show: false,
    autoHideMenuBar: true,
    title: 'Duo Ling',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
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

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.duo-ling.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // 示例 IPC：渲染进程通过 window.api.ping() 调用
  ipcMain.handle('app:ping', () => 'pong')

  // 任务列表持久化：electron-store 读写 <userData>/tasks.json
  ipcMain.handle('tasks:list', () => listTasks())
  ipcMain.handle('tasks:create', () => createTask())
  ipcMain.handle('tasks:rename', (_event, taskId: number, title: string) => renameTask(taskId, title))
  ipcMain.handle('tasks:save', (_event, tasks: Task[]) => saveTasks(tasks))

  // 本地大模型：node-llama-cpp 加载 MiniCPM5-1B-Q8_0.gguf
  ipcMain.handle('llama:init', () => initModel())
  ipcMain.handle('llama:status', () => getModelStatus())
  ipcMain.handle('llama:checkModel', () => checkModelExists())

  // 窗口信息：读取当前窗口位置/尺寸（用于开发调试与窗口状态管理）
  ipcMain.handle('window:getBounds', () => {
    const bounds = currentWindow?.getBounds()
    return bounds
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : null
  })

  // 对话：按任务（会话）读写历史，流式生成回复

  ipcMain.handle('chat:history', (_event, taskId: number) => listChatMessages(taskId))

  ipcMain.handle('chat:send', async (event, taskId: number, text: string) => {
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error('消息不能为空')
    }
    if (!isModelReady()) {
      throw new Error('模型尚未加载，请先点击「加载模型」')
    }
    if (chatAbortController) {
      throw new Error('当前有正在生成的回复，请先停止')
    }

    const userMessage: ChatMessage = {
      id: Date.now(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString()
    }
    appendChatMessage(taskId, userMessage)

    // 历史为当前用户消息之前的部分
    const history = listChatMessages(taskId).slice(0, -1)

    // 首条消息自动命名：标题仍是自动生成的「新会话*」时，用首条消息前缀替换
    if (history.length === 0) {
      const current = listTasks().find((task) => task.id === taskId)
      if (current && current.title.startsWith('新会话')) {
        renameTask(taskId, text.trim().slice(0, 15))
      }
    }

    const abort = new AbortController()
    chatAbortController = abort
    let full = ''

    try {
      const reply = await generateChatReply(history, text, (token) => {
        full += token
        event.sender.send('chat:event', { type: 'token', taskId, token })
      }, abort.signal)
      const assistantMessage: ChatMessage = {
        id: Date.now(),
        role: 'assistant',
        content: reply,
        createdAt: new Date().toISOString()
      }
      appendChatMessage(taskId, assistantMessage)
      event.sender.send('chat:event', { type: 'done', taskId, message: assistantMessage })
      return assistantMessage
    } catch (error) {
      if (abort.signal.aborted) {
        // 中止时保留已生成的部分回复
        const content = full.trim()
        const message = content
          ? ({
              id: Date.now(),
              role: 'assistant',
              content,
              createdAt: new Date().toISOString()
            } satisfies ChatMessage)
          : null
        if (message) appendChatMessage(taskId, message)
        event.sender.send('chat:event', { type: 'aborted', taskId, message })
        return message
      }
      const message = error instanceof Error ? error.message : String(error)
      event.sender.send('chat:event', { type: 'error', taskId, error: message })
      throw error
    } finally {
      if (chatAbortController === abort) chatAbortController = undefined
    }
  })

  ipcMain.handle('chat:abort', () => {
    chatAbortController?.abort()
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 退出前中止进行中的生成：避免 NAPI 工作线程在 Node 环境清理时抛异常导致崩溃
app.on('before-quit', (event) => {
  if (quitConfirmed || !isGenerating()) return
  event.preventDefault()
  abortCurrentGeneration()
  const deadline = Date.now() + 2000
  const timer = setInterval(() => {
    if (!isGenerating() || Date.now() >= deadline) {
      clearInterval(timer)
      quitConfirmed = true
      app.quit()
    }
  }, 100)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
