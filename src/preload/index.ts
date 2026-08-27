import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { UIMessage } from 'ai'
import type {
  AgentStreamChunk,
  AgentStreamSendResult,
  AgentToolContext,
  Task,
  ToolOpenCommand
} from '../shared/types'
import { CH, EVENT_CH, type InvokeMap, type PreloadApi } from '../shared/ipc'

// 通过 contextBridge 暴露给渲染进程的自定义 API。
// 所有类型一律来自 src/shared（唯一来源），不再手写重复 interface，避免 drift。

let agentStreamChunkListener: ((_event: IpcRendererEvent, payload: AgentStreamChunk) => void) | null = null
let agentStreamEndListener: ((_event: IpcRendererEvent, payload: AgentStreamSendResult) => void) | null = null
let toolOpenCommandListener: ((_event: IpcRendererEvent, payload: ToolOpenCommand) => void) | null = null

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
    preview: (id, oid) => invoke(CH.toolPreview, id, oid),
    onOpenCommand: (callback: (payload: ToolOpenCommand) => void): (() => void) => {
      if (toolOpenCommandListener) ipcRenderer.removeListener(EVENT_CH.toolOpenCommand, toolOpenCommandListener)
      toolOpenCommandListener = (_event, payload) => callback(payload)
      ipcRenderer.on(EVENT_CH.toolOpenCommand, toolOpenCommandListener)
      return () => {
        if (toolOpenCommandListener) {
          ipcRenderer.removeListener(EVENT_CH.toolOpenCommand, toolOpenCommandListener)
          toolOpenCommandListener = null
        }
      }
    }
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
  agent: {
    abort: () => invoke(CH.agentAbort),
    // —— AI SDK 流式通道（方案 B 阶段 A）——
    // 主进程 consume toUIMessageStream，逐 chunk 经 EVENT_CH.agentStream 推送；
    // 这里收集为事件，渲染层 custom-chat-transport 据此重新组装出 AsyncIterable 喂给 @ai-sdk/vue useChat。
    streamSend: (messages: UIMessage[], context?: AgentToolContext) =>
      invoke(CH.agentStreamSend, messages, context),
    onStreamChunk: (callback: (chunk: AgentStreamChunk) => void): (() => void) => {
      if (agentStreamChunkListener) ipcRenderer.removeListener(EVENT_CH.agentStream, agentStreamChunkListener)
      agentStreamChunkListener = (_event, payload) => callback(payload)
      ipcRenderer.on(EVENT_CH.agentStream, agentStreamChunkListener)
      return () => {
        if (agentStreamChunkListener) {
          ipcRenderer.removeListener(EVENT_CH.agentStream, agentStreamChunkListener)
          agentStreamChunkListener = null
        }
      }
    },
    onStreamEnd: (callback: (result: AgentStreamSendResult) => void): (() => void) => {
      if (agentStreamEndListener) ipcRenderer.removeListener(EVENT_CH.agentStreamEnd, agentStreamEndListener)
      agentStreamEndListener = (_event, payload) => callback(payload)
      ipcRenderer.on(EVENT_CH.agentStreamEnd, agentStreamEndListener)
      return () => {
        if (agentStreamEndListener) {
          ipcRenderer.removeListener(EVENT_CH.agentStreamEnd, agentStreamEndListener)
          agentStreamEndListener = null
        }
      }
    }
  },
  agentTools: {
    list: () => invoke(CH.agentToolsList)
  },
  conversation: {
    list: () => invoke(CH.conversationList),
    create: () => invoke(CH.conversationCreate),
    rename: (id, title) => invoke(CH.conversationRename, id, title),
    messages: (conversationId) => invoke(CH.conversationMessages, conversationId),
    appendMessage: (conversationId, role, content, reasoning, parts) =>
      invoke(CH.conversationAppendMessage, conversationId, role, content, reasoning, parts),
    applyIntents: (input) => invoke(CH.conversationApplyIntents, input),
    intents: (conversationId) => invoke(CH.conversationIntents, conversationId),
    delete: (id) => invoke(CH.conversationDelete, id),
    deleteAll: () => invoke(CH.conversationDeleteAll)
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
