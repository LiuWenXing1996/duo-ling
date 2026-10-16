// 数据变更广播：跨语境广播的**唯一实现**（应用侧原 src/lib/data-broadcast.ts 已并入本文件）。
//
// IDB 没有变更通知，写侧落盘后经此通知别处回拉。广播**只带「哪个域的哪条变了」，不带数据**
// —— 接收方自己去权威存储回拉，不新增第二份真相。频道名 / 合并窗口 / 推送形状的真相源在
// @duoling/shared（data-broadcast.ts，跨世界契约）：同扩展内互通是硬要求，字面量放两侧只能靠
// 注释对齐。消费方 = 本包（gm-values 写出口 / cookie-gate 订阅）+ 应用各载体。
//
// 通道选型：BroadcastChannel 优先（同源多播、**不会唤醒休眠的 SW**）；拿不到时降级
// chrome.runtime.sendMessage（功能等价，只是多了唤醒代价）。

import {
  DATA_BROADCAST_CHANNEL,
  DATA_MERGE_WINDOW_MS,
  type BuildPhase,
  type DataChangedPush,
  type DataDomain,
} from '@duoling/shared'

// 收发用**两个**实例：BroadcastChannel 不会把消息回发给发送它的那个实例，
// 若收发共用一个，将来若有「页面内直接写」的路径就会出现「自己收不到自己的通知」。
let rx: BroadcastChannel | null | undefined
let tx: BroadcastChannel | null | undefined

function openChannel(slot: 'rx' | 'tx'): BroadcastChannel | null {
  const cached = slot === 'rx' ? rx : tx
  if (cached !== undefined) return cached
  let created: BroadcastChannel | null = null
  try {
    created = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(DATA_BROADCAST_CHANNEL)
  } catch {
    created = null // 环境不支持：走 sendMessage 降级
  }
  if (slot === 'rx') rx = created
  else tx = created
  return created
}

/** 实际投递一条通知（尽力而为：没人监听不是错误） */
function emit(push: DataChangedPush): void {
  const channel = openChannel('tx')
  if (channel) {
    channel.postMessage(push)
    return
  }
  // 降级：sendMessage 无人接收时会产生 lastError，静默吞掉
  try {
    void chrome.runtime.sendMessage(push).catch(() => {})
  } catch {
    // chrome.runtime 不在（如纯 Node 测试环境）：广播本就是尽力而为，不影响主链路
  }
}

/** 上一次真正投递的时刻，按「域:uuid」记 */
const lastSent = new Map<string, number>()
/** 合并窗口内待补发的定时器 */
const pending = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 广播一次数据变更（写侧在落盘后调用）。
 *
 * 节流策略：窗口外的第一次**立即发**（用户手点的操作不该等 100ms），
 * 窗口内的后续合并成一条、在窗口末尾补发（防风暴）。
 */
export function broadcastDataChange(domain: DataDomain, uuid?: string): void {
  const key = `${domain}:${uuid ?? ''}`
  const now = Date.now()
  const last = lastSent.get(key) ?? 0
  const elapsed = now - last

  if (elapsed >= DATA_MERGE_WINDOW_MS) {
    lastSent.set(key, now)
    emit({ kind: 'data:changed', domain, uuid, at: now })
    return
  }
  if (pending.has(key)) return // 已有补发在排队，这一条被它带走
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key)
      const t = Date.now()
      lastSent.set(key, t)
      emit({ kind: 'data:changed', domain, uuid, at: t })
    }, DATA_MERGE_WINDOW_MS - elapsed),
  )
}

/**
 * 广播一次保存链的瞬态阶段（当前只有 `saving`）。
 *
 * 与 broadcastDataChange 的区别：**立即发、不进合并窗口**——瞬态就是给用户看进度的，
 * 被窗口吞掉后到达顺序错乱（如 saving 被并发的完成通知合并掉），转圈会闪跳。
 * 阶段通知不带数据、不触发回拉，收尾终态仍由常规落库广播负责。
 */
export function broadcastBuildPhase(domain: DataDomain, uuid: string, phase: BuildPhase): void {
  emit({ kind: 'data:changed', domain, uuid, at: Date.now(), phase })
}

/** 订阅数据变更；返回取消订阅的函数 */
export function subscribeDataChange(listener: (push: DataChangedPush) => void): () => void {
  const channel = openChannel('rx')
  if (channel) {
    const onMessage = (event: MessageEvent): void => {
      const push = event.data as DataChangedPush | undefined
      if (push?.kind === 'data:changed') listener(push)
    }
    channel.addEventListener('message', onMessage)
    return () => channel.removeEventListener('message', onMessage)
  }
  // 降级：环境既无 BroadcastChannel 又无 chrome（如某些测试环境），
  // 广播本就是尽力而为，订阅直接静默 no-op，不能让组件挂载炸掉
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return () => {}
    const onMessage = (raw: unknown): void => {
      const push = raw as DataChangedPush | undefined
      if (push?.kind === 'data:changed') listener(push)
    }
    chrome.runtime.onMessage.addListener(onMessage)
    return () => chrome.runtime.onMessage.removeListener(onMessage)
  } catch {
    return () => {}
  }
}
