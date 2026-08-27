import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { UIMessage } from 'ai'
import type {
  AgentStreamChunk,
  AgentStreamSendResult,
  ToolOpenCommand
} from '../shared/types'
import { CH, EVENT_CH, type InvokeMap, type PreloadApi } from '../shared/ipc'

// 通过 contextBridge 暴露给渲染进程的自定义 API。
// 所有类型一律来自 src/shared（唯一来源），不再手写重复 interface，避免 drift。

/** 主进程 → 渲染层事件订阅辅助：同一通道只保留一个监听器（重复订阅先移除旧的），返回取消订阅函数 */
function makeChannelListener<P>(channel: string): {
  on: (callback: (payload: P) => void) => () => void
} {
  let listener: ((_event: IpcRendererEvent, payload: P) => void) | null = null
  return {
    on(callback) {
      if (listener) ipcRenderer.removeListener(channel, listener)
      listener = (_event, payload) => callback(payload)
      ipcRenderer.on(channel, listener)
      return () => {
        if (listener) {
          ipcRenderer.removeListener(channel, listener)
          listener = null
        }
      }
    }
  }
}

const toolOpenCommandEvents = makeChannelListener<ToolOpenCommand>(EVENT_CH.toolOpenCommand)
const agentStreamChunkEvents = makeChannelListener<AgentStreamChunk>(EVENT_CH.agentStream)
const agentStreamEndEvents = makeChannelListener<AgentStreamSendResult>(EVENT_CH.agentStreamEnd)

/** 类型化 invoke：通道与 args/result 由 InvokeMap 约束，主进程改签名时此处编译期报错 */
function invoke<K extends keyof InvokeMap>(
  channel: K,
  ...args: InvokeMap[K]['args']
): Promise<InvokeMap[K]['result']> {
  return ipcRenderer.invoke(channel, ...args) as Promise<InvokeMap[K]['result']>
}

const api: PreloadApi = {
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
  workspace: {
    tabsChanged: (state) => invoke(CH.workspaceTabsChanged, state)
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
    codeTree: (id) => invoke(CH.toolCodeTree, id),
    rollback: (id, oid) => invoke(CH.toolRollback, id, oid),
    preview: (id, oid) => invoke(CH.toolPreview, id, oid),
    archive: {
      read: (id) => invoke(CH.toolArchiveRead, id)
    },
    group: {
      list: () => invoke(CH.toolGroupList),
      set: (toolId, group) => invoke(CH.toolGroupSet, toolId, group)
    },
    onOpenCommand: (callback) => toolOpenCommandEvents.on(callback)
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
    // —— AI SDK 流式通道 ——
    // 主进程 consume toUIMessageStream，逐 chunk 经 EVENT_CH.agentStream 推送；
    // 这里收集为事件，渲染层 custom-chat-transport 据此重新组装出 ReadableStream 喂给 @ai-sdk/vue useChat。
    streamSend: (messages: UIMessage[]) =>
      invoke(CH.agentStreamSend, messages),
    onStreamChunk: (callback) => agentStreamChunkEvents.on(callback),
    onStreamEnd: (callback) => agentStreamEndEvents.on(callback)
  },
  agentTools: {
    list: () => invoke(CH.agentToolsList)
  },
  conversation: {
    list: () => invoke(CH.conversationList),
    search: (query) => invoke(CH.conversationSearch, query),
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
  // @ts-expect-error (define in dts)
  window.api = api
}
