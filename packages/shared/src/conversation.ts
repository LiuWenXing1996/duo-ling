// 会话与消息的落盘形状（会话库 duoling-chat 的记录 + 列表展示用的派生形状）。
//
// 为什么住在契约包：写侧（offscreen 的 conv:* 与 chat 落盘）、读侧（SW 的页面概览、
// 扩展页的会话面板）分处三个语境，形状只能有一处真相源。应用侧 src/shared/types.ts
// 保留同名 re-export，消费方的 import 路径不变。
import type { UIMessage } from 'ai'
import type { MessagePageContext } from './page-context'

/** 会话（解耦后的全局一等公民，主进程 conversation-store） */
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
  pageContext?: MessagePageContext
}

/** 本次生成实际使用的模型快照（发起那一刻从当前配置取）。
 *
 * **为什么必须带 providerId 而不只是模型 ID**：同一个模型 ID 会出现在多家预设里
 * （`MiniMax-M3` 有 CN / Global 两家、`glm-5.3` 有三家），`volcengine` 与 `modelark`
 * 更是连 baseUrl 都完全相同 —— 只记 ID 事后分不清来源，而端点在两者之间根本没有区分力。
 * providerId 是预设表的受控枚举（`lib/providers.ts`），既无歧义也不含用户资产。 */
export interface MessageModelRef {
  /** 服务商预设 id（`ModelProvider.id`，如 deepseek / volcengine / ppio 这类受控枚举） */
  providerId: string
  /** 模型 ID，即请求体 model 字段的原值 —— 可能自身含 `/`（如 `deepseek-ai/DeepSeek-V4-Pro`） */
  id: string
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
  /** 本次生成用的模型（发起那一刻从当前配置取的快照，见 MessageModelRef）。
   * 刻意与模型配置解耦：模型是可随时切换的运行时选择，落盘这一份是事后唯一能回答
   * 「这条是哪个模型答的」的凭据 —— 用户改配置 / 换激活模型都不会改写历史记录。
   * 目前没有程序读侧（同 `reasoning`），调试面板的原始 JSON 看得到。 */
  model?: MessageModelRef
}

/** 落盘消息（会话库 duoling-chat 的记录形状）。按 role 判别：
 * 读 usage / pageContext 这类角色专有字段时必须先判 role，避免张冠李戴。 */
export type Message = UserMessage | AssistantMessage
