// 标签页录制 · 机制层与种类层之间的唯一接口。
//
// 机制层（recorder/install.ts）提供通道，种类层（recorder/net-probe.ts）提供「录什么」。
// 种类件只拿这三件，且**不得自行再实现一份**：信封与 TAG 由机制层负责，时刻与 postMessage
// 的 targetOrigin 也由机制层统一给（种类件各写一份就会各错各的）。
//
// 采样工具（读流 / 摘要 / 头处理）刻意不在这里预置 —— 那是各类自己的事。

export interface RecorderCtx {
  /** 唯一出口：种类件只产 record，信封三件套（TAG / kind / record）由机制层拼 */
  emit(kind: string, record: unknown): void
  /** 采集时刻（ms） */
  now(): number
  /** postMessage 的 targetOrigin */
  origin(): string
}
