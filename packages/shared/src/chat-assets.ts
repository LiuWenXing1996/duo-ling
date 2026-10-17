// 对话资源引用（`data-asset` part）的**唯一形状定义** + 三个消费点的读法（纯数据 + 纯函数）。
// 为什么不用 file part、三消费点口径见 docs/adr/0019-chat-asset-reference-shape.md。
import type { UIMessage } from 'ai'
import type { ChatAssetRef } from './service/offscreen-service'

/** 消息里表达「带了一份资源」的 part */
export interface ChatAssetPart {
  type: 'data-asset'
  data: ChatAssetRef
}

/** 判一个 part 是不是资源引用（运行时形状校验 + 类型收窄；库里可能躺着别的 data-* part） */
export function isAssetPart(part: { type: string }): part is ChatAssetPart {
  if (part.type !== 'data-asset') return false
  const data = (part as { data?: unknown }).data as ChatAssetRef | undefined
  return typeof data?.id === 'string' && data.id.length > 0
}

/** 引用 → 消息 part（面板发送时唯一一处拼法；offscreen 侧会把它换回一行文字，见 assetPlaceholderText） */
export function assetPartOf(ref: ChatAssetRef): ChatAssetPart {
  return { type: 'data-asset', data: ref }
}

/** 一条消息里的全部资源引用（面板渲染、删会话时的引用面统计都认它） */
export function assetsOfMessage(m: UIMessage): ChatAssetRef[] {
  return m.parts.filter(isAssetPart).map((p) => p.data)
}

/**
 * 资源引用送给模型时的文字形态。
 *
 * 这一行是主 Agent **唯一**能看到的关于这张图的信息 —— 所以必须把 assetId 写进去、
 * 并明说「内容不在消息里、要看图得调 image_ask」。缺了这句，模型会假装自己看过了。
 */
export function assetPlaceholderText(ref: ChatAssetRef): string {
  return `【图片 #${ref.id}：${ref.filename}（内容未随消息发送，要看图请调 image_ask，assetId 传 ${ref.id}）】`
}

/**
 * 送模型前把消息收成「模型该看到的样子」——两件事：
 *   ① `data-asset`（图片资源引用）**换成一行文字**（assetPlaceholderText）：消息里本就没有图片字节，
 *      模型拿到的是 assetId + 「要看图请调 image_ask」。这一步是「模型不被图片刷屏、也不会假装看过图」
 *      的落点：它想知道图里有什么，只能真的去调工具。
 *   ② 其余 `data-*`（data-generation / data-usage / data-tab-record 这类）整条丢掉：纯 UI 用，不进上下文。
 *
 * 为什么不在这里把图片读出来当图发：那等于绕开 image_ask 把图片塞回每一轮请求 ——
 * 前面省的 token 全吐回去。
 */
export function messagesForModel(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    const parts: UIMessage['parts'] = []
    for (const p of m.parts) {
      if (isAssetPart(p)) {
        parts.push({ type: 'text', text: assetPlaceholderText(p.data) })
        continue
      }
      if (p.type.startsWith('data-')) continue
      parts.push(p)
    }
    return { ...m, parts }
  })
}
