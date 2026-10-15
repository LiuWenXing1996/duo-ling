// 数据变更广播（包内自实现，与宿主侧同款协议、同频道互通）。
//
// 自 src/lib/data-broadcast.ts 收编：IDB 没有变更通知，写侧落盘后经此通知别处回拉。
// 广播**只带「哪个域的哪条变了」，不带数据** —— 接收方自己去权威存储回拉，不新增
// 第二份真相。频道名与推送形状必须与宿主侧保持一致（同扩展内互通是硬要求）。
//
// 通道选型：BroadcastChannel 优先（同源多播、**不会唤醒休眠的 SW**）；拿不到时降级
// chrome.runtime.sendMessage（功能等价，只是多了唤醒代价）。

/** 频道名（同一扩展内唯一即可；跨扩展不会串，因为 origin 含扩展 id）——与宿主侧一致 */
const CHANNEL_NAME = 'duoling:data'

/** 合并窗口（ms）：窗口内同一「域 + uuid」的多次变更只发一条补发（防写侧风暴） */
const MERGE_WINDOW_MS = 100

/** 变更域。包内只产出 / 消费这几个；与宿主侧 DataDomain 的子集同名互通 */
export type DataDomain = 'script' | 'error' | 'runlog' | 'tabActivity'

/** 推送形状（与宿主侧 extension-ipc 的 DataChangedPush 同形） */
export interface DataChangedPush {
  kind: 'data:changed'
  domain: DataDomain
  uuid?: string
  /** 发送时刻（ms） */
  at: number
}

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
