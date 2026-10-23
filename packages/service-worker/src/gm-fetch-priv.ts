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

export interface DnrHeaderOp {
  header: string
  operation: 'set'
  value: string
}

export interface HeaderSplit {
  native: Record<string, string>
  dnrOps: DnrHeaderOp[]
}

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
    if (this.writerQueue.length > 0) {
      this.writerActive = true
      this.writerQueue.shift()!()
      return
    }
    const woken = this.readerQueue.splice(0)
    this.readers += woken.length
    for (const r of woken) r()
  }
}

const hostLocks = new Map<string, RwLock>()

export function hostLock(host: string): RwLock {
  let lock = hostLocks.get(host)
  if (!lock) {
    lock = new RwLock()
    hostLocks.set(host, lock)
  }
  return lock
}

export const RULE_ID_MIN = 1_000_000_000
export const RULE_ID_MAX = 2_000_000_000

let nextRuleId = RULE_ID_MIN

export function mintRuleId(): number {
  const id = nextRuleId
  nextRuleId = nextRuleId + 1 >= RULE_ID_MAX ? RULE_ID_MIN : nextRuleId + 1
  return id
}

export async function sweepOrphanRules(): Promise<void> {
  const dnr = chrome.declarativeNetRequest
  if (!dnr?.getSessionRules) return
  const rules = await dnr.getSessionRules()
  const orphans = rules.map((r) => r.id).filter((id) => id >= RULE_ID_MIN && id < RULE_ID_MAX)
  if (orphans.length > 0) {
    await dnr.updateSessionRules({ removeRuleIds: orphans })
  }
}

export interface RedirectObservation {
  statusCode: number
  headers: Record<string, string>
}

const manualWaiters = new Map<string, Set<(obs: RedirectObservation) => void>>()

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
