// 宿主层注入点：应用耦合收敛成可配置的 port。
//
// 宿主层（dl-bridge / dl-port / cookie-gate）有三类事包内给不了默认实现或不应擅自决定：
//   · 扩展身份 —— 通知标题、兜底图标是扩展的品牌面；
//   · offscreen 后端 —— 剪贴板写入要经 offscreen 文档；文档由扩展自建（包不碰生命周期），
//     就绪握手协议各扩展自定，故就绪探测注入；
//   · 遥测与观测 —— 运行日志 / 错误落盘 / 页面监控是宿主的产品面（本仓的 duoling-runtime
//     库 + 活动历史面板），包不自带；不注入 = 相应观测不发生，脚本行为不受损。
//
// 配置时机：必须在 initDlBridge / initDlPort 之前调 configureUserscriptRuntime
// （SW 入口的顶层同步段里，与 listener 注册同一条「第一帧」纪律）。

// 错误 / 动作的形状归契约包（件包产生、应用侧落库与展示、offscreen 的工具集也认），
// 此处 re-export 维持包内与包外的既有 import 路径不变。
import type { ScriptProject, UserscriptErrorRecord, UserscriptRunEvent } from '@duoling/shared'
export type { UserscriptErrorRecord, UserscriptRunEvent }

/**
 * 遥测 port（全部可选；不注入的钩子 = 该观测不发生）。
 * 各钩子的语义见宿主侧同名函数（store.ts / page-monitor.ts / tab-sessions.ts / runtime-db.ts）。
 */
export interface UserscriptTelemetry {
  /** 该 tab 此刻是否开着活动记录（开着才有号返回）；无号 = 观测盲区，运行/错误都不记 */
  recordingTabSessionId?(tabId: number): Promise<string | undefined>
  /** 登记一次运行开始（无 tabSessionId 的 extra 由宿主自行短路） */
  recordRunStart?(
    uuid: string,
    runId: string,
    name?: string,
    extra?: { url?: string; savedAt?: number; tabSessionId?: string },
  ): Promise<void>
  /** 追加一条运行动作 */
  recordRunEvent?(uuid: string, runId: string, event: UserscriptRunEvent): Promise<void>
  /** 追加一条错误记录 */
  appendError?(rec: UserscriptErrorRecord): Promise<void>
  /** 运行广播（实时通道：按 tab 登记运行集，浮层快照用） */
  noteRunStart?(tabId: number, uuid: string, runId: string): void
  /** 运行期错误实时推送 */
  notePageError?(
    tabId: number,
    info: { uuid: string | null; name: string; message: string; runId: string | null },
  ): void
  /** 标签页录制载荷落库 */
  appendTabCapture?(rec: unknown): Promise<void>
  /**
   * 页面检查器指令结果结算（检查器系统脚本经 __dlEvent 信封上行）。
   * 旁证（uuid 必须是检查器系统脚本自己的）与页归属（tabId）都由宿主侧定；
   * reqId 由 SW 现造随指令下发，结算认它（幂等，重复投递无害）。
   */
  onInspectorEvent?(
    uuid: string,
    tabId: number | null,
    rec: { reqId: string; ok: boolean; payload: unknown },
  ): void
  /**
   * 浮层宿主的在岗应答结算（宿主系统脚本经 __dlEvent 信封上行）。与 onInspectorEvent 同款：
   * 旁证（uuid）与页归属（tabId）由宿主侧定，结算认 SW 现造的 reqId（幂等）。
   */
  onFloatEvent?(uuid: string, tabId: number | null, rec: { reqId: string }): void
}

/** 宿主配置（全部可选） */
export interface UserscriptHostConfig {
  /** 扩展显示名：GM_notification 兜底标题用（`<extensionName>用户脚本`） */
  extensionName?: string
  /** GM_notification 的兜底图标（扩展内相对路径；MV3 不接受 data: URL 图标） */
  notificationIcon?: string
  /** offscreen 就绪探测（剪贴板写入前调用）；不注入 = 剪贴板命令报 NOT_AVAILABLE */
  offscreen?: { ensureReady(): Promise<boolean> }
  /** 遥测 port；不注入 = 无运行日志 / 错误落盘 / 页面监控，脚本行为不受损 */
  telemetry?: UserscriptTelemetry
  /**
   * 握手密钥的持久化存储（推荐注入）：不注入 = 密钥只在 SW 存活期内有效，
   * SW 重启换钥后要等下一遍全量重注册中继件与脚本才重新对上。
   */
  secretStore?: {
    get(key: string): Promise<string | undefined>
    set(key: string, value: string): Promise<void>
  }
  /**
   * 宿主内置件（中继件 / 检查器 / 浮层 / 录制件等注册件）：
   * registerAllEnabled 在重注册脚本前先调 syncAll（内置件跟随启用脚本的匹配并集 / 门禁走），
   * stale 清扫排除 ids 里的注册。不注入 = 包只管脚本本身的注册与清扫。
   */
  builtins?: {
    /** 内置注册 id 全集（stale 清扫排除面；也是旧 id 的自动回收面 —— 不在名单即被清） */
    ids: string[]
    /** 全量同步（幂等可重入；调用方已串行化，实现内不必再加锁） */
    syncAll(projects: ScriptProject[]): Promise<void>
  }
}

const DEFAULT_EXTENSION_NAME = 'UserScripts'
const DEFAULT_NOTIFICATION_ICON = 'icons/128.png'

let config: UserscriptHostConfig = {}

/** 注入宿主配置（SW 顶层同步段调用，先于 initDlBridge / initDlPort） */
export function configureUserscriptRuntime(c: UserscriptHostConfig): void {
  config = c
}

/** 测试与显式复位用：清空配置（恢复全默认 / 全无 port） */
export function resetUserscriptRuntimeConfig(): void {
  config = {}
}

/** 读扩展显示名（含默认值兜底） */
export function extensionName(): string {
  return config.extensionName ?? DEFAULT_EXTENSION_NAME
}

/** 读通知兜底图标 */
export function notificationIcon(): string {
  return config.notificationIcon ?? DEFAULT_NOTIFICATION_ICON
}

/** 读 offscreen port（未注入为 undefined） */
export function offscreenPort(): UserscriptHostConfig['offscreen'] {
  return config.offscreen
}

/** 读遥测 port（未注入为 undefined） */
export function telemetryPort(): UserscriptTelemetry | undefined {
  return config.telemetry
}

/** 读密钥持久化存储（未注入为 undefined） */
export function secretStorePort(): UserscriptHostConfig['secretStore'] {
  return config.secretStore
}

/** 读内置件注入（未注入为 undefined） */
export function builtinsPort(): UserscriptHostConfig['builtins'] {
  return config.builtins
}
