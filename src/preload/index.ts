import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
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

interface ChatMessageData {
  id: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

interface ToolMetaData {
  name: string
  description: string
  inputJsonSchema: Record<string, unknown>
}

type ToolRunResultData = { ok: true; output: Record<string, unknown> } | { ok: false; error: string }

type ChatEventData =
  | { type: 'token'; taskId: number; token: string }
  | { type: 'done'; taskId: number; message: ChatMessageData }
  | { type: 'aborted'; taskId: number; message: ChatMessageData | null }
  | { type: 'error'; taskId: number; error: string }

let chatEventListener: ((_event: IpcRendererEvent, payload: ChatEventData) => void) | null = null

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping'),
  listTasks: (): Promise<TaskData[]> => ipcRenderer.invoke('tasks:list'),
  createTask: (): Promise<TaskData> => ipcRenderer.invoke('tasks:create'),
  renameTask: (taskId: number, title: string): Promise<TaskData | null> =>
    ipcRenderer.invoke('tasks:rename', taskId, title),
  saveTasks: (tasks: TaskData[]): Promise<void> => ipcRenderer.invoke('tasks:save', tasks),
  llama: {
    init: (): Promise<LlamaStatusData> => ipcRenderer.invoke('llama:init'),
    getStatus: (): Promise<LlamaStatusData> => ipcRenderer.invoke('llama:status'),
    checkModel: (): Promise<{ exists: boolean; path: string }> =>
      ipcRenderer.invoke('llama:checkModel')
  },
  tools: {
    list: (): Promise<ToolMetaData[]> => ipcRenderer.invoke('tools:list'),
    run: (name: string, input: Record<string, unknown>): Promise<ToolRunResultData> =>
      ipcRenderer.invoke('tools:run', name, input)
  },
  window: {
    getBounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
      ipcRenderer.invoke('window:getBounds')
  },
  chat: {
    history: (taskId: number): Promise<ChatMessageData[]> =>
      ipcRenderer.invoke('chat:history', taskId),
    send: (taskId: number, text: string): Promise<ChatMessageData | null> =>
      ipcRenderer.invoke('chat:send', taskId, text),
    abort: (): Promise<void> => ipcRenderer.invoke('chat:abort'),
    onEvent: (callback: (payload: ChatEventData) => void): void => {
      if (chatEventListener) ipcRenderer.removeListener('chat:event', chatEventListener)
      chatEventListener = (_event, payload) => callback(payload)
      ipcRenderer.on('chat:event', chatEventListener)
    },
    offEvent: (): void => {
      if (chatEventListener) {
        ipcRenderer.removeListener('chat:event', chatEventListener)
        chatEventListener = null
      }
    }
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
