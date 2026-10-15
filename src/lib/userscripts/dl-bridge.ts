// GM 后台桥已上移进 `@duoling/userscript-runtime`（dl-bridge.ts）；本文件只剩两件事：
//   ① 注入本扩展的宿主配置（遥测 / offscreen / 身份）—— 包内不自带观测面与 offscreen 后端，
//     运行日志（duoling-runtime 库）、页面监控、检查器结算、剪贴板就绪探测都是本扩展的产品面；
//   ② re-export 维持既有 import 路径不变（background.ts 的 initDlBridge 等）。
// 注入必须在 initDlBridge / initDlPort 之前生效：本模块在 background 顶层被 import，
// 模块加载即执行 configure —— 时序天然满足「SW 顶层同步段」纪律。
import {
  configureUserscriptRuntime,
  type UserscriptTelemetry,
} from '@duoling/userscript-runtime'
import { EXTENSION_NAME } from '@/lib/extension-identity'
import { ensureOffscreenReady } from '@/lib/offscreen'
import { handleInspectorResult } from './page-inspector-bridge'
import * as runtime from './runtime-db'
import { notePageError, noteRunStart } from './page-monitor'
import { recordingTabSessionId } from './tab-sessions'
import { appendUserScriptError, recordRunEvent, recordRunStart } from './store'

const telemetry: UserscriptTelemetry = {
  recordingTabSessionId,
  recordRunStart,
  recordRunEvent,
  appendError: appendUserScriptError,
  noteRunStart,
  notePageError,
  appendTabCapture: (rec) => runtime.appendTabCapture(rec as Parameters<typeof runtime.appendTabCapture>[0]),
  onInspectorResult: handleInspectorResult,
}

configureUserscriptRuntime({
  extensionName: EXTENSION_NAME,
  notificationIcon: 'icons/128.png',
  offscreen: { ensureReady: ensureOffscreenReady },
  telemetry,
})

export * from '@duoling/userscript-runtime'
