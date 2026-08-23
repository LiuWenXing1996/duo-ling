import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 通过 contextBridge 暴露给渲染进程的自定义 API
interface TaskData {
  id: number
  title: string
  createdAt: string
}

interface ModelProfileData {
  id: string
  name: string
  providerId: string
  baseUrl: string
  model: string
  enabled: boolean
  useFullUrl: boolean
  apiFormat: 'openai'
  hasApiKey: boolean
  contextOutputToken?: number
  temperature?: number
  topP?: number
  topK?: number
}

interface ModelProfileInputData {
  id?: string
  name: string
  providerId?: string
  baseUrl: string
  apiKey: string
  model: string
  enabled?: boolean
  useFullUrl?: boolean
  contextOutputToken?: number
  temperature?: number
  topP?: number
  topK?: number
}

interface ModelProviderData {
  id: string
  name: string
  baseUrl: string
  keyUrl: string
  models: string[]
  supported: boolean
}

interface ChatMessageData {
  id: number
  role: 'user' | 'assistant'
  content: string
  createdAt: string
}

type ChatEventData =
  | { type: 'token'; taskId: number; token: string }
  | { type: 'done'; taskId: number; message: ChatMessageData }
  | { type: 'aborted'; taskId: number; message: ChatMessageData | null }
  | { type: 'error'; taskId: number; error: string }

type GeneratorEventData =
  | { type: 'token'; token: string }
  | { type: 'done'; content: string }
  | { type: 'aborted'; content: string }
  | { type: 'error'; error: string }

interface CapabilitySchemaFieldData {
  type: string
  description: string
}

interface CapabilitySchemaData {
  type: string
  description: string
  fields?: Record<string, CapabilitySchemaFieldData>
}

interface CapabilityData {
  id: string
  name: string
  description: string
  inputSchema: CapabilitySchemaData
  outputSchema: CapabilitySchemaData
  sideEffect: 'read' | 'write' | 'notify' | 'destructive'
  runtime: 'frontend' | 'backend'
  cost: 'offline' | 'online'
  scenario: { keywords: string[]; object: string }
}

type CapabilityRunResponse = { ok: true; result: unknown } | { ok: false; error: string }

let chatEventListener: ((_event: IpcRendererEvent, payload: ChatEventData) => void) | null = null
let generatorEventListener: ((_event: IpcRendererEvent, payload: GeneratorEventData) => void) | null = null

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping'),
  listTasks: (): Promise<TaskData[]> => ipcRenderer.invoke('tasks:list'),
  createTask: (): Promise<TaskData> => ipcRenderer.invoke('tasks:create'),
  renameTask: (taskId: number, title: string): Promise<TaskData | null> =>
    ipcRenderer.invoke('tasks:rename', taskId, title),
  saveTasks: (tasks: TaskData[]): Promise<void> => ipcRenderer.invoke('tasks:save', tasks),
  model: {
    list: (): Promise<{ profiles: ModelProfileData[]; activeId: string }> =>
      ipcRenderer.invoke('model:list'),
    save: (profile: ModelProfileInputData): Promise<ModelProfileData> =>
      ipcRenderer.invoke('model:save', profile),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('model:delete', id),
    setActive: (id: string): Promise<void> => ipcRenderer.invoke('model:setActive', id),
    toggle: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('model:toggle', id, enabled),
    test: (config: { baseUrl: string; apiKey: string }): Promise<{ ok: boolean; models?: string[]; error?: string }> =>
      ipcRenderer.invoke('model:test', config),
    testChat: (config: {
      baseUrl: string
      apiKey: string
      model: string
      useFullUrl?: boolean
      profileId?: string
    }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('model:testChat', config)
  },
  provider: {
    list: (): Promise<ModelProviderData[]> => ipcRenderer.invoke('provider:list')
  },
  settings: {
    getSystemPrompt: (): Promise<string> => ipcRenderer.invoke('settings:getSystemPrompt'),
    setSystemPrompt: (value: string): Promise<void> =>
      ipcRenderer.invoke('settings:setSystemPrompt', value)
  },
  window: {
    getBounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
      ipcRenderer.invoke('window:getBounds')
  },
  capability: {
    list: (): Promise<CapabilityData[]> => ipcRenderer.invoke('capability:list'),
    run: (id: string, args: unknown): Promise<CapabilityRunResponse> =>
      ipcRenderer.invoke('capability:run', id, args)
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
  },
  generator: {
    send: (
      history: Array<{ role: 'user' | 'assistant'; content: string }>
    ): Promise<{ ok: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke('generator:send', history),
    abort: (): Promise<void> => ipcRenderer.invoke('generator:abort'),
    onEvent: (callback: (payload: GeneratorEventData) => void): void => {
      if (generatorEventListener) ipcRenderer.removeListener('generator:event', generatorEventListener)
      generatorEventListener = (_event, payload) => callback(payload)
      ipcRenderer.on('generator:event', generatorEventListener)
    },
    offEvent: (): void => {
      if (generatorEventListener) {
        ipcRenderer.removeListener('generator:event', generatorEventListener)
        generatorEventListener = null
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
