// 应用侧 DTO：模型配置、工作区标签这些**只有扩展界面用**的形状。
// 会话与消息形状已归 @duoling/shared（进程包与应用侧都要认它），此处只转发。

// —— 会话 / 消息 / token ——
// 形状已归 @duoling/shared（写侧在 offscreen、读方在 SW 与扩展页，三个语境同取一份）。
// 此处 re-export，既有 `@/shared/types` 的 import 路径不变。
export type {
  AssistantMessage,
  Conversation,
  ConversationSearchHit,
  Message,
  MessageModelRef,
  TokenUsage,
  UserMessage,
} from '@duoling/shared'

// —— 模型 ——
// 模型配置的形状已归 @duoling/shared（SW 从存储读出、offscreen 拿它发请求、面板拿它渲染）。
// 此处 re-export，既有 `@/shared/types` 的 import 路径不变。
export type { ModelProfile } from '@duoling/shared'

/** 保存/新增模型配置的入参；apiKey 为空表示保留已有 Key（编辑时未重输） */
export interface ModelProfileInput {
  id?: string
  name: string
  providerId?: string
  baseUrl: string
  apiKey: string
  model: string
  contextOutputToken?: number
  temperature?: number
  topP?: number
  topK?: number
  /** 流式静默超时（秒），见 ModelProfile.streamIdleTimeoutSec */
  streamIdleTimeoutSec?: number
}

/** 连通性测试入参（model:testChat） */
export interface ModelTestChatConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 编辑态 API Key 未回显时，回退到该已保存配置的 Key */
  profileId?: string
}

/** 连通性测试结果 */
export type TestChatResult = { ok: true } | { ok: false; error: string }

/** 在线大模型服务商预设 */
export interface ModelProvider {
  id: string
  name: string
  /** 完整的 Chat Completions 端点地址（含 /chat/completions，原样请求不做拼接） */
  baseUrl: string
  /** 服务商控制台获取 API Key 的链接 */
  keyUrl: string
  /** 预置常用模型 ID */
  models: string[]
  /** 是否可直接用 Bearer 鉴权添加 */
  supported: boolean
}

/** 工作区标签页种类（渲染层标签栏与内容面板共用） */
export type WorkspaceTabKind =
  | 'settings'
  | 'guide'
  | 'help'
  | 'userscript-list'
  | 'userscript-edit'
  | 'script-history'
  | 'lfs-browser'
  | 'session-history'
  | 'agent-tools'
  | 'gm-api'
  | 'tab-activity'

