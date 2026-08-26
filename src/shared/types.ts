// 跨进程共享 DTO：全应用类型的唯一来源（main / preload / renderer 三方共用）。
// 收敛前各侧手写 interface 易 drift；此处统一定义后，各侧改为 re-export，
// 避免同一数据模型在三处重复维护。

// —— 任务（会话） ——
export interface Task {
  id: number
  title: string
  createdAt: string
}

// —— 聊天 ——
export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  id: number
  role: ChatRole
  content: string
  createdAt: string
}

// —— 会话（解耦后的全局一等公民，主进程 conversation-store）——
export interface Conversation {
  id: string
  title: string
  createdAt: string
  /** 最后一条消息时间（ISO），用于会话列表排序/展示 */
  lastMessageAt: string
}

export type MessageRole = 'user' | 'assistant'

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  content: string
  /** AI 思考过程（reasoning），与正文分离存储；仅 assistant 消息可能有 */
  reasoning?: string
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

// AI 对话流式事件（主进程 → 渲染层，channel: agent:event）。
// 思考过程与正文从一开始就分离：reasoning 写 reasoning（text），content 写正文（token），
// 渲染层无需再用 <think> 标签切分，与业界标准消息模型 { role, content, reasoning? } 一致。
// tool_start / tool_result 由 Agent Loop 回调产生：AI 自主调用工具时逐步推给渲染层作步骤展示
export type AgentEventData =
  | { type: 'token'; token: string }
  | { type: 'reasoning'; text: string }
  | { type: 'done'; content: string; reasoning?: string }
  | { type: 'aborted'; content: string; reasoning?: string }
  | { type: 'error'; error: string }
  | { type: 'tool_start'; name: string; arguments: string }
  | { type: 'tool_result'; name: string; ok: boolean; result?: string; error?: string }

// 主进程 → 渲染层「打开工具」命令（channel: tool:open-command）。
// 由 agent.tools.open 触发：AI 决定打开某工具时，主进程广播命令，渲染层据此切换/新建工具标签页。
export interface ToolOpenCommand {
  toolId: string
  title: string
}

/** AI 对话历史的一项（仅 role + content，带 id/createdAt 的完整 ChatMessage 仅主进程内部需要） */
export interface AgentMessage {
  role: ChatRole
  content: string
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
export interface TestChatResult {
  ok: boolean
  error?: string
}

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

export interface CapabilitySchemaField {
  /** 字段类型：string/number/boolean 等基础类型，或 file/files/markdown 等语义类型 */
  type: string
  /** 字段说明，供工具界面推导表单/输入提示 */
  description: string
}

export interface CapabilitySchema {
  type: string
  description: string
  fields?: Record<string, CapabilitySchemaField>
}

/** 面向 AI 的检索元数据：用户意图 → scenario 命中确定能力 id */
export interface CapabilityScenario {
  keywords: string[]
  object: string
}

/** 原子能力统一契约 */
export interface Capability {
  id: string
  name: string
  description: string
  inputSchema: CapabilitySchema
  outputSchema: CapabilitySchema
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

export type ApplyIntentsResult = { ok: boolean; results: ApplyIntentEntryResult[]; error?: string }

/** agent:send 附带的工具上下文：告诉 AI「当前正在编辑哪个工具」，使 intents 默认指向它 */
export interface AgentToolContext {
  /** 用户当前正在查看/编辑的工具 id（intents 默认指向它） */
  currentToolId: string
  /** 当前打开的工具标题（标签名），仅用于提示文案 */
  currentToolTitle?: string
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

export interface ToolCreateResult {
  ok: boolean
  id?: string
  title?: string
  error?: string
}

export type ToolResult = { ok: boolean; error?: string }

export interface ToolUpdateMetaResult {
  ok: boolean
  title?: string
  icon?: string
  error?: string
}

export interface ToolUpdateResult {
  ok: boolean
  title?: string
  changedFiles?: string[]
  error?: string
}

export type ToolHistoryResult = { ok: true; commits: ToolCommit[] } | { ok: false; error: string }

export type ToolPreviewResult = { ok: true; url: string } | { ok: false; error: string }

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

/** AI 对话 send 的结果（channel: agent:send） */
export interface AgentSendResult {
  ok: boolean
  content?: string
  reasoning?: string
  error?: string
}
