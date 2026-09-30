// 引擎可用性监视器（SW 专属）：轮询「运行用户脚本」开关，**只在状态变化时**发事件。
//
// 三层分工（解耦后的结构）：
//   · 保活层 —— offscreen 心跳（offscreen-main.ts）：唯一职责是重置 SW 的 30s 空闲计时，
//     不做任何检测。没有启用脚本时不保活。
//   · 检测层 —— 本模块：SW 活着时自己轮询引擎可用性，状态**变化**（两个方向都算）才通知。
//   · 消费层 —— background 订阅：不可用 → 可用时补注册（开关后开场景的自愈），并向扩展页
//     广播 availabilityChanged（UI 横幅 / 引导页订阅更新显示，不再各自打 visibilitychange 补丁）。
//
// 前提与边界：SW 活不过 30s 空闲，本定时器随之消亡——这**不是 bug**：没有启用脚本时
// offscreen 不保活、SW 睡着，本无状态可检测；SW 被唤醒（UI 消息 / 导航事件）时
// defineBackground 重跑、监视器重启、首个读数重建基线。Chrome 对开关变化没有事件，
// 轮询是唯一检测手段（因此保活层不可省）。

import type { UserScriptsAvailability } from './types'
import { getUserScriptsStatus } from './engine'

/** 一次可用性变化（previous → current；两个方向都会通知，消费方自行筛选） */
export interface AvailabilityChange {
  previous: boolean
  current: UserScriptsAvailability
  /** 变化发生时间（SW 本地时钟），供 UI 展示 / 诊断 */
  changedAt: number
}

type Listener = (change: AvailabilityChange) => void

const listeners = new Set<Listener>()

let timer: ReturnType<typeof setInterval> | null = null
let lastKnown: boolean | null = null

/** 订阅可用性变化（SW 进程内消费）。返回退订函数 */
export function onAvailabilityChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 启动轮询（幂等）：SW 每次 defineBackground 重跑都会调用，重复调用只保留第一个定时器。
 * 首个读数只建基线、不广播（SW 冷启动路径已由 initUserScripts 全量重注册，无需重复动作）。
 *
 * 默认 1s：拨开关后最坏 ~1s 探到翻转、完成补注册。1s 与 2s 手测体感无差异
 * （2026-09-19 手测；注意此前「2s/1s 都有间隔感」的结论是误测了重载前的
 * 5s 旧包所致），既然保活已付、探测又是廉价 IPC，取更快的 1s。SW 已由 offscreen
 * 心跳保活常驻，探测频次不额外增加存活成本；只在变化时才广播。
 */
export function startAvailabilityWatch(intervalMs = 1000): void {
  if (timer) return
  timer = setInterval(() => void tick(), intervalMs)
}

async function tick(): Promise<void> {
  try {
    const status = await getUserScriptsStatus()
    if (lastKnown !== null && status.available !== lastKnown) {
      const change: AvailabilityChange = {
        previous: lastKnown,
        current: status,
        changedAt: Date.now(),
      }
      for (const listener of listeners) listener(change)
    }
    lastKnown = status.available
  } catch {
    // 单次探测失败（SW 收尾中等）：保留基线，下个周期再试
  }
}
