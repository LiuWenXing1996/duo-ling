// 任务列表持久化 IPC：electron-store 读写 <userData>/tasks.json。
import { ipcMain } from 'electron'
import type { Task } from '../../shared/types'
import { listTasks, createTask, renameTask, saveTasks } from '../store'

export function registerTasksIpc(): void {
  ipcMain.handle('tasks:list', () => listTasks())
  ipcMain.handle('tasks:create', () => createTask())
  ipcMain.handle('tasks:rename', (_event, taskId: number, title: string) => renameTask(taskId, title))
  ipcMain.handle('tasks:save', (_event, tasks: Task[]) => saveTasks(tasks))
}
