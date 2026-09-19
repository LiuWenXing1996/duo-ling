// DL.fetch 特权增强（提案 2026-09-19 老大批准）：forbidden header 覆写 + redirect:'manual' 的
// 机制层，与消息分流解耦（dl-bridge.ts 负责桥接与组装）。
//
// 机制（均已真机探针验证，Chromium 153，tmp/dnr-spike，2026-09-19）：
//   · SW 内 fetch 改不了 forbidden header（fetch 规范静默丢弃），改经 DNR session 规则
//     modifyHeaders 在「发送请求头之前」套上。set/remove 无 header 白名单；append 有，
//     故 v1 只做 set。
//   · DNR 规则没有「只作用于某一次请求」的粒度：规则挂起期间，同 host 的任何 DL.fetch
//     都会被套上覆写头。因此覆写请求 = 写者（独占该 host），纯请求 = 读者（共享）——
//     写优先读写锁：覆写规则挂起期间该 host 的所有 DL.fetch 互斥排队，不同 host 之间照旧并行。
//   · redirect:'manual'：SW fetch 对 3xx 只拿得到 opaqueredirect（status 0、headers 不可读），
//     Location 由观察型 webRequest.onHeadersReceived 读取——manual 不跟随、单次响应、无竞态。
//
// 规则生命周期（用后即撤，三层兜底）：
//   ① fetch settle 的 finally 撤（幂等，dl-bridge）；
//   ② SW 启动对账清自有 id 区间残留（sweepOrphanRules）；
//   ③ session 规则浏览器重启自动清空——因此用 session 而非 dynamic rules，
//     孤儿规则不会变永久幽灵。

/** 走 DNR 规则上线的 header（小写）：fetch 规范禁设头 + user-agent。
 * UA 在 fetch 规范里其实可设，但统一走 DNR 保证上线行为可预期（探针已验证该路径） */
const DNR_ROUTED_HEADERS = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'referer',
  'set-cookie',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'user-agent',
])

/** 单条 header 覆写操作（v1 只 set：语义清晰且无白名单限制） */
export interface DnrHeaderOp {
  header: string
  operation: 'set'
  value: string
}

/** header 拆分结果：native 走 fetch 原生 Headers，dnrOps 收进 session 规则 */
export interface HeaderSplit {
  native: Record<string, string>
  dnrOps: DnrHeaderOp[]
}

/** 把脚本传入的 headers 按可设性拆成两路（header 名大小写不敏感） */
export function splitHeaders(headers: Record<string, string> | undefined): HeaderSplit {
  const native: Record<string, string> = {}
  const dnrOps: DnrHeaderOp[] = []
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (DNR_ROUTED_HEADERS.has(k.toLowerCase())) {
      dnrOps.push({ header: k.toLowerCase(), operation: 'set', value: String(v) })
    } else {
      native[k] = String(v)
    }
  }
  return { native, dnrOps }
}

/** 写优先读写锁：读者 = 纯 fetch（共享并发），写者 = 挂覆写规则的请求（独占）。
 * 写者优先：已有写者排队时，新读者也排队，避免写者饿死 */
export class RwLock {
  private readers = 0
  private writerActive = false
  private writerQueued = 0
  private readerQueue: Array<() => void> = []
  private writerQueue: Array<() => void> = []

  async acquireReader(): Promise<void> {
    if (!this.writerActive && this.writerQueued === 0) {
      this.readers++
      return
    }
    await new Promise<void>((r) => this.readerQueue.push(r))
    this.readers++
  }

  releaseReader(): void {
    this.readers--
    if (this.readers === 0 && this.writerQueue.length > 0) {
      this.writerQueued--
      this.writerActive = true
      this.writerQueue.shift()!()
    }
  }

  async acquireWriter(): Promise<void> {
    this.writerQueued++
    if (!this.writerActive && this.readers === 0) {
      this.writerQueued--
      this.writerActive = true
      return
    }
    await new Promise<void>((r) => this.writerQueue.push(r))
    this.writerQueued--
    this.writerActive = true
  }

  releaseWriter(): void {
    this.writerActive = false
    // 写者优先：先让排队的写者接棒（规则挂起期间互斥语义由接棒延续）
    if (this.writerQueue.length > 0) {
      this.writerActive = true
      this.writerQueue.shift()!()
      return
    }
    // 无写者排队：放行全部等待中的读者（共享并发恢复）
    const woken = this.readerQueue.splice(0)
    this.readers += woken.length
    for (const r of woken) r()
  }
}

const hostLocks = new Map<string, RwLock>()

/** 按 host 取锁（host 来自 URL 解析，天然小写域名:端口形态） */
export function hostLock(host: string): RwLock {
  let lock = hostLocks.get(host)
  if (!lock) {
    lock = new RwLock()
    hostLocks.set(host, lock)
  }
  return lock
}

/** 本模块 session 规则的 id 区间：孤儿对账靠它识别自有规则（session 规则无 owner 标记） */
export const RULE_ID_MIN = 1_000_000_000
export const RULE_ID_MAX = 2_000_000_000

let nextRuleId = RULE_ID_MIN

/** 顺序发号（区间内循环）；并发的每条覆写请求各占一个 id */
export function mintRuleId(): number {
  const id = nextRuleId
  nextRuleId = nextRuleId + 1 >= RULE_ID_MAX ? RULE_ID_MIN : nextRuleId + 1
  return id
}

/** SW 启动对账（用后即撤第二层）：清掉上次崩溃/被杀残留的自有区间 session 规则 */
export async function sweepOrphanRules(): Promise<void> {
  const dnr = chrome.declarativeNetRequest
  if (!dnr?.getSessionRules) return
  const rules = await dnr.getSessionRules()
  const orphans = rules
    .map((r) => r.id)
    .filter((id) => id >= RULE_ID_MIN && id < RULE_ID_MAX)
  if (orphans.length > 0) {
    await dnr.updateSessionRules({ removeRuleIds: orphans })
  }
}

// ————————————————————— redirect:'manual' 的响应观测通道 —————————————————————

/** webRequest 观测到的 3xx 响应（statusText webRequest 不提供，恒为 ''） */
export interface RedirectObservation {
  statusCode: number
  headers: Record<string, string>
}

const manualWaiters = new Map<string, Set<(obs: RedirectObservation) => void>>()

/**
 * 登记一次 manual 请求的观测等待者（必须在 fetch 之前，观测在 fetch 进行中到达）。
 * 键 = 请求 URL 全文。同 URL 并发多个 manual 请求时它们共享观测结果
 * （3xx 响应形状一致，语义可接受，注释留档）。
 */
export function registerManualWaiter(url: string): {
  promise: Promise<RedirectObservation>
  cancel: () => void
} {
  let resolveFn!: (obs: RedirectObservation) => void
  const promise = new Promise<RedirectObservation>((r) => (resolveFn = r))
  let set = manualWaiters.get(url)
  if (!set) {
    set = new Set()
    manualWaiters.set(url, set)
  }
  const waiter = resolveFn
  set.add(waiter)
  return {
    promise,
    cancel: () => {
      const s = manualWaiters.get(url)
      if (!s) return
      s.delete(waiter)
      if (s.size === 0) manualWaiters.delete(url)
    },
  }
}

/**
 * webRequest.onHeadersReceived 的分发入口（dl-bridge 顶层注册）。
 * 返回类型对齐监听器签名（BlockingResponse | undefined）；我们只观测不裁决，恒 undefined。
 * 无等待者时立即返回——该监听器会收到浏览器全部流量，必须廉价。
 */
export function handleObservation(details: {
  url: string
  statusCode: number
  responseHeaders?: Array<{ name: string; value?: string }>
}): undefined {
  const set = manualWaiters.get(details.url)
  if (!set || set.size === 0) return undefined
  manualWaiters.delete(details.url)
  const headers: Record<string, string> = {}
  for (const h of details.responseHeaders ?? []) {
    const k = h.name.toLowerCase()
    headers[k] = headers[k] ? `${headers[k]}, ${h.value ?? ''}` : (h.value ?? '')
  }
  const obs: RedirectObservation = { statusCode: details.statusCode, headers }
  for (const w of set) w(obs)
  return undefined
}
