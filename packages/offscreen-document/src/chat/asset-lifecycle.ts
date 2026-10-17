// 对话资源的**回收**：会话删掉之后，把它独占的那些图片从 /assets 里也删掉（offscreen-only）。
// 先删会话再算引用面的时序与失败语义见 docs/adr/0022-asset-lifecycle-delete-order.md。
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
