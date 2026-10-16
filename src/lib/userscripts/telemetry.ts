// 本扩展的遥测 port：把包内 GM 运行时的观测面接到本仓产品面
// （运行日志 / 错误落盘 / 页面监控 / 标签页录制 / 检查器结算）。
// 由 background 调 createServiceWorkerHost 时显式传入（见 entrypoints/background.ts）；
// 包内不自带观测面 —— 不注入 = 相应观测不发生，脚本行为不受损。
import type { UserscriptTelemetry } from '@duoling/userscript-sw'
import * as runtime from './runtime-db'
import { notePageError, noteRunStart } from './page-monitor'
import { recordingTabSessionId } from './tab-sessions'
import { handleInspectorEvent } from './page-inspector-bridge'
import { handleFloatEvent } from './float-bridge'
import { appendUserScriptError, recordRunEvent, recordRunStart } from './store'
import { FLOAT_HOST_ID, INSPECTOR_HOST_ID, TAB_RECORDER_ID } from '@duoling/builtin-scripts'

/**
 * 系统脚本的 uuid 集。三件都走统一 registerScript 链注入（带 GM 包装，注入即广播 runstart），
 * 但它们是扩展自己的机制件，**不该进用户脚本观测面**：角标 / 灵动岛 / popup 的「该页命中脚本数」
 * 与活动历史的运行条都不计它们：注入即广播 runstart，叠加检查器 / 浮层宿主全站匹配，
 * 不过滤的话普通网页的角标会凭空 +2。
 *
 * 过滤在遥测接线这一处做（四个口一起拦）：包内 dl-bridge 不知道「谁是系统脚本」—— 那是
 * 应用侧的概念（id 真相源在 @duoling/builtin-scripts 的 registry.ts）；而观测的消费面
 * （page-monitor / store）也不该各自维护一份黑名单。
 *
 * 检查器 / 浮层的**结果结算**（onInspectorEvent / onFloatEvent）与录制载荷（appendTabCapture）
 * 是系统脚本自己的产品通道，不在此列。
 */
const SYSTEM_SCRIPT_UUIDS = new Set([TAB_RECORDER_ID, INSPECTOR_HOST_ID, FLOAT_HOST_ID])

export const duolingTelemetry: UserscriptTelemetry = {
  recordingTabSessionId,
  recordRunStart: (uuid, ...rest) =>
    SYSTEM_SCRIPT_UUIDS.has(uuid) ? Promise.resolve() : recordRunStart(uuid, ...rest),
  recordRunEvent: (uuid, ...rest) =>
    SYSTEM_SCRIPT_UUIDS.has(uuid) ? Promise.resolve() : recordRunEvent(uuid, ...rest),
  appendError: (rec) =>
    rec.uuid != null && SYSTEM_SCRIPT_UUIDS.has(rec.uuid)
      ? Promise.resolve()
      : appendUserScriptError(rec as Parameters<typeof appendUserScriptError>[0]),
  noteRunStart: (tabId, uuid, runId) => {
    if (SYSTEM_SCRIPT_UUIDS.has(uuid)) return
    noteRunStart(tabId, uuid, runId)
  },
  notePageError: (tabId, info) => {
    if (info.uuid != null && SYSTEM_SCRIPT_UUIDS.has(info.uuid)) return
    notePageError(tabId, info)
  },
  appendTabCapture: (rec) => runtime.appendTabCapture(rec as Parameters<typeof runtime.appendTabCapture>[0]),
  onInspectorEvent: handleInspectorEvent,
  onFloatEvent: handleFloatEvent,
}
