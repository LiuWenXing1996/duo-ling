// 文件库的定位：源码与对话资源的**唯一权威落点**，由 offscreen 独占读写（lfs 单实例约束，
// 见 fs/lfs 文件头）。契约（IOffscreenService）在 @duoling/shared；本包既出实现
// 实体（OffscreenService），也出 fs 层原语 —— offscreen 内的直读消费方（识图 / 脚本工具 /
// 资源回收）不想过桥时直接用它们。
export { OffscreenService } from './offscreen-service'

export { offscreenLink, startOffscreenLink, stopOffscreenLink } from './link-host'
// 启动对账（清孤儿仓）：宿主入口顶层调一次，不是跨上下文能力，故不进服务
export { reconcileFs } from './userstate/reconcile'

export { startOffscreenHost } from './bootstrap'

// —— fs 层原语（offscreen 内部直用；对外读写走 OffscreenService） ——
// base64 编解码与名字安全化在 @duoling/shared（下载侧同源，见其 archive-transfer）
export { readLfsFile, readLfsTree } from './fs/lfs'
export {
  commitSource,
  deleteAllRepos,
  deleteRepo,
  ensureRepo,
  listHistory,
  listRepoDirs,
  readSnapshotAt,
  readSource,
  restoreToCommit,
  writeSource,
} from './fs/git'
export { deleteAllAssets, deleteAssets, putAsset, readAsset } from './fs/assets'
export { buildScriptZip, parseScriptsZip, sourceFingerprint } from './fs/zip'

// —— 对话编排（agent loop / 工具集 / 环境快照 / 任务快照 / 事件缓冲）——
// 整条链路只在本进程跑：面板经命令面驱动，SW 只旁听收尾信号。
export { abortChat, listOrphans, resolveOrphan, resumeChat, startChat } from './chat/chat-host'
export type { ChatStartInput } from './chat/chat-host'
export { assetIdsOf, releaseAllAssets, releaseUnreferencedAssets } from './chat/asset-lifecycle'
export {
  clearAllConversationsWithAssets,
  deleteConversationWithAssets,
} from './chat/conversation-delete'
export { refreshActiveProfile } from './chat/profile-cache'

export type { AssetContent, AssetWriteInput } from './fs/assets'
export type { ParsedIgnored, ParsedScript, ScriptsZipParse, ZipScriptPayload } from './fs/zip'
