// 宿主层注入点：应用耦合收敛成可配置的 port。
//
//   · 扩展身份 —— 通知标题、兜底图标是扩展的品牌面；
//   · offscreen 后端 —— 剪贴板写入要经 offscreen 文档；文档由扩展自建（包不碰生命周期），
//     就绪握手协议各扩展自定，故就绪探测注入；
//
// 配置时机：必须在 initDlBridge / initDlPort 之前调 configureUserscriptRuntime
// （SW 入口的顶层同步段里，与 listener 注册同一条「第一帧」纪律）。

import type { ScriptProject } from '@duoling/shared'
import type { DLRuntime } from '@duoling/dl-core'

/** 宿主配置（全部可选） */
export interface UserscriptHostConfig {
  /** 扩展显示名：GM_notification 兜底标题用（`<extensionName>用户脚本`） */
  extensionName?: string
  /** GM_notification 的兜底图标（扩展内相对路径；MV3 不接受 data: URL 图标） */
  notificationIcon?: string
  /** offscreen 就绪探测（剪贴板写入前调用）；不注入 = 剪贴板命令报 NOT_AVAILABLE */
  offscreen?: { ensureReady(): Promise<boolean> }
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
  dlRuntime?: DLRuntime
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

/** 读密钥持久化存储（未注入为 undefined） */
export function secretStorePort(): UserscriptHostConfig['secretStore'] {
  return config.secretStore
}

/** 读内置件注入（未注入为 undefined） */
export function builtinsPort(): UserscriptHostConfig['builtins'] {
  return config.builtins
}

export function dlRuntimePort(): DLRuntime | undefined {
  return config.dlRuntime
}
