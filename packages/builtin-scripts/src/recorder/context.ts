// 标签页录制 · 机制层与种类层之间的唯一接口。
//
// 机制层（recorder/install.ts）提供通道，种类层（recorder/net-probe.ts）提供「录什么」。
// 种类件只拿这两件，且**不得自行再实现一份**：信封与上行由机制层统一管
// （种类件各写一份就会各错各的）。
//
// 采样工具（读流 / 摘要 / 头处理）刻意不在这里预置 —— 那是各类自己的事。

export interface RecorderCtx {
  /** 唯一出口：种类件只产 record，上行信封由机制层拼 */
  emit(kind: string, record: unknown): void
  /** 采集时刻（ms） */
  now(): number
}
