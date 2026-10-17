// 数据变更广播：转发 @duoling/shared 的唯一实现。
//
// 契约（频道 / 合并窗口 / 推送形状）在 shared 的 data-broadcast.ts，实现体
// （BroadcastChannel 优先、sendMessage 降级、合并节流、瞬态阶段广播）在同包的
// data-broadcast-runtime.ts —— 本文件只维持既有 import 路径不变。
export { broadcastDataChange, broadcastBuildPhase, subscribeDataChange } from '@duoling/shared'
