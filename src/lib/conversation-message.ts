// 落盘 Message（会话库 duoling-chat）⇄ 渲染 UIMessage（UI 层）之间的**唯一**转换点。
//
// 存在的理由（2026-09-19 的真实事故）：这两层的字段并不一一对应，转换必须逐字段挑，
// 而"手写挑字段"的代码一旦散落多处就会 drift —— user 消息的落盘只挑了 content、
// 漏了 parts（回显的正文真相源），于是「刚发出时看得到（面板内存里的乐观消息）、
// 重开会话后用户气泡全空（读库时按 parts 渲染）」，content 还在、行为却变了。
//
// 故两条铁律：
//   ① 写侧（offscreen）落盘一律走 `toPersistedMessage`，禁止再手写落盘对象；
//      user 路径（chat:start 带来的 UIMessage）与 assistant 路径（chunks 重建出的
//      UIMessage）**共用同一个投影**，漏字段不可能只发生在一侧。
//   ② 读侧（面板）一律走 `toUiMessage`：正文以 parts 为准，content 只是派生值。
//
// 派生口径：content = textOfMessage(parts)（写侧落盘时拍平，供自动命名 / 检索 / 调试视图），
// reasoning 同理；两者都是"派生"，parts 才是真相源 —— 与 ai-elements 的渲染口径一致。
import type { UIMessage } from 'ai'
import type { Message, TokenUsage } from '@/shared/types'
import type { MessagePageContext } from '@/shared/extension-ipc'
import { reasoningOfMessage, textOfMessage } from '@/lib/ui-message-parts'

/**
 * 落盘：UIMessage → Message。写侧唯一入口（offscreen）。
 *
 * @param ui  源头消息。user 路径 = 面板经 chat:start 带来的那条；
 *            assistant 路径 = 收尾时由 chunks 重建出的那条。两者形状同为 UIMessage。
 * @param ctx 存储侧补充信息（会话 id、时间、角色专有元数据）
 */
export function toPersistedMessage(
  ui: UIMessage,
  ctx: {
    conversationId: string
    /** 落盘 id：缺省取 ui.id；assistant 重建可能拿不到 id，由调用方给 task.messageId */
    id?: string
    /** 落盘时间：缺省取当前时刻（可注入，便于测试） */
    createdAt?: string
    /** 随本条消息附上的页面上下文（只有 user 路径会带） */
    pageContext?: MessagePageContext
    /** 本次生成消耗（只有 assistant 路径会带） */
    usage?: TokenUsage
  },
): Message {
  const base = {
    id: ctx.id || ui.id,
    conversationId: ctx.conversationId,
    // 深拷贝：Vue 响应式代理不能被 IndexedDB 结构化克隆（DataCloneError）
    parts: JSON.parse(JSON.stringify(ui.parts)) as UIMessage['parts'],
    createdAt: ctx.createdAt ?? new Date().toISOString(),
  }

  // 本扩展只落 user / assistant 两种角色（system prompt 走 buildSystemPrompt，不进消息数组）；
  // 万一收到 system 就按渲染层同款口径归一（非 user 即 assistant，见 ChatPanel.fromOf）。
  if (ui.role === 'user') {
    return {
      ...base,
      role: 'user',
      // 用户消息的 content 原样保留（不 trim、不加兜底文案）：正文就是用户输入本身
      content: textOfMessage(ui),
      ...(ctx.pageContext ? { pageContext: ctx.pageContext } : {}),
    }
  }

  const text = textOfMessage(ui)
  const reasoning = reasoningOfMessage(ui)
  return {
    ...base,
    role: 'assistant',
    // AI 正文可能整段为空（只调了工具）：落盘时给可见兜底，面板才不会出现空气泡
    content: text.trim() || '（模型未生成回复内容）',
    ...(reasoning.trim() ? { reasoning } : {}),
    ...(ctx.usage ? { usage: ctx.usage } : {}),
  }
}

/**
 * 回显：Message → UIMessage（读侧唯一入口，面板 activateConversation 用）。
 *
 * pageContext 元数据挂回 metadata：气泡 chip 与「最近一次拾取」prompt 注入都认它。
 * 注意这里**不**用 content 造 part 兜底：正文只认 parts（写入侧已保证必填），
 * 缺 parts 的历史记录按空渲染，不凭空造一份可能失真的正文。
 */
export function toUiMessage(m: Message): UIMessage {
  const metadata = m.role === 'user' && m.pageContext ? { pageContext: m.pageContext } : undefined
  return {
    id: m.id,
    role: m.role,
    // ?? [] 仅是防炸护栏：类型上 parts 必填，但库里可能躺着旧记录（parts 缺失），
    // 直接读 .parts 会让 textOfMessage 抛错、整个面板白屏 —— 空渲染比崩掉好。
    parts: m.parts ?? [],
    ...(metadata ? { metadata } : {}),
  }
}
