import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ChatEventData,
  GeneratorEventData,
  GeneratorMessage,
  Task
} from '../shared/types'
import { CH, EVENT_CH, type InvokeMap, type PreloadApi } from '../shared/ipc'

// 通过 contextBridge 暴露给渲染进程的自定义 API。
// 所有类型一律来自 src/shared（唯一来源），不再手写重复 interface，避免 drift。

let chatEventListener: ((_event: IpcRendererEvent, payload: ChatEventData) => void) | null = null
let generatorEventListener: ((_event: IpcRendererEvent, payload: GeneratorEventData) => void) | null = null

/** 类型化 invoke：通道与 args/result 由 InvokeMap 约束，主进程改签名时此处编译期报错 */
function invoke<K extends keyof InvokeMap>(
  channel: K,
  ...args: InvokeMap[K]['args']
): Promise<InvokeMap[K]['result']> {
  return ipcRenderer.invoke(channel, ...args) as Promise<InvokeMap[K]['result']>
}

const api: PreloadApi = {
  listTasks: () => invoke(CH.tasksList),
  createTask: () => invoke(CH.tasksCreate),
  renameTask: (taskId, title) => invoke(CH.tasksRename, taskId, title),
  saveTasks: (tasks: Task[]) => invoke(CH.tasksSave, tasks),
  model: {
    list: () => invoke(CH.modelList),
    save: (profile) => invoke(CH.modelSave, profile),
    delete: (id) => invoke(CH.modelDelete, id),
    setActive: (id) => invoke(CH.modelSetActive, id),
    toggle: (id, enabled) => invoke(CH.modelToggle, id, enabled),
    testChat: (config) => invoke(CH.modelTestChat, config)
  },
  provider: {
    list: () => invoke(CH.providerList)
  },
  settings: {
    getSystemPrompt: () => invoke(CH.settingsGetSystemPrompt),
    setSystemPrompt: (value) => invoke(CH.settingsSetSystemPrompt, value)
  },
  window: {
    getBounds: () => invoke(CH.windowGetBounds)
  },
  capability: {
    list: () => invoke(CH.capabilityList),
    run: (id, args) => invoke(CH.capabilityRun, id, args)
  },
  tool: {
    create: () => invoke(CH.toolCreate),
    list: () => invoke(CH.toolList),
    delete: (id, keepData) => invoke(CH.toolDelete, id, keepData),
    updateMeta: (id, patch) => invoke(CH.toolUpdateMeta, id, patch),
    update: (id, changes) => invoke(CH.toolUpdate, id, changes),
    getPreloadPath: () => invoke(CH.toolGetPreloadPath),
    history: (id) => invoke(CH.toolHistory, id),
    rollback: (id, oid) => invoke(CH.toolRollback, id, oid),
    preview: (id, oid) => invoke(CH.toolPreview, id, oid)
  },
  toolsPreview: {
    list: () => invoke(CH.toolsPreviewList),
    clear: () => invoke(CH.toolsPreviewClear)
  },
  toolsData: {
    list: () => invoke(CH.toolsDataList),
    detail: (id) => invoke(CH.toolsDataDetail, id),
    clear: (id) => invoke(CH.toolsDataClear, id),
    deleteOrphan: () => invoke(CH.toolsDataDeleteOrphan),
    open: (id) => invoke(CH.toolsDataOpen, id)
  },
  chat: {
    history: (taskId) => invoke(CH.chatHistory, taskId),
    send: (taskId, text) => invoke(CH.chatSend, taskId, text),
    abort: () => invoke(CH.chatAbort),
    onEvent: (callback: (payload: ChatEventData) => void): void => {
      if (chatEventListener) ipcRenderer.removeListener(EVENT_CH.chat, chatEventListener)
      chatEventListener = (_event, payload) => callback(payload)
      ipcRenderer.on(EVENT_CH.chat, chatEventListener)
    },
    offEvent: (): void => {
      if (chatEventListener) {
        ipcRenderer.removeListener(EVENT_CH.chat, chatEventListener)
        chatEventListener = null
      }
    }
  },
  generator: {
    send: (history: GeneratorMessage[]) => invoke(CH.generatorSend, history),
    abort: () => invoke(CH.generatorAbort),
    onEvent: (callback: (payload: GeneratorEventData) => void): void => {
      if (generatorEventListener) ipcRenderer.removeListener(EVENT_CH.generator, generatorEventListener)
      generatorEventListener = (_event, payload) => callback(payload)
      ipcRenderer.on(EVENT_CH.generator, generatorEventListener)
    },
    offEvent: (): void => {
      if (generatorEventListener) {
        ipcRenderer.removeListener(EVENT_CH.generator, generatorEventListener)
        generatorEventListener = null
      }
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}
