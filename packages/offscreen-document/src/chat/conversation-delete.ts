// 删会话 + 连带回收它独占的图片。会话写侧与资源库分处两层，靠这里接起来。
//
// 候选要在删之前取：删完就读不到这些消息了。回收放在删之后 —— 那时引用面才是
// 「删完的真相」。回收失败不报错：会话已经删掉（用户要的结果已达成），留下的图算垃圾，
// 下次删会话时仍无人引用会被再收一遍。
//
// 归属：offscreen-only（要读 lfs）。
import { deleteAllConversations, deleteConversation } from '@duoling/shared'
import { assetIdsOf, releaseAllAssets, releaseUnreferencedAssets } from './asset-lifecycle'

/** 删一条会话，并回收只有它引用的资源 */
export async function deleteConversationWithAssets(conversationId: string): Promise<void> {
  const candidates = await assetIdsOf(conversationId)
  await deleteConversation(conversationId)
  await releaseUnreferencedAssets(candidates).catch(() => {})
}

/** 清空全部会话，整库清资源（此时引用面必然为空） */
export async function clearAllConversationsWithAssets(): Promise<void> {
  await deleteAllConversations()
  await releaseAllAssets().catch(() => {})
}
