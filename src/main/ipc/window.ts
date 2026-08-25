// 窗口信息 IPC：读取当前窗口位置/尺寸（用于开发调试与窗口状态管理）。
import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import type { WindowBounds } from '../../shared/types'
import { getCurrentWindow } from '../windows'

export function registerWindowIpc(): void {
  ipcMain.handle(CH.windowGetBounds, (): WindowBounds | null => {
    const bounds = getCurrentWindow()?.getBounds()
    return bounds
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : null
  })
}
