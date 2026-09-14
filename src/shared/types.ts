// 跨进程共享 DTO：全应用类型的唯一来源（main / preload / renderer 三方共用）。
// 收敛前各侧手写 interface 易 drift；此处统一定义后，各侧改为 re-export，
// 避免同一数据模型在三处重复维护。
//
// 2026-09-14：工具链路移除（docs/tool-chain-removal-plan.md）后，EditIntent / 工具元信息 /
// 工具变更契约 / 原子能力 / 工具数据 / 工具版本等类型整体摘除；WorkspaceTabKind 收窄为
// 脚本工作台实际存在的五种。

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

export type MessageRole = 'user' | 'assistant'

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  /** AI 思考过程（reasoning），与正文分离存储；仅 assistant 消息可能有 */
  reasoning?: string
  /** 完整 UIMessage.parts（reasoning/text/tool）。
   * 回读时据此还原分轮思考 / 工具卡 / 多段正文；兼容旧数据：无 parts 时回退用 content+reasoning。 */
  parts?: UIMessage['parts']
  /** 本次生成消耗的 token（仅 assistant 消息有值），持久化为会话累计与单条耗时的唯一来源 */
  usage?: TokenUsage
  createdAt: string
}

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
  | 'home'
  | 'settings'
  | 'ui-test'
  | 'userscript-list'
  | 'userscript-edit'
  | 'lfs-browser'

/** 工作区打开标签页快照（渲染层 → 主进程上报，供 Agent 工具查询当前打开的 tab 页） */
export interface WorkspaceTabSnapshot {
  id: string
  title: string
  kind: WorkspaceTabKind
  /** 仅 userscript-edit：对应的用户脚本 uuid */
  userscriptId?: string
}

/** 工作区标签页状态快照：全部已打开的标签（顺序）+ 当前激活标签 id */
export interface WorkspaceTabsState {
  tabs: WorkspaceTabSnapshot[]
  activeTabId: string
}

// —— IPC 相关响应类型 ——
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

// —— AI SDK 流式通道（方案 B 阶段 A）——
// 渲染层用 @ai-sdk/vue useChat({ transport })，主进程用 streamText + toUIMessageStream。
// 原生 ReadableStream 无法过 contextBridge（结构化克隆不支持），因此主进程消费
// toUIMessageStream() 的 reader，逐 chunk 经 webContents.send 推给渲染层，渲染层 transport 收集为流再喂给 useChat。

/** Agent 流式响应的单个 chunk（channel: agent:stream 逐条推送）。
 * 直接复用 ai 的 UIMessageChunk：其字段均为纯 JSON 结构化数据，可安全通过 contextBridge 结构化克隆，
 * 且渲染层无需再做形状转换即可喂给 useChat（内部由 readUIMessageStream 累积为 UIMessage.parts）。 */
export type AgentStreamChunk = UIMessageChunk

/** agent:streamSend 的收尾状态（流通过 EVENT_CH.agentStream 逐 chunk 推送，此处仅在流结束后汇总）。
 * usage 为本次生成消耗的 token（从主进程 streamText onFinish 捕获，供渲染层持久化与展示）。 */
export type AgentStreamSendResult =
  | { ok: true; content?: string; reasoning?: string; usage?: TokenUsage }
  | { ok: false; content?: string; reasoning?: string; error: string }
