// 标签页录制 · MAIN 世界件（机制层框架）。
//
// 为什么必须 MAIN：要拦页面**自己**发出的请求，钩子只能挂在页面世界 ——
// USER_SCRIPT 世界是独立 realm，挂它的 window.fetch 拦不到。
//
// 本件只管**通道**，不管「录什么」：
//   · 信封形状（TAB_RECORD_TAG + kind + record）、出口 emit、幂等守卫、postMessage 目标；
//   · 各类信号的具体采法在**种类件**里（当前：net-probe.ts 的网络请求），
//     由本件逐个 install —— 加一类就是多一个 install 调用，不改本件。
// 这样命名与职责才对得上：本件叫 `tab-record`（按页录制的框架），不叫 `net-*`。
//
// 设计硬边界：
//   - 无 chrome.*（MAIN 世界本就没有），采集后只靠同帧 window.postMessage 交给转发件；
//   - 与页面同级、无特权：页面看得见它做的一切；
//   - **不阻塞页面网络层**：这一条由种类件负责（本件只提供通道，不做任何采样）。
//
// 本件没有运行期参数，故注册时只需一个 IIFE 文件（无装配段）。

import { TAB_RECORD_TAG } from '../protocol/tab-record'
import type { RecorderCtx } from './context'
import { installNetProbe } from './net-probe'

declare global {
  interface Window {
    /** 幂等守卫：同一 realm 里被注入两次也只包一层（防重复注册 / 导航竞态） */
    __dlTabRecorder?: boolean
  }
}

export function installTabRecorder(): void {
  if (window.__dlTabRecorder) return
  window.__dlTabRecorder = true

  function origin(): string {
    try {
      return window.location.origin || '*'
    } catch {
      return '*'
    }
  }

  /**
   * 种类件唯一的出口。信封三件套（TAG / kind / record）形状只在这里定，
   * 种类件不必知道 TAG 叫什么、也不必自己拼信封。
   */
  function emit(kind: string, record: unknown): void {
    const m: Record<string, unknown> = { kind, record }
    m[TAB_RECORD_TAG] = true
    try {
      window.postMessage(m, origin())
    } catch {
      /* 页面卸载中 */
    }
  }

  const ctx: RecorderCtx = {
    emit,
    now: () => Date.now(),
    origin,
  }

  installNetProbe(ctx)
}
