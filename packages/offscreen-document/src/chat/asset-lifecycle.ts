// 对话资源的**回收**：会话删掉之后，把它独占的那些图片从 /assets 里也删掉。
//
// 为什么需要单独一处：图片按**内容 hash** 存（同一张图重复附加只落一份），所以「该不该删」
// 不能按「谁带过它」判断 —— 必须是「删完之后全库还剩谁在引用它」。判据只有引用面一处
// （conversation-store.referencedAssetIds），删除只有资源库一处，这里只负责把两者接起来。
//
// 时序也是刻意的：**先删会话、再算引用面**。反过来（先算再删）会把「只有这条会话引用的图」
// 与「别的会话也在引用的图」混在一起，得多维护一份引用计数表 —— 而计数表是典型会漂的东西。
//
// 回收失败不让删会话报错：会话已经删掉了（用户要的结果已达成），一张留下的图片是垃圾，
// 不是错误；下次删会话时它若仍无人引用会被再收一遍。
//
// 归属：offscreen-only（要读 lfs）。
import {
  isAssetPart,
  listMessages,
  referencedAssetIds,
} from '@duoling/shared'
import { deleteAllAssets, deleteAssets } from '../fs/assets'

/** 一条会话用到过的资源 id（删会话**之前**取，因为删完就再也读不到这些消息了） */
export async function assetIdsOf(conversationId: string): Promise<string[]> {
  const messages = await listMessages(conversationId)
  const ids = new Set<string>()
  for (const m of messages) {
    for (const p of m.parts ?? []) {
      if (isAssetPart(p)) ids.add(p.data.id)
    }
  }
  return [...ids]
}

/**
 * 回收不再被任何消息引用的资源（候选来自 assetIdsOf）。
 * 返回真正删掉的份数，供调用方记录 / 测试断言。
 */
export async function releaseUnreferencedAssets(candidates: string[]): Promise<number> {
  if (!candidates.length) return 0
  const stillReferenced = await referencedAssetIds()
  const orphans = candidates.filter((id) => !stillReferenced.has(id))
  return deleteAssets(orphans)
}

/** 清空整个资源库（「清空全部会话」时用；此时引用面必然为空） */
export async function releaseAllAssets(): Promise<number> {
  return deleteAllAssets()
}
