// 标签页录制 · MAIN 世界件（机制层框架）。
// 为什么必须 MAIN（USER_SCRIPT 世界拦不到页面自己的请求）、机制层 / 种类层分工、
// 运行位置与上行路径、设计硬边界，见 ARCHITECTURE.md「脚本注入」节的「页面录制」条目。
//
// 本件只管**通道**，不管「录什么」：上行信封（__dlEvent + t: 'tab.record'）、出口 emit、
// 幂等守卫；各类信号的具体采法在**种类件**里（当前：net-probe.ts 的网络请求），
// 由本件逐个 install —— 加一类就是多一个 install 调用，不改本件。
// 硬边界：无 chrome.*（一切上行走脚本桥）、与页面同级无特权、桥不可用时静默丢弃采样
// 绝不阻塞页面。本件没有运行期参数，注册走统一脚本链。

import type { RecorderCtx } from './context'
import { installNetProbe } from './net-probe'

declare global {
  interface Window {
    /** 幂等守卫：同一 realm 里被注入两次也只包一层（防重复注册 / 导航竞态） */
    __dlTabRecorder?: boolean
  }
}

/**
 * 脚本桥的上行口（GM 包装内联进同一作用域的 `__dlBridge`，恒注入）。
 * 形状真相源是 service-worker 的 script-bridge.ts；这里只声明本件用到的那一个方法。
 */
declare const __dlBridge: {
  emit(envelope: Record<string, unknown>): void
}

export function installTabRecorder(): void {
  if (window.__dlTabRecorder) return
  window.__dlTabRecorder = true

  function now(): number {
    return Date.now()
  }

  /**
   * 种类件唯一的出口：把采样装进 `__dlEvent` 信封交脚本桥（fire-and-forget）。
   * `kind` 是种类判别键，SW 侧按它分流到各类的归一化函数。
   */
  function emit(kind: string, record: unknown): void {
    try {
      __dlBridge.emit({
        __dlEvent: true,
        name: '页面录制',
        event: { t: 'tab.record', kind, record },
      })
    } catch {
      /* 桥不可用（中继件未就位等）：丢弃这条，录制不阻塞页面 */
    }
  }

  const ctx: RecorderCtx = { emit, now }

  installNetProbe(ctx)
}
