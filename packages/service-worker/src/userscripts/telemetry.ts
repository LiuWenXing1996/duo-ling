// 本扩展的遥测 port：把包内 GM 运行时的观测面接到本仓产品面
// （运行日志 / 错误落盘 / 页面监控 / 标签页录制 / 检查器结算）。
// 由 background 调 createServiceWorkerHost 时显式传入（见 entrypoints/background.ts）；
// 包内不自带观测面 —— 不注入 = 相应观测不发生，脚本行为不受损。
import type { UserscriptTelemetry } from '../host-config'
import * as runtime from './runtime-db'
import { notePageError, noteRunStart } from './page-monitor'
import { recordingTabSessionId } from './tab-sessions'
import { appendUserScriptError, recordRunEvent, recordRunStart } from './store'
import {
  FLOAT_HOST_ID,
  PAGE_ENV_ID,
  PAGE_SNAPSHOT_ID,
  PICK_ELEMENT_ID,
  TAB_RECORDER_ID,
} from '@duoling/user-scripts/builtin'

/** 系统脚本的 uuid 集：扩展自己的机制件不进用户脚本观测面（id 真相源在件包的 registry.ts） */
const SYSTEM_SCRIPT_UUIDS = new Set([
  TAB_RECORDER_ID,
  PICK_ELEMENT_ID,
  PAGE_SNAPSHOT_ID,
  PAGE_ENV_ID,
  FLOAT_HOST_ID,
])

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
  appendTabCapture: (rec) =>
    runtime.appendTabCapture(rec as Parameters<typeof runtime.appendTabCapture>[0]),
}
