// 数据变更广播：写侧 → 全部前端实例。
//
// 为什么需要它：项目状态库（duoling-state）与会话（duoling-chat）都落在 IndexedDB，
// 而 **IDB 没有变更通知**（chrome.storage 有 onChanged，IDB 没有）。于是「别处改了数据、
// 这个页面还显示旧的」是结构性的必然：同一工作台的另一个标签页、另一个浏览器窗口的
// 工作台、侧边栏，全都是各自挂载时拉一次就不再更新。本模块补的就是这条通知线。
//
// 分工（重要）：广播**只带「哪个域的哪条变了」，不带数据**。接收方收到后自己去权威
// 存储回拉 —— 读侧仍是直连 IDB，不新增一条数据通道，也就不会出现第二份真相。
//
// 通道选型：BroadcastChannel 优先。
//   · 同源多播：扩展页 / offscreen / SW 的 origin 都是 chrome-extension://<id>，天然覆盖
//     同页多组件、多标签、多窗口；
//   · **不会唤醒休眠的 SW** —— 这是不选 chrome.runtime.sendMessage 的正经理由：
//     sendMessage 会为了送一条与它无关的通知把 SW 拉起来，每次落盘都付一次启动成本。
// 拿不到 BroadcastChannel 时降级到 sendMessage（功能等价，只是多了唤醒代价）。
// 两种模式对调用方完全透明，切换点只在下面 getMode()。
//
// 谁 import 本模块都不会引入 chrome.storage / chrome.tabs 之类的专属 API，
// 所以 SW / offscreen / 扩展页三处都能用（与 project-store.ts 同一个道理）。

import type { DataChangedPush, DataDomain } from '@/shared/extension-ipc'

/** 频道名（同一扩展内唯一即可；跨扩展不会串，因为 origin 含扩展 id） */
const CHANNEL_NAME = 'duoling:data'

/**
 * 合并窗口（ms）：窗口内同一「域 + uuid」的多次变更只发一条补发。
 * 防的是写侧风暴 —— AI 生成循环会连续落盘、编辑器有防抖草稿写、一轮对话要 append
 * 两条消息。前端重拉一次就够了，没必要每条都拉。
 */
const MERGE_WINDOW_MS = 100

// 收发用**两个**实例：BroadcastChannel 不会把消息回发给发送它的那个实例，
// 若收发共用一个，将来若有「页面内直接写」的路径就会出现「自己收不到自己的通知」。
let rx: BroadcastChannel | null | undefined
let tx: BroadcastChannel | null | undefined

function openChannel(slot: 'rx' | 'tx'): BroadcastChannel | null {
  const cached = slot === 'rx' ? rx : tx
  if (cached !== undefined) return cached
  let created: BroadcastChannel | null = null
  try {
    created = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME)
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

  if (elapsed >= MERGE_WINDOW_MS) {
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
    }, MERGE_WINDOW_MS - elapsed),
  )
}

/** 订阅数据变更；返回取消订阅的函数（组件卸载时调用） */
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
