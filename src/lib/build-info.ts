/**
 * 构建信息（诊断）：回答「浏览器里跑的是哪次构建 / 哪次 dev 会话」。
 *
 * 唯一来源 = vite.define 注入的裸标识符 `__BUILD_INFO__`（见 wxt.config.ts），编译进所有 JS
 * bundle（页面 / SW / offscreen 三处同源）。不走 HTML 内联注入（`window.__BUILD_INFO__`）
 * ——它撞 MV3 extension_pages CSP（不含 `'unsafe-inline'`），生产环境拿不到值。
 *
 * dev / build 语义不同（wxt.config.ts 定义）：
 *   - dev：define 在 dev server 启动时算一次 → 显示「本次 dev 会话的启动时刻」
 *   - build：构建期定格 → 显示「产物构建时刻」
 *
 * SW 不是 HTML、页面读不到它 bundle 里的值，经 `sw:buildInfo` 命令取回（IPC 契约见
 * src/shared/extension-ipc.ts）。发消息本身会唤醒休眠的 SW，故拿到的总是「此刻 SW 上下文」的
 * 构建信息——MV3 SW console 不回放历史日志（启动日志在开 DevTools 前就打完了），这条通道才是
 * 可靠的自证方式。
 */

import { readInjectedBuildInfo, type InjectedBuildInfo } from '@duoling/shared'
import { ipcRequest } from '@/shared/ipc-bus'

// 注入结构的形状与「读全局」那一半已归 @duoling/shared：offscreen 的环境快照直接消费它，
// 而进程包不能引应用源码。本文件保留展示格式化与 `sw:buildInfo` 命令面（那两条要总线）。
export { readInjectedBuildInfo }
export type { InjectedBuildInfo }

/** 展示用的构建标记：分支 + 已格式化的时间 */
export interface BuildStamp {
  branch: string
  /** `MM-DD HH:mm:ss`（本地时区） */
  time: string
}

/** ISO 时间 → `MM-DD HH:mm:ss`（本地时区） */
export function fmtBuildTime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 页面侧构建标记（define 注入，缺失时为 null） */
export function readPageBuildStamp(): BuildStamp | null {
  const info = readInjectedBuildInfo()
  return info ? { branch: info.branch, time: fmtBuildTime(info.time) } : null
}

/** 单次 `sw:buildInfo` 请求：成功 resolve，失败 reject（信封解包与 lastError 收拢都在总线） */
function requestSwBuildInfo(): Promise<{ time: string; branch: string }> {
  return ipcRequest<{ time: string; branch: string }>({ kind: 'sw:buildInfo' })
}

/**
 * 取 SW 侧构建标记，失败重试（默认 3 次 × 800ms）。
 * 重试而非一次定生死：WXT 重载扩展时工作台页面跟着重载，挂载瞬间的第一条请求常撞上
 * 「旧 SW 已死、新 SW 监听器未注册完」的窗口。三次都失败才算真失败——浏览器里的 SW 是旧包
 * （没有该命令）或已挂。
 *
 * @returns 成功返回标记；重试耗尽仍无应答返回 null
 *          （调用方应显式展示「未响应」，别静默隐藏——看不见就无法区分「正常」和「坏了」）
 */
export async function fetchSwBuildStamp(attempts = 3, delayMs = 800): Promise<BuildStamp | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const data = await requestSwBuildInfo()
      return { branch: data.branch, time: fmtBuildTime(data.time) }
    } catch {
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  return null
}
