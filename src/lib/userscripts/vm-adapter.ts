// VM 运行时 → duo-ling 侧栏数据源的适配器（Phase D）。
//
// 职责单一：把 VM 的「注入决策」翻译成 duo-ling 既有的运行监控信号。其它三类数据源
// （GM 值 / 菜单命令 / 通知）VM 内核原生接管，无需 duo-ling 介入——
//   · GM 值：VM 的 `values.js` 自管存储，GetInjected 内 `addValueOpener` 已注入读写通道；
//   · 菜单命令：VM 的 `page-menu-commands.js` 自管 contextMenu，GetInjected 内 `addMenuConfig` 已注入；
//   · 通知：VM 的 `notifications.js` 自管 chrome.notifications。
// 这三者对应的自研桥订阅（dl-port 的 store.watch / menu 注册 / 通知下行）随 P4·C 删除，
// 改由 VM 直接服务脚本，不再经 duo-ling 中转。
//
// 唯一需要 duo-ling 侧补的接入口是「运行日志」：自研引擎时期由 dl-bridge 的
// `__dlRunStart` 广播触发 `noteRunStart`，P4·C 删桥后该触发失活。VM 没有等价的「脚本
// 已启动」后台事件，但 GetInjected 的回包就是「该文档将注入哪些脚本」的权威决策——
// 用它驱动运行登记，语义等价（页面一加载就显示「这个文档会跑哪些脚本」），且天然随
// 导航清空（background 的 tabs.onUpdated loading → resetPageRuns）。

import { noteRunStart } from './page-monitor'

/** GetInjected 回包里脚本数组的键名（VM 内部常量 SCRIPTS === 'scripts'） */
const SCRIPTS_KEY = 'scripts'

/** 运行序号：仅用于给每次注入一个稳定可区分的 runId（错误关联用，VM 不回传运行期错误，故不严格） */
let runSeq = 0

/**
 * 从 VM 的 GetInjected 回包提取脚本 uuid，逐个登记一次运行。
 *
 * @param tabId   发起 GetInjected 的标签页（即脚本将要注入的文档所在 tab）
 * @param payload VM 注入件回包的纯对象形态（已 JSON 序列化，无 VM proxy 干扰）
 *
 * 不抛错：payload 形状异常（非对象 / 无 scripts 数组 / 脚本缺 uuid）一律静默跳过，
 * 不影响注入链路本身。
 */
export function emitRunsFromGetInjected(
  tabId: number,
  payload: unknown,
): void {
  if (typeof tabId !== 'number' || !Number.isFinite(tabId)) return
  const inject = payload as { [SCRIPTS_KEY]?: unknown } | null
  const scripts = inject?.[SCRIPTS_KEY]
  if (!Array.isArray(scripts)) return
  for (const s of scripts) {
    const uuid = (s as { props?: { uuid?: string } }).props?.uuid
    if (typeof uuid !== 'string' || !uuid) continue
    runSeq += 1
    // runId 用序号+tab 区分；noteRunStart 按 uuid 去重覆盖，重复注入只刷新为最新一次
    noteRunStart(tabId, uuid, `vm-${runSeq}`)
  }
}
