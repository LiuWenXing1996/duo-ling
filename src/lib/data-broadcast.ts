// 数据变更广播：转发 @duoling/userscript-core 的唯一实现（原实现已随运行时三拆上移包内）。
//
// 频道 / 合并窗口 / 推送形状的真相源在 @duoling/shared（data-broadcast.ts）；实现体
// （BroadcastChannel 优先、sendMessage 降级、合并节流、瞬态阶段广播）在
// @duoling/userscript-core 的 data-broadcast.ts —— 本文件只维持既有 import 路径不变。
export {
  broadcastDataChange,
  broadcastBuildPhase,
  subscribeDataChange,
} from '@duoling/userscript-core'
