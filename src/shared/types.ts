// 跨进程共享 DTO：全应用类型的唯一来源（main / preload / renderer 三方共用）。
// 收敛前各侧手写 interface 易 drift；此处统一定义后，各侧改为 re-export，
// 避免同一数据模型在三处重复维护。


import type { UIMessage, UIMessageChunk } from 'ai'

// —— 会话（解耦后的全局一等公民，主进程 conversation-store）——
export interface Conversation {
  id: string
  title: string
  createdAt: string
  /** 最后一条消息时间（ISO），用于会话列表排序/展示 */
  lastMessageAt: string
  /** 会话累计消耗 token（由消息 usage 汇总，历史列表/标题辅助展示用）；旧数据可能缺省 */
  totalTokens?: number
  /** 最近一条消息的正文预览（历史列表展示用，由消息派生、不落库）；无消息时缺省 */
  lastMessagePreview?: string
}

/** 一次模型生成消耗的 token 量（AI SDK LanguageModelUsage 的纯字面量透传，可安全过 IPC 与落盘） */
export interface TokenUsage {
  /** 输入侧 token（含工具结果回传、历史上下文） */
  inputTokens?: number
  /** 输出侧 token（模型生成的回复/思考） */
  outputTokens?: number
  /** 合计（input + output），多数场景以此为准 */
  totalTokens?: number
}

/** conversation:search 的命中项：会话 + 命中的消息内容片段（空查询返回最近会话时 snippet 为空） */
export interface ConversationSearchHit {
  conversation: Conversation
  snippet: string
}

/** 落盘消息的公共字段（两种角色都有）。
 *
 * **parts 必填**：它是回显的正文真相源（读侧 `toUiMessage` → ChatPanel 只按 parts 渲染），
 * content 只是由 parts 拍平出来的派生字段。曾经这里写成 `parts?`，结果 user 消息的落盘
 * 路径漏写了它 —— 重开会话后用户气泡全空，而 `content` 还在，静态检查却完全不报。
 * 落盘一律经 `lib/conversation-message.ts` 的 `toPersistedMessage`（单一投影），不要手写对象。 */
interface MessageBase {
  id: string
  conversationId: string
  content: string
  /** 完整 UIMessage.parts（text/reasoning/tool/file/data…），回显据此还原全部结构 */
  parts: UIMessage['parts']
  createdAt: string
}

/** 用户消息：随消息附带的页面上下文（元素拾取 / 页面快照，用户显式采集）只在这条路径上有。
 * 气泡 chip 与后续轮次「最近一次拾取」prompt 注入的数据源；未附上下文时缺省。 */
export interface UserMessage extends MessageBase {
  role: 'user'
  pageContext?: import('./extension-ipc').MessagePageContext
}

/** AI 消息：思考过程与 token 用量只在这条路径上有 */
export interface AssistantMessage extends MessageBase {
  role: 'assistant'
  /** AI 思考过程（reasoning）：从 parts 里的 reasoning part 拍平出来的冗余副本。
   * **目前没有程序读侧**（续跑重建已改走 parts，见 lib/conversation-message.ts），
   * 只有调试面板的原始 JSON 看得到 —— 留着是为检索/排查的近便，也可视作待清理项。 */
  reasoning?: string
  /** 本次生成消耗的 token，持久化为会话累计与单条耗时的唯一来源 */
  usage?: TokenUsage
}

/** 落盘消息（会话库 duoling-chat 的记录形状）。按 role 判别：
 * 读 usage / pageContext 这类角色专有字段时必须先判 role，避免张冠李戴。 */
export type Message = UserMessage | AssistantMessage

// —— 模型 ——
/** 渲染进程可见的模型配置（apiKey 不回传明文，只暴露是否已设置） */
export interface ModelProfile {
  id: string
  /** 模型展示名，如 DeepSeek-V3；未设置时回退为模型 ID */
  name: string
  /** 所属服务商（预设 id），自定义模型为空字符串 */
  providerId: string
  /** OpenAI 兼容接口地址，如 https://api.deepseek.com/v1 */
  baseUrl: string
  /** 模型 ID，如 deepseek-chat（请求时作为 model 字段） */
  model: string
  /** 是否已在模型列表中启用（开关） */
  enabled: boolean
  /** baseUrl 是否为完整接口地址：true 时不追加 /chat/completions */
  useFullUrl: boolean
  /** API 格式，目前仅支持 OpenAI Chat Completions */
  apiFormat: 'openai'
  hasApiKey: boolean
  /** 上下文输出 Token（高级配置，作为请求 max_tokens） */
  contextOutputToken?: number
  /** 采样参数：Temperature（0~2） */
  temperature?: number
  /** 采样参数：Top P（0~1） */
  topP?: number
  /** 采样参数：Top K（1~100） */
  topK?: number
}

/** 保存/新增模型配置的入参；apiKey 为空表示保留已有 Key（编辑时未重输） */
export interface ModelProfileInput {
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

/** 连通性测试入参（model:testChat） */
export interface ModelTestChatConfig {
  baseUrl: string
  apiKey: string
  model: string
  useFullUrl?: boolean
  /** 编辑态 API Key 未回显时，回退到该已保存配置的 Key */
  profileId?: string
}

/** 连通性测试结果 */
export type TestChatResult = { ok: true } | { ok: false; error: string }

/** 在线大模型服务商预设 */
export interface ModelProvider {
  id: string
  name: string
  /** OpenAI 兼容接口地址（不强制以 /v1 结尾，多数加上 /chat/completions 即可） */
  baseUrl: string
  /** 服务商控制台获取 API Key 的链接 */
  keyUrl: string
  /** 预置常用模型 ID */
  models: string[]
  /** 是否可直接用 Bearer 鉴权添加 */
  supported: boolean
}

/** 工作区标签页种类（渲染层 tabs 与主进程 agent_workspace_tabs 共用） */
export type WorkspaceTabKind =
  | 'settings'
  | 'guide'
  | 'ui-test'
  | 'userscript-list'
  | 'userscript-edit'
  | 'script-history'
  | 'us-bundle'
  | 'lfs-browser'
  | 'chat-data'
  | 'error-log'

/** 工作区打开标签页快照（渲染层 → 主进程上报，供 Agent 工具查询当前打开的 tab 页） */
export interface WorkspaceTabSnapshot {
  id: string
  title: string
  kind: WorkspaceTabKind
  /** 仅 userscript-edit / script-history / us-bundle：对应的用户脚本 uuid */
  userscriptId?: string
}

/** 工作区标签页状态快照：全部已打开的标签（顺序）+ 当前激活标签 id */
export interface WorkspaceTabsState {
  tabs: WorkspaceTabSnapshot[]
  activeTabId: string
}

// —— 未平移的桌面版 IPC 面（只有 PreloadApi 的 agent / window 两个占位成员在用）——
// 说明：这两组类型是桌面版契约的形状，扩展版把 agent 面做成了 Proxy stub（调用即抛错）、
// window 面按「无边框窗口不存在」应答；命名里的 contextBridge / 主进程指桌面版实现。
// 真接 Agent 编排时再按扩展侧的实际通道改写，别直接沿用这套 Electron 语义。
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Agent 流式响应的单个 chunk（channel: agent:stream 逐条推送）。
 * 直接复用 ai 的 UIMessageChunk：字段均为纯 JSON 结构化数据，可安全结构化克隆。 */
export type AgentStreamChunk = UIMessageChunk

/** agent:streamSend 的收尾状态（流通过 EVENT_CH.agentStream 逐 chunk 推送，此处仅在流结束后汇总）。
 * usage 为本次生成消耗的 token（从主进程 streamText onFinish 捕获）。 */
export type AgentStreamSendResult =
  | { ok: true; content?: string; reasoning?: string; usage?: TokenUsage }
  | { ok: false; content?: string; reasoning?: string; error: string }
