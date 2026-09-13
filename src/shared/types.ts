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

/** 一次「多工具改动」中单个工具的编辑意图（挂在某条 AI 消息下） */
export type EditIntentStatus = 'pending' | 'applied' | 'failed' | 'rejected'

export interface EditIntent {
  id: string
  messageId: string
  toolId: string
  summary: string
  actions: ToolChangeAction[]
  status: EditIntentStatus
  /** 落盘失败时的错误信息（status = failed 时有值） */
  error?: string
  createdAt: string
}

// 主进程 → 渲染层「打开工具」命令（channel: tool:open-command）。
// 由 agent.tools.open 触发：AI 决定打开某工具时，主进程广播命令，渲染层据此切换/新建工具标签页。
export interface ToolOpenCommand {
  toolId: string
  title: string
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

// —— 原子能力 ——
export type CapabilityRuntime = 'frontend' | 'backend'
export type CapabilitySideEffect = 'read' | 'write' | 'notify' | 'destructive'
export type CapabilityCost = 'offline' | 'online'

/** 面向 AI 的检索元数据：用户意图 → scenario 命中确定能力 id */
export interface CapabilityScenario {
  keywords: string[]
  object: string
}

/** 原子能力统一契约（inputSchema/outputSchema 为标准 JSON Schema，由注册表 zod schema 序列化而来） */
export interface Capability {
  id: string
  name: string
  description: string
  /** 输入参数的标准 JSON Schema（纯字面量，可序列化过 IPC） */
  inputSchema: Record<string, unknown>
  /** 输出参数的标准 JSON Schema（纯字面量，可序列化过 IPC） */
  outputSchema: Record<string, unknown>
  sideEffect: CapabilitySideEffect
  runtime: CapabilityRuntime
  cost: CapabilityCost
  scenario: CapabilityScenario
}

/** cap.run 的执行结果（渲染层视角） */
export type CapabilityRunResponse = { ok: true; result: unknown } | { ok: false; error: string }

// —— 工具页面 ——
/** 工具元信息：tool:list 返回、主页网格与全局搜索共用 */
export interface UserToolMeta {
  id: string
  name: string
  title: string
  description: string
  /** 单个字符图标；空串表示未设置（渲染层兜底为工具名首字符） */
  icon?: string
  /** 本工具声明可调用的能力 id 白名单；缺省/空数组视为不声明任何能力 */
  capabilities?: string[]
}

/** 工具分组映射：toolId → 分组名。用户独立配置，不落 meta.json。 */
export type ToolGroupMap = Record<string, string>

/** 工具只读锁查询结果（capability: tool.lock.status）。Phase 1 只读不写：恒为「未被持有」。 */
export interface ToolLockStatus {
  toolId: string
  locked: boolean
  holderId?: string
}

/** 生成器变更动作：整文件覆盖（write）或精确替换（patch） */
export type ToolChangeOp = 'write' | 'patch'

export interface ToolChangeAction {
  op: ToolChangeOp
  /** 工具目录内的相对文件名，白名单限 index.html / meta.json */
  file: string
  /** write：整文件内容（index.html 为字符串；meta.json 传 { name,title,description } 对象，会与现有元信息合并） */
  content?: unknown
  /** patch：需要被替换的精确查找串 */
  find?: string
  /** patch：查找串被替换成的目标串 */
  replace?: string
  /** patch：是否全局替换（默认 false，仅替换第一处） */
  replace_all?: boolean
}

/** 生成器对当前工具的一次整体改动描述 */
export interface ToolChangeList {
  /** 一句话描述本次改动 */
  summary: string
  actions: ToolChangeAction[]
}

/** 多工具契约：一次对话可声明的单个工具编辑意图（渲染层解析 `intents[]` 得到的形状） */
export interface GeneratedIntent {
  toolId: string
  summary: string
  actions: ToolChangeAction[]
}

/** conversation:applyIntents 的入参：对某条 AI 消息声明的一批工具意图 */
export interface ApplyIntentsInput {
  conversationId: string
  messageId: string
  intents: GeneratedIntent[]
}

/** 单个工具应用结果（conversation:applyIntents 返回） */
export interface ApplyIntentEntryResult {
  toolId: string
  ok: boolean
  /** 成功且工具标题可能更新时返回最新标题，供渲染层同步标签名 */
  title?: string
  error?: string
}

export type ApplyIntentsResult =
  | { ok: true; results: ApplyIntentEntryResult[] }
  | { ok: false; results: ApplyIntentEntryResult[]; error: string }

/** Agent 工具的 OpenAI function 风格 JSON Schema 描述（agent-tools:list 返回，开发者界面展示用） */
export interface AgentToolJsonSchema {
  type: 'function'
  function: {
    name: string
    description?: string
    /** 输入参数的 JSON Schema（纯字面量，可序列化） */
    parameters: Record<string, unknown>
    /** 输出的 JSON Schema（纯字面量，可序列化；仅对返回结构固定的工具配置） */
    outputSchema?: Record<string, unknown>
    /** 测试用的提示词：一段用户侧对话输入，用于验证 AI 对该工具的调用 */
    testPrompt?: string
  }
}

/** 工作区标签页种类（渲染层 tabs 与主进程 agent_workspace_tabs 共用） */
export type WorkspaceTabKind =
  | 'home'
  | 'tool'
  | 'settings'
  | 'tool-history'
  | 'tool-archive'
  | 'tool-code'
  | 'tool-data'
  | 'developer'
  | 'ui-test'

/** 工作区打开标签页快照（渲染层 → 主进程上报，供 Agent 工具查询当前打开的 tab 页） */
export interface WorkspaceTabSnapshot {
  id: string
  title: string
  kind: WorkspaceTabKind
  toolId?: string
  toolTitle?: string
  icon?: string
}

/** 工作区标签页状态快照：全部已打开的标签（顺序）+ 当前激活标签 id */
export interface WorkspaceTabsState {
  tabs: WorkspaceTabSnapshot[]
  activeTabId: string
}

// 一次提交的快照（新提交在前）
export interface ToolCommit {
  oid: string
  message: string
  author: string
  timestamp: number
}

// —— IPC 相关响应类型 ——
export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export type ToolCreateResult =
  | { ok: true; id: string; title?: string }
  | { ok: false; error: string }

export type ToolResult = { ok: boolean; error?: string }

/** toolArchive:read 的结果：工具档案 archive.md 内容（无档案时 content 为空串） */
export type ToolArchiveResult = { ok: true; content: string } | { ok: false; error: string }

/** 工具源码文件（tool:code-tree 返回；content 为 utf8 或 base64，encoding 标记解码方式） */
export interface ToolCodeFile {
  path: string
  content: string
  encoding: 'utf8' | 'base64'
}

export type ToolCodeResult = { ok: true; files: ToolCodeFile[] } | { ok: false; error: string }

export type ToolUpdateMetaResult =
  | { ok: true; title?: string; icon?: string }
  | { ok: false; error: string }

export type ToolUpdateResult =
  | { ok: true; title?: string; changedFiles?: string[] }
  | { ok: false; error: string }

export type ToolHistoryResult = { ok: true; commits: ToolCommit[] } | { ok: false; error: string }

/**
 * 版本预览结果。
 * 桌面版：主进程把目标提交物化到磁盘，返回可被 webview 加载的 `tool-preview://` URL。
 * 扩展版没有可渲染的文件 URL，改为把该提交下的工具页 HTML 一并返回（`html`），
 * 由渲染层以 sandbox iframe 的 srcdoc 承载；此时 `url` 为空串。
 */
export type ToolPreviewResult =
  | { ok: true; url: string; html?: string }
  | { ok: false; error: string }

export type ToolsPreviewListResult =
  | { ok: true; size: number; versions: number }
  | { ok: false; error: string }

export type ToolsPreviewClearResult = { ok: true } | { ok: false; error: string }

// —— 工具数据 ——
/** 单个 key 的数据文件信息（tool.data 能力落盘的 JSON） */
export interface ToolsDataEntry {
  /** 数据键，即 tool.data.write 传入的 key（白名单 [A-Za-z0-9_-]+） */
  key: string
  /** 该数据文件字节数 */
  size: number
  /** 最后写入时间（ISO 字符串） */
  updatedAt: string
}

/** 工具数据概览：settings-panel 工具数据表格的一行 */
export interface ToolsDataOverview {
  /** 工具 id */
  id: string
  /** 工具标题；孤儿数据（对应工具已删除）回退为空串 */
  title: string
  createdAt: string
  updatedAt: string
  /** 各 key 文件总字节数 */
  sizeBytes: number
  /** key 个数 */
  keyCount: number
  /** 是否孤儿：对应 <userData>/tools/<id>/meta.json 不存在 */
  orphan: boolean
}

/** 工具数据详情：tool-data-detail tab 展示 */
export interface ToolsDataDetail {
  /** 工具 id */
  id: string
  /** 工具标题；孤儿数据回退为空串 */
  title: string
  createdAt: string
  updatedAt: string
  sizeBytes: number
  entries: ToolsDataEntry[]
}

/** 工具数据列表结果（channel: tools-data:list） */
export type ToolsDataListResult = { ok: true; items: ToolsDataOverview[] } | { ok: false; error: string }

/** 工具数据详情结果（channel: tools-data:detail） */
export type ToolsDataDetailResult = { ok: true; detail: ToolsDataDetail } | { ok: false; error: string }

/** 清空某工具全部数据结果（channel: tools-data:clear） */
export type ToolsDataClearResult = { ok: true } | { ok: false; error: string }

/** 清理孤儿数据结果（channel: tools-data:delete-orphan） */
export type ToolsDataDeleteOrphanResult = { ok: true; removed: number } | { ok: false; error: string }

/** 在系统文件管理器中打开数据目录结果（channel: tools-data:open） */
export type ToolsDataOpenResult = { ok: true } | { ok: false; error: string }

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
