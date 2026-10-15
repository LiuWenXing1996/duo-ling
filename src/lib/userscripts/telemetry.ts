// 本扩展的遥测 port：把包内 GM 运行时的观测面接到本仓产品面
// （运行日志 / 错误落盘 / 页面监控 / 标签页录制 / 检查器结算）。
// 由 background 调 createServiceWorkerHost 时显式传入（见 entrypoints/background.ts）；
// 包内不自带观测面 —— 不注入 = 相应观测不发生，脚本行为不受损。
import type { UserscriptTelemetry } from '@duoling/userscript-runtime'
import * as runtime from './runtime-db'
import { notePageError, noteRunStart } from './page-monitor'
import { recordingTabSessionId } from './tab-sessions'
import { handleInspectorEvent } from './page-inspector-bridge'
import { appendUserScriptError, recordRunEvent, recordRunStart } from './store'

export const duolingTelemetry: UserscriptTelemetry = {
  recordingTabSessionId,
  recordRunStart,
  recordRunEvent,
  appendError: appendUserScriptError,
  noteRunStart,
  notePageError,
  appendTabCapture: (rec) => runtime.appendTabCapture(rec as Parameters<typeof runtime.appendTabCapture>[0]),
  onInspectorEvent: handleInspectorEvent,
}
