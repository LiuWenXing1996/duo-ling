// 主进程入口：负责启动时序与跨领域串联，业务 handler 已按领域拆分到 ./ipc/* 与 ./protocol、./windows。
import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerToolSchemes, registerToolProtocols } from './protocol'
import { createWindow } from './windows'
import { registerTasksIpc } from './ipc/tasks'
import { registerModelIpc } from './ipc/model'
import { registerAgentIpc } from './ipc/agent'
import { registerCapabilityIpc } from './ipc/capability'
import { registerToolIpc } from './ipc/tool'
import { registerWindowIpc } from './ipc/window'
import { registerConversationIpc } from './ipc/conversation'
import { abortCurrentGeneration, getQuitConfirmed, isGenerating, setQuitConfirmed } from './ipc/state'

// 端测等场景可通过环境变量指定 userData 目录，避免写入系统默认位置
if (process.env['DUO_LING_USER_DATA_DIR']) {
  app.setPath('userData', process.env['DUO_LING_USER_DATA_DIR'])
}

// 开发环境开启 CDP 远程调试端口（渲染进程），
// 可通过 chrome://inspect 或 Playwright connectOverCDP 远程调试界面
if (is.dev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// 自定义协议 scheme 必须在 app ready 前注册（见 ./protocol）
registerToolSchemes()

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.duo-ling.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // `tool://` 与 `tool-preview://` 请求处理器
  registerToolProtocols()

  // 各领域 IPC handler
  registerTasksIpc()
  registerModelIpc()
  registerAgentIpc()
  registerCapabilityIpc()
  registerToolIpc()
  registerWindowIpc()
  registerConversationIpc()

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// 退出前中止进行中的生成：避免 NAPI 工作线程在 Node 环境清理时抛异常导致崩溃
app.on('before-quit', (event) => {
  if (getQuitConfirmed() || !isGenerating()) return
  event.preventDefault()
  abortCurrentGeneration()
  const deadline = Date.now() + 2000
  const timer = setInterval(() => {
    if (!isGenerating() || Date.now() >= deadline) {
      clearInterval(timer)
      setQuitConfirmed(true)
      app.quit()
    }
  }, 100)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
