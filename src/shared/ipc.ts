// IPC 契约收敛：通道常量 + InvokeMap（通道 → { args, result }）+ PreloadApi。
// 目的：
//  1. 消除 preload 中裸字符串通道名的重复（此前散落各处）。
//  2. InvokeMap 让 preload 侧 `invoke` 与主进程 `handle` 双向对齐：改签名时编译期报错。
//  3. PreloadApi 是 window.api 的权威形状，index.d.ts 由此派生，渲染层自动获得完整类型。
// 本文件只含类型与字符串常量，不依赖 electron，因此可被 main / preload / renderer 三方共同引用。

import type {
  Capability,
  CapabilityRunResponse,
  ChatEventData,
  ChatMessage,
  GeneratorEventData,
  GeneratorMessage,
  GeneratorSendResult,
  ModelProfile,
  ModelProfileInput,
  ModelProvider,
  ModelTestChatConfig,
  Task,
  TestChatResult,
  ToolChangeList,
  ToolCreateResult,
  ToolHistoryResult,
  ToolPageMeta,
  ToolPreviewResult,
  ToolResult,
  ToolUpdateMetaResult,
  ToolUpdateResult,
  ToolsPreviewClearResult,
  ToolsPreviewListResult,
  WindowBounds
} from './types'

/** invoke 类通道名常量 */
export const CH = {
  tasksList: 'tasks:list',
  tasksCreate: 'tasks:create',
  tasksRename: 'tasks:rename',
  tasksSave: 'tasks:save',
  modelList: 'model:list',
  modelSave: 'model:save',
  modelDelete: 'model:delete',
  modelSetActive: 'model:setActive',
  modelToggle: 'model:toggle',
  modelTestChat: 'model:testChat',
  providerList: 'provider:list',
  settingsGetSystemPrompt: 'settings:getSystemPrompt',
  settingsSetSystemPrompt: 'settings:setSystemPrompt',
  windowGetBounds: 'window:getBounds',
  capabilityList: 'capability:list',
  capabilityRun: 'capability:run',
  toolCreate: 'tool:create',
  toolList: 'tool:list',
  toolDelete: 'tool:delete',
  toolUpdateMeta: 'tool:updateMeta',
  toolUpdate: 'tool:update',
  toolGetPreloadPath: 'tool:getPreloadPath',
  toolHistory: 'tool:history',
  toolRollback: 'tool:rollback',
  toolPreview: 'tool:preview',
  toolsPreviewList: 'tools-preview:list',
  toolsPreviewClear: 'tools-preview:clear',
  chatHistory: 'chat:history',
  chatSend: 'chat:send',
  chatAbort: 'chat:abort',
  generatorSend: 'generator:send',
  generatorAbort: 'generator:abort'
} as const

/** 事件类通道名常量（主进程主动推送 → 渲染层） */
export const EVENT_CH = {
  chat: 'chat:event',
  generator: 'generator:event'
} as const

/** invoke 通道 → { args, result } 映射：preload invoke 与主进程 handle 的编译期契约 */
export interface InvokeMap {
  [CH.tasksList]: { args: []; result: Task[] }
  [CH.tasksCreate]: { args: []; result: Task }
  [CH.tasksRename]: { args: [taskId: number, title: string]; result: Task | null }
  [CH.tasksSave]: { args: [tasks: Task[]]; result: void }
  [CH.modelList]: { args: []; result: { profiles: ModelProfile[]; activeId: string } }
  [CH.modelSave]: { args: [profile: ModelProfileInput]; result: ModelProfile }
  [CH.modelDelete]: { args: [id: string]; result: void }
  [CH.modelSetActive]: { args: [id: string]; result: void }
  [CH.modelToggle]: { args: [id: string, enabled: boolean]; result: void }
  [CH.modelTestChat]: { args: [config: ModelTestChatConfig]; result: TestChatResult }
  [CH.providerList]: { args: []; result: ModelProvider[] }
  [CH.settingsGetSystemPrompt]: { args: []; result: string }
  [CH.settingsSetSystemPrompt]: { args: [value: string]; result: void }
  [CH.windowGetBounds]: { args: []; result: WindowBounds | null }
  [CH.capabilityList]: { args: []; result: Capability[] }
  [CH.capabilityRun]: { args: [id: string, args: unknown]; result: CapabilityRunResponse }
  [CH.toolCreate]: { args: []; result: ToolCreateResult }
  [CH.toolList]: { args: []; result: ToolPageMeta[] }
  [CH.toolDelete]: { args: [id: string]; result: ToolResult }
  [CH.toolUpdateMeta]: {
    args: [id: string, patch: { title?: string; description?: string; icon?: string }]
    result: ToolUpdateMetaResult
  }
  [CH.toolUpdate]: { args: [id: string, changes: ToolChangeList]; result: ToolUpdateResult }
  [CH.toolGetPreloadPath]: { args: []; result: string }
  [CH.toolHistory]: { args: [id: string]; result: ToolHistoryResult }
  [CH.toolRollback]: { args: [id: string, oid: string]; result: ToolResult }
  [CH.toolPreview]: { args: [id: string, oid: string]; result: ToolPreviewResult }
  [CH.toolsPreviewList]: { args: []; result: ToolsPreviewListResult }
  [CH.toolsPreviewClear]: { args: []; result: ToolsPreviewClearResult }
  [CH.chatHistory]: { args: [taskId: number]; result: ChatMessage[] }
  [CH.chatSend]: { args: [taskId: number, text: string]; result: ChatMessage | null }
  [CH.chatAbort]: { args: []; result: void }
  [CH.generatorSend]: { args: [history: GeneratorMessage[]]; result: GeneratorSendResult }
  [CH.generatorAbort]: { args: []; result: void }
}

/** window.api 的权威形状：由 index.d.ts 派生，渲染层直接获得完整类型 */
export interface PreloadApi {
  listTasks: () => Promise<Task[]>
  createTask: () => Promise<Task>
  renameTask: (taskId: number, title: string) => Promise<Task | null>
  saveTasks: (tasks: Task[]) => Promise<void>
  model: {
    list: () => Promise<{ profiles: ModelProfile[]; activeId: string }>
    save: (profile: ModelProfileInput) => Promise<ModelProfile>
    delete: (id: string) => Promise<void>
    setActive: (id: string) => Promise<void>
    toggle: (id: string, enabled: boolean) => Promise<void>
    testChat: (config: ModelTestChatConfig) => Promise<TestChatResult>
  }
  provider: {
    list: () => Promise<ModelProvider[]>
  }
  settings: {
    getSystemPrompt: () => Promise<string>
    setSystemPrompt: (value: string) => Promise<void>
  }
  window: {
    getBounds: () => Promise<WindowBounds | null>
  }
  capability: {
    list: () => Promise<Capability[]>
    run: (id: string, args: unknown) => Promise<CapabilityRunResponse>
  }
  tool: {
    create: () => Promise<ToolCreateResult>
    list: () => Promise<ToolPageMeta[]>
    delete: (id: string) => Promise<ToolResult>
    updateMeta: (id: string, patch: { title?: string; description?: string; icon?: string }) => Promise<ToolUpdateMetaResult>
    update: (id: string, changes: ToolChangeList) => Promise<ToolUpdateResult>
    getPreloadPath: () => Promise<string>
    history: (id: string) => Promise<ToolHistoryResult>
    rollback: (id: string, oid: string) => Promise<ToolResult>
    preview: (id: string, oid: string) => Promise<ToolPreviewResult>
  }
  toolsPreview: {
    list: () => Promise<ToolsPreviewListResult>
    clear: () => Promise<ToolsPreviewClearResult>
  }
  chat: {
    history: (taskId: number) => Promise<ChatMessage[]>
    send: (taskId: number, text: string) => Promise<ChatMessage | null>
    abort: () => Promise<void>
    onEvent: (callback: (payload: ChatEventData) => void) => void
    offEvent: () => void
  }
  generator: {
    send: (history: GeneratorMessage[]) => Promise<GeneratorSendResult>
    abort: () => Promise<void>
    onEvent: (callback: (payload: GeneratorEventData) => void) => void
    offEvent: () => void
  }
}
