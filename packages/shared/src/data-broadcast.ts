// 数据变更广播的跨世界契约：频道名、合并窗口、推送形状。
//
// 为什么归本包：IDB 没有变更通知，写侧落盘后经此通知别处回拉 —— 广播只带
// 「哪个域的哪条变了」，不带数据。频道与推送形状被两侧同取：
//   · 应用侧（src/lib/data-broadcast.ts：SW / offscreen / 扩展页，多一个瞬态阶段广播）；
//   · 运行时包（@duoling/service-worker 的 dl-bridge / cookie-gate）。
// 同一扩展内互通是硬要求，形状放在任何一侧，另一侧都只能靠注释对齐 —— 故上移这里
// （BroadcastChannel 是 web 标准，零 chrome.*、零 DOM 假设，符合本包边界）。
//
// 实现体不在这里：两侧各留一份（收发实例与降级路径不同），本文件只锁住
// 「两端必须逐字节一致」的常量与形状。

/** 广播频道名（同一扩展内唯一即可；跨扩展不会串，因为 origin 含扩展 id） */
export const DATA_BROADCAST_CHANNEL = 'duoling:data'

/** 合并窗口（ms）：窗口内同一「域 + uuid」的多次变更只发一条补发（防写侧风暴） */
export const DATA_MERGE_WINDOW_MS = 100

/** 保存链的瞬态阶段（前端列表据此显示「保存中」转圈；保存即注入，无构建阶段） */
export type BuildPhase = 'saving'

/** 数据域（与持久化分区一一对应） */
export type DataDomain =
  /** 项目状态库：源码 / 配置 / 构建产物 / enabled */
  | 'script'
  /** 会话与消息（duoling-chat） */
  | 'conversation'
  /** 模型配置（duoling-app 库） */
  | 'model'
  /** 用户脚本错误记录（runtime 库 tab_events，kind = 'error'） */
  | 'error'
  /** 运行观测（运行条目 / 动作）变了 —— 活动历史与 AI 的运行面据此回拉 */
  | 'runlog'
  /**
   * 标签页活动记录（runtime 库）：存续行的增减与整根轴上的新行 —— 活动历史据此回拉。
   *
   * `uuid` 承载**这是哪一页**：带上它 = 只有这一页的轴长了新行（读侧正在看就增量续拉）；
   * 缺省 = 结构性变化（建行 / 关页 / 开关记录 / 划断对账 / 删除清空），读侧一律全量重拉 ——
   * 这种情况下整根轴上的行可能整批消失，增量游标会指向一个已经不存在的轴。
   */
  | 'tabActivity'
  /** 脚本列表分组定义（duoling-state 的 groups 对象库） */
  | 'group'

/**
 * 一次落盘的变更通知：**只带「哪个域的哪条变了」，不带数据本身**。
 * 接收方自己去权威存储回拉——读侧仍是直连 IDB，不新增数据通道，也就没有第二份真相。
 *
 * `uuid` 缺省 = 该域整体起了变化（新建 / 删除 / 批量改动），接收方一律全量重拉；
 * 有值时接收方可自行判断「是不是我正在看的那条」，从而跳过无关重拉。
 *
 * `phase` = 保存链的**瞬态**阶段通知（不落库、不回拉）：script 域统一保存链上，
 * SW 收到 `userscript:save` 即广播 `saving`，链路收尾仍是常规的落库广播（无 phase）
 * ——接收方据此切终态、清瞬态。
 */
export type DataChangedPush = {
  kind: 'data:changed'
  domain: DataDomain
  uuid?: string
  /** 发送时刻（ms） */
  at: number
  /** 瞬态阶段（仅保存链中途广播）；缺省 = 落库完成的终态通知 */
  phase?: BuildPhase
}
