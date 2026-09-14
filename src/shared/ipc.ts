// IPC 契约收敛：通道常量 + InvokeMap（通道 → { args, result }）+ PreloadApi。
// 目的：
//  1. 消除 preload 中裸字符串通道名的重复（此前散落各处）。
//  2. InvokeMap 让 preload 侧 `invoke` 与主进程 `handle` 双向对齐：改签名时编译期报错。
//  3. PreloadApi 是 window.api 的权威形状，index.d.ts 由此派生，渲染层自动获得完整类型。
// 本文件只含类型与字符串常量，不依赖 electron，因此可被 main / preload / renderer 三方共同引用。
//
// 2026-09-14：工具链路移除（docs/tool-chain-removal-plan.md）后，工具类通道
// （tool:* / tool-group:* / tool-pin:* / tool-archive:* / tools-preview:* / tools-data:*）、
// 能力面（capability:*）、开发者界面（agent-tools:*）与工具落盘的 intents 通道
// （conversation:applyIntents / conversation:intents）整体摘除。

import type { UIMessage } from 'ai'

import type {
  AgentStreamChunk,
  AgentStreamSendResult,
  Conversation,
  ConversationSearchHit,
  Message,
  MessageRole,
  ModelProfile,
  ModelProfileInput,
  ModelProvider,
  ModelTestChatConfig,
  TestChatResult,
  TokenUsage,
  WindowBounds,
  WorkspaceTabsState
} from './types'

/** invoke 类通道名常量 */
export const CH = {
  modelList: 'model:list',
  modelSave: 'model:save',
  modelDelete: 'model:delete',
  modelSetActive: 'model:setActive',
  modelToggle: 'model:toggle',
  modelTestChat: 'model:testChat',
  providerList: 'provider:list',
  windowGetBounds: 'window:getBounds',
  /** 渲染层上报当前工作区打开标签页快照（供 Agent 工具查询当前打开的 tab 页） */
  workspaceTabsChanged: 'workspace:tabs-changed',
  agentAbort: 'agent:abort',
  /** AI SDK 流式通道：发起一次流式生成（主进程 consume toUIMessageStream 逐 chunk 推送） */
  agentStreamSend: 'agent:streamSend',
  conversationList: 'conversation:list',
  conversationSearch: 'conversation:search',
  conversationCreate: 'conversation:create',
  conversationRename: 'conversation:rename',
  conversationMessages: 'conversation:messages',
  conversationAppendMessage: 'conversation:appendMessage',
  conversationDelete: 'conversation:delete',
  conversationDeleteAll: 'conversation:delete-all'
} as const

/** 事件类通道名常量（主进程主动推送 → 渲染层） */
export const EVENT_CH = {
  /** AI SDK 流式通道：主进程逐 chunk 推送的 UIMessageChunk（渲染层 transport 收集为流喂给 useChat） */
  agentStream: 'agent:stream',
  /** AI SDK 流式通道结束：主进程推送收尾状态（含汇总 content/reasoning），渲染层据此 close 流 */
  agentStreamEnd: 'agent:stream-end'
} as const

/** invoke 通道 → { args, result } 映射：preload invoke 与主进程 handle 的编译期契约 */
export interface InvokeMap {
  [CH.modelList]: { args: []; result: { profiles: ModelProfile[]; activeId: string } }
  [CH.modelSave]: { args: [profile: ModelProfileInput]; result: ModelProfile }
  [CH.modelDelete]: { args: [id: string]; result: void }
  [CH.modelSetActive]: { args: [id: string]; result: void }
  [CH.modelToggle]: { args: [id: string, enabled: boolean]; result: void }
  [CH.modelTestChat]: { args: [config: ModelTestChatConfig]; result: TestChatResult }
  [CH.providerList]: { args: []; result: ModelProvider[] }
  [CH.windowGetBounds]: { args: []; result: WindowBounds | null }
  [CH.workspaceTabsChanged]: { args: [state: WorkspaceTabsState]; result: void }
  [CH.agentStreamSend]: {
    args: [messages: UIMessage[]]
    result: AgentStreamSendResult
  }
  [CH.agentAbort]: { args: []; result: void }
  [CH.conversationList]: { args: []; result: Conversation[] }
  [CH.conversationSearch]: { args: [query: string]; result: ConversationSearchHit[] }
  [CH.conversationCreate]: { args: []; result: Conversation }
  [CH.conversationRename]: { args: [id: string, title: string]; result: Conversation | null }
  [CH.conversationMessages]: { args: [conversationId: string]; result: Message[] }
  [CH.conversationAppendMessage]: {
    args: [
      conversationId: string,
      role: MessageRole,
      content: string,
      reasoning?: string,
      parts?: UIMessage['parts'],
      usage?: TokenUsage
    ]
    result: Message | null
  }
  [CH.conversationDelete]: { args: [id: string]; result: void }
  [CH.conversationDeleteAll]: { args: []; result: void }
}

/** window.api 的权威形状：由 index.d.ts 派生，渲染层直接获得完整类型 */
export interface PreloadApi {
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
  workspace: {
    /** 上报当前工作区打开标签页快照（供 Agent 工具查询当前打开的 tab 页） */
    tabsChanged: (state: WorkspaceTabsState) => Promise<void>
  }
  agent: {
    abort: () => Promise<void>
    /** AI SDK 流式通道：发起一次流式生成，流经由 onStreamChunk/onStreamEnd 推送到渲染层 */
    streamSend: (messages: UIMessage[]) => Promise<AgentStreamSendResult>
    /** 订阅主进程逐 chunk 推送的 UIMessageChunk，返回取消订阅函数 */
    onStreamChunk: (callback: (chunk: AgentStreamChunk) => void) => () => void
    /** 订阅流结束状态（含汇总 content/reasoning），返回取消订阅函数 */
    onStreamEnd: (callback: (result: AgentStreamSendResult) => void) => () => void
  }
  conversation: {
    list: () => Promise<Conversation[]>
    /** 搜索会话：匹配标题或消息内容；空查询返回最近会话（snippet 为空） */
    search: (query: string) => Promise<ConversationSearchHit[]>
    create: () => Promise<Conversation>
    rename: (id: string, title: string) => Promise<Conversation | null>
    messages: (conversationId: string) => Promise<Message[]>
    appendMessage: (
      conversationId: string,
      role: MessageRole,
      content: string,
      reasoning?: string,
      parts?: UIMessage['parts'],
      usage?: TokenUsage
    ) => Promise<Message | null>
    delete: (id: string) => Promise<void>
    deleteAll: () => Promise<void>
  }
}
