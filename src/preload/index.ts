import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 通过 contextBridge 暴露给渲染进程的自定义 API
interface TaskData {
  id: number
  title: string
  createdAt: string
}

interface LlamaStatusData {
  state: 'idle' | 'loading' | 'ready' | 'error'
  modelPath: string | null
  modelExists: boolean
  gpu?: string
  error?: string
}

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping'),
  listTasks: (): Promise<TaskData[]> => ipcRenderer.invoke('tasks:list'),
  saveTasks: (tasks: TaskData[]): Promise<void> => ipcRenderer.invoke('tasks:save', tasks),
  llama: {
    init: (): Promise<LlamaStatusData> => ipcRenderer.invoke('llama:init'),
    getStatus: (): Promise<LlamaStatusData> => ipcRenderer.invoke('llama:status'),
    checkModel: (): Promise<{ exists: boolean; path: string }> =>
      ipcRenderer.invoke('llama:checkModel')
  },
  window: {
    getBounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
      ipcRenderer.invoke('window:getBounds')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
