// 扩展侧 `window.api` 的权威形状（PreloadApi）。
//
// 历史：桌面版这里是完整的 Electron IPC 契约 —— 通道常量表（CH / EVENT_CH）+
// InvokeMap（preload 的 `invoke` ↔ 主进程 `handle` 的编译期对齐）+ PreloadApi。
// 扩展版**没有 preload**（src/lib/window-api.ts 直接装配实现后挂到 window），
// 故 2026-09-19 把这批桌面版残留清掉：
//   · CH / EVENT_CH / InvokeMap —— 全部只服务于 preload↔main 的通道映射；
//   · conversation.appendMessage —— 桌面版遗留的"渲染层直接写库"入口，平移后无调用方。
//     落盘唯一写方是 offscreen，只认 chat:start（用户消息）与收尾（AI 消息）两条路径，
//     且都走 lib/conversation-message.ts 的 toPersistedMessage 投影。
//
// 下面两处是**有意保留、不是残留**，别再当死代码清掉：
//   · agent.*           —— 未平移的 Agent 编排面，window-api 用 Proxy stub 兜底：调用即抛
//                          带完整路径的错误，比静默 undefined 更早暴露"这段界面还没接上"；
//   · window.getBounds  —— 扩展页没有无边框窗口，按「无窗口状态」应答。
//
// 本文件只含类型，可被扩展页 / service worker / offscreen 共同引用。
import type {
  AgentStreamChunk,
  AgentStreamSendResult,
  Conversation,
  ConversationSearchHit,
  Message,
  ModelProfile,
  ModelProfileInput,
  ModelProvider,
  ModelTestChatConfig,
  TestChatResult,
  WindowBounds,
  WorkspaceTabsState
} from './types'

/** window.api 的权威形状：由 src/types/shims.d.ts 派生，渲染层直接获得完整类型 */
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
  /** 未平移的 Agent 编排面（扩展版为 Proxy stub，调用即抛错） */
  agent: {
    abort: () => Promise<void>
    streamSend: (messages: import('ai').UIMessage[]) => Promise<AgentStreamSendResult>
    /** 订阅逐 chunk 推送，返回取消订阅函数 */
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
    delete: (id: string) => Promise<void>
    deleteAll: () => Promise<void>
  }
}
