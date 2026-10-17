// 应用侧 DTO：模型配置、工作区标签这些**只有扩展界面用**的形状。
// 会话与消息形状已归 @duoling/shared（进程包与应用侧都要认它），此处只转发。


import type { UIMessageChunk } from 'ai'
import type { TokenUsage } from '@duoling/shared'

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
/** 渲染进程可见的模型配置（apiKey 不回传明文，只暴露是否已设置） */
export interface ModelProfile {
  id: string
  /** 模型展示名，如 DeepSeek-V4.1-Flash；未设置时回退为模型 ID */
  name: string
  /** 所属服务商（预设 id），自定义模型为空字符串 */
  providerId: string
  /** 完整的 Chat Completions 端点地址，如 https://api.deepseek.com/chat/completions。
   *  请求时**原样使用**，不再拼接任何路径 —— 填什么用什么，填错由「测试连接」当场暴露 */
  baseUrl: string
  /** 模型 ID，如 deepseek-flash（请求时作为 model 字段） */
  model: string
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
  /** 流式静默超时（秒）：两次回复间隔超过此值即判定服务卡死并中止生成，避免请求长期占用连接触发限流；不填用默认 60 */
  streamIdleTimeoutSec?: number
}

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

/** 工作区标签页种类（渲染层 tabs 与主进程 agent_workspace_tabs 共用） */
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

/** 工作区打开标签页快照（渲染层 → 主进程上报，供 Agent 工具查询当前打开的 tab 页） */
export interface WorkspaceTabSnapshot {
  id: string
  title: string
  kind: WorkspaceTabKind
  /** 仅 userscript-edit / script-history：对应的用户脚本 uuid */
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
