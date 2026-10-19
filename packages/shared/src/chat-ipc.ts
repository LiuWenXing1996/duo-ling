// 对话链路的载荷形状：页面上下文、消息元数据、重连 / 孤儿任务、offscreen 推送。
//
// 为什么在契约包：这些形状两侧都认 —— offscreen 产（聊天编排在进程包里）、
// SW 与扩展页消费（面板渲染、状态横幅、重连回放）。放任一侧都要另一侧反向依赖。

import type { UIMessageChunk } from 'ai'
import type { ElementPickContext, MessagePageContext, PageSnapshotContext } from './page-context'

/** chat:start 的页面上下文：档 0（URL/标题）+ 可选的档 2 元素拾取 / 页面快照 */
export interface PageContextInfo {
  url?: string
  title?: string
  element?: ElementPickContext
  snapshot?: PageSnapshotContext
}

/** UIMessage.metadata 的约定形状（AI SDK 的 metadata 字段是 unknown，此处是全应用唯一合法形状） */
export interface ChatMessageMetadata {
  pageContext?: MessagePageContext
  /**
   * 气泡下方展示的消息时间（ISO 8601）。
   *
   * 存在的理由：UIMessage 本身没有时间字段，而落盘时间（Message.createdAt）只活在会话库里 —
   * 面板不读库、也拿不到 offscreen 落盘的那一刻，本地视图（刚发出 / 刚回完）需要有个地方放时间。
   * 历史消息由 toUiMessage 从库里带上，实时消息由面板在发出 / 收尾时就地取（见 conversation-message）。
   */
  createdAt?: string
}

/** 对话重连的应答：idle = 无进行中任务（调用方以会话历史为准即可） */
export type ChatResumeResult =
  | { status: 'idle' }
  | {
      status: 'running'
      taskId: string
      /** 该任务缓冲的完整事件序列（按 seq 升序），连同后续 chat:chunk 推送一起消费 */
      events: Array<{ seq: number; chunk: UIMessageChunk }>
    }

/** 孤儿任务的条目：宿主被杀后遗留的进行中任务（心跳过期） */
export interface ChatOrphanRecord {
  taskId: string
  conversationId: string
  /** 中断时的循环步数（提示「中断在第 N 步」用） */
  step: number
  /** 最后心跳（ms 时间戳），供 UI 展示中断发生时间 */
  heartbeat: number
}

/**
 * offscreen 侧的推送面（单向，无应答方）。
 *
 * chat:chunk —— 流式事件（观察者按 seq 去重；无人接收是常态，尽力而为）
 * chat:running / chat:finished —— 进行中登记表的进与出（SW 旁听，驱动徽标）
 * offscreen:configChanged —— 配置变更，容器回拉
 */
export type OffscreenPush =
  | { kind: 'offscreen:configChanged' }
  | { kind: 'chat:chunk'; conversationId: string; seq: number; chunk: UIMessageChunk }
  | { kind: 'chat:running'; conversationId: string }
  | {
      kind: 'chat:finished'
      conversationId: string
      /** true = 正常收敛；false = 停止 / 异常 */ ok: boolean
    }
