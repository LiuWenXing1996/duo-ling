// IPC 契约收敛：通道常量 + InvokeMap（通道 → { args, result }）+ PreloadApi。
// 目的：
//  1. 消除 preload 中裸字符串通道名的重复（此前散落各处）。
//  2. InvokeMap 让 preload 侧 `invoke` 与主进程 `handle` 双向对齐：改签名时编译期报错。
//  3. PreloadApi 是 window.api 的权威形状，index.d.ts 由此派生，渲染层自动获得完整类型。
// 本文件只含类型与字符串常量，不依赖 electron，因此可被 main / preload / renderer 三方共同引用。

import type { UIMessage } from 'ai'

import type {
  ApplyIntentsInput,
  ApplyIntentsResult,
  AgentToolJsonSchema,
  Capability,
  CapabilityRunResponse,
  AgentStreamChunk,
  AgentStreamSendResult,
  AgentToolContext,
  Conversation,
  EditIntent,
  Message,
  MessageRole,
  ModelProfile,
  ModelProfileInput,
  ModelProvider,
  ModelTestChatConfig,
  Task,
  TestChatResult,
  ToolArchiveResult,
  ToolChangeList,
  ToolCodeResult,
  ToolCreateResult,
  ToolHistoryResult,
  UserToolMeta,
  ToolPreviewResult,
  ToolResult,
  ToolsDataClearResult,
  ToolsDataDeleteOrphanResult,
  ToolsDataDetailResult,
  ToolsDataListResult,
  ToolsDataOpenResult,
  ToolOpenCommand,
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
  toolCodeTree: 'tool:code-tree',
  toolRollback: 'tool:rollback',
  toolPreview: 'tool:preview',
  toolArchiveRead: 'tool-archive:read',
  toolsPreviewList: 'tools-preview:list',
  toolsPreviewClear: 'tools-preview:clear',
  toolsDataList: 'tools-data:list',
  toolsDataDetail: 'tools-data:detail',
  toolsDataClear: 'tools-data:clear',
  toolsDataDeleteOrphan: 'tools-data:delete-orphan',
  toolsDataOpen: 'tools-data:open',
  agentAbort: 'agent:abort',
  /** AI SDK 流式通道：发起一次流式生成（主进程 consume toUIMessageStream 逐 chunk 推送） */
  agentStreamSend: 'agent:streamSend',
  /** 列出全部 Agent 工具的 JSON Schema 描述（开发者界面展示用） */
  agentToolsList: 'agent-tools:list',
  conversationList: 'conversation:list',
  conversationCreate: 'conversation:create',
  conversationRename: 'conversation:rename',
  conversationMessages: 'conversation:messages',
  conversationAppendMessage: 'conversation:appendMessage',
  conversationApplyIntents: 'conversation:applyIntents',
  conversationIntents: 'conversation:intents',
  conversationDelete: 'conversation:delete',
  conversationDeleteAll: 'conversation:delete-all'
} as const

/** 事件类通道名常量（主进程主动推送 → 渲染层） */
export const EVENT_CH = {
  /** AI SDK 流式通道：主进程逐 chunk 推送的 UIMessageChunk（渲染层 transport 收集为流喂给 useChat） */
  agentStream: 'agent:stream',
  /** AI SDK 流式通道结束：主进程推送收尾状态（含汇总 content/reasoning），渲染层据此 close 流 */
  agentStreamEnd: 'agent:stream-end',
  /** 主进程通知渲染层打开某个工具（agent.tools.open 触发） */
  toolOpenCommand: 'tool:open-command'
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
  [CH.windowGetBounds]: { args: []; result: WindowBounds | null }
  [CH.capabilityList]: { args: []; result: Capability[] }
  [CH.capabilityRun]: { args: [id: string, args: unknown]; result: CapabilityRunResponse }
  [CH.toolCreate]: { args: []; result: ToolCreateResult }
  [CH.toolList]: { args: []; result: UserToolMeta[] }
  [CH.toolDelete]: { args: [id: string, keepData?: boolean]; result: ToolResult }
  [CH.toolUpdateMeta]: {
    args: [id: string, patch: { title?: string; description?: string; icon?: string }]
    result: ToolUpdateMetaResult
  }
  [CH.toolUpdate]: { args: [id: string, changes: ToolChangeList]; result: ToolUpdateResult }
  [CH.toolGetPreloadPath]: { args: []; result: string }
  [CH.toolHistory]: { args: [id: string]; result: ToolHistoryResult }
  [CH.toolCodeTree]: { args: [id: string]; result: ToolCodeResult }
  [CH.toolRollback]: { args: [id: string, oid: string]; result: ToolResult }
  [CH.toolPreview]: { args: [id: string, oid: string]; result: ToolPreviewResult }
  [CH.toolArchiveRead]: { args: [id: string]; result: ToolArchiveResult }
  [CH.toolsPreviewList]: { args: []; result: ToolsPreviewListResult }
  [CH.toolsPreviewClear]: { args: []; result: ToolsPreviewClearResult }
  [CH.toolsDataList]: { args: []; result: ToolsDataListResult }
  [CH.toolsDataDetail]: { args: [id: string]; result: ToolsDataDetailResult }
  [CH.toolsDataClear]: { args: [id: string]; result: ToolsDataClearResult }
  [CH.toolsDataDeleteOrphan]: { args: []; result: ToolsDataDeleteOrphanResult }
  [CH.toolsDataOpen]: { args: [id: string]; result: ToolsDataOpenResult }
  [CH.agentStreamSend]: {
    args: [messages: UIMessage[], context?: AgentToolContext]
    result: AgentStreamSendResult
  }
  [CH.agentAbort]: { args: []; result: void }
  [CH.agentToolsList]: { args: []; result: AgentToolJsonSchema[] }
  [CH.conversationList]: { args: []; result: Conversation[] }
  [CH.conversationCreate]: { args: []; result: Conversation }
  [CH.conversationRename]: { args: [id: string, title: string]; result: Conversation | null }
  [CH.conversationMessages]: { args: [conversationId: string]; result: Message[] }
  [CH.conversationAppendMessage]: {
    args: [
      conversationId: string,
      role: MessageRole,
      content: string,
      reasoning?: string,
      parts?: UIMessage['parts']
    ]
    result: Message | null
  }
  [CH.conversationApplyIntents]: { args: [input: ApplyIntentsInput]; result: ApplyIntentsResult }
  [CH.conversationIntents]: { args: [conversationId: string]; result: EditIntent[] }
  [CH.conversationDelete]: { args: [id: string]; result: void }
  [CH.conversationDeleteAll]: { args: []; result: void }
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
  window: {
    getBounds: () => Promise<WindowBounds | null>
  }
  capability: {
    list: () => Promise<Capability[]>
    run: (id: string, args: unknown) => Promise<CapabilityRunResponse>
  }
  tool: {
    create: () => Promise<ToolCreateResult>
    list: () => Promise<UserToolMeta[]>
    delete: (id: string, keepData?: boolean) => Promise<ToolResult>
    updateMeta: (id: string, patch: { title?: string; description?: string; icon?: string }) => Promise<ToolUpdateMetaResult>
    update: (id: string, changes: ToolChangeList) => Promise<ToolUpdateResult>
    getPreloadPath: () => Promise<string>
    history: (id: string) => Promise<ToolHistoryResult>
    codeTree: (id: string) => Promise<ToolCodeResult>
    rollback: (id: string, oid: string) => Promise<ToolResult>
    preview: (id: string, oid: string) => Promise<ToolPreviewResult>
    archive: {
      read: (id: string) => Promise<ToolArchiveResult>
    }
    /** 监听主进程「打开工具」命令（agent.tools.open 触发），返回取消订阅函数 */
    onOpenCommand: (callback: (payload: ToolOpenCommand) => void) => () => void
  }
  toolsPreview: {
    list: () => Promise<ToolsPreviewListResult>
    clear: () => Promise<ToolsPreviewClearResult>
  }
  toolsData: {
    list: () => Promise<ToolsDataListResult>
    detail: (id: string) => Promise<ToolsDataDetailResult>
    clear: (id: string) => Promise<ToolsDataClearResult>
    deleteOrphan: () => Promise<ToolsDataDeleteOrphanResult>
    open: (id: string) => Promise<ToolsDataOpenResult>
  }
  agent: {
    abort: () => Promise<void>
    /** AI SDK 流式通道：发起一次流式生成，流经由 onStreamChunk/onStreamEnd 推送到渲染层 */
    streamSend: (messages: UIMessage[], context?: AgentToolContext) => Promise<AgentStreamSendResult>
    /** 订阅主进程逐 chunk 推送的 UIMessageChunk，返回取消订阅函数 */
    onStreamChunk: (callback: (chunk: AgentStreamChunk) => void) => () => void
    /** 订阅流结束状态（含汇总 content/reasoning），返回取消订阅函数 */
    onStreamEnd: (callback: (result: AgentStreamSendResult) => void) => () => void
  }
  agentTools: {
    /** 列出全部 Agent 工具的 JSON Schema 描述（开发者界面展示用） */
    list: () => Promise<AgentToolJsonSchema[]>
  }
  conversation: {
    list: () => Promise<Conversation[]>
    create: () => Promise<Conversation>
    rename: (id: string, title: string) => Promise<Conversation | null>
    messages: (conversationId: string) => Promise<Message[]>
    appendMessage: (
      conversationId: string,
      role: MessageRole,
      content: string,
      reasoning?: string,
      parts?: UIMessage['parts']
    ) => Promise<Message | null>
    applyIntents: (input: ApplyIntentsInput) => Promise<ApplyIntentsResult>
    intents: (conversationId: string) => Promise<EditIntent[]>
    delete: (id: string) => Promise<void>
    deleteAll: () => Promise<void>
  }
}
