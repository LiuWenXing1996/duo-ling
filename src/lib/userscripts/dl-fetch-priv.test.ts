// dl-fetch-priv.ts 单测：header 拆分 / 读写锁（互斥语义）/ 规则发号 / 孤儿对账 / 观测分发。
// chrome 仅 sweepOrphanRules 需要，vi.stubGlobal 按需给最小形状。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  splitHeaders,
  RwLock,
  mintRuleId,
  RULE_ID_MIN,
  RULE_ID_MAX,
  sweepOrphanRules,
  registerManualWaiter,
  handleObservation,
} from './dl-fetch-priv'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('splitHeaders', () => {
  it('禁设头与 user-agent 走 DNR（小写 set），其余留原生；header 名大小写不敏感', () => {
    const { native, dnrOps } = splitHeaders({
      Cookie: 'a=1',
      'USER-AGENT': 'UA/1',
      Origin: 'https://o.test/',
      'Content-Type': 'application/json',
      'X-Token': 't',
    })
    expect(dnrOps).toEqual([
      { header: 'cookie', operation: 'set', value: 'a=1' },
      { header: 'user-agent', operation: 'set', value: 'UA/1' },
      { header: 'origin', operation: 'set', value: 'https://o.test/' },
    ])
    expect(native).toEqual({ 'Content-Type': 'application/json', 'X-Token': 't' })
  })

  it('headers 缺省：两路皆空（纯 fetch 不触发任何规则）', () => {
    const { native, dnrOps } = splitHeaders(undefined)
    expect(native).toEqual({})
    expect(dnrOps).toEqual([])
  })
})

describe('RwLock（写者优先读写锁：覆写请求独占 host，纯请求共享）', () => {
  const flush = () => new Promise<void>((r) => setTimeout(r, 0))

  it('读者可并发进入（无写者时纯 fetch 互不排队）', async () => {
    const lock = new RwLock()
    await lock.acquireReader()
    await lock.acquireReader() // 不排队，立即返回
    expect(true).toBe(true)
    lock.releaseReader()
    lock.releaseReader()
  })

  it('写者独占：规则挂起期间读者排队，releaseWriter 后放行', async () => {
    const lock = new RwLock()
    await lock.acquireWriter()
    let readerIn = false
    lock.acquireReader().then(() => (readerIn = true))
    await flush()
    expect(readerIn).toBe(false) // 被写者挡住
    lock.releaseWriter()
    await flush()
    expect(readerIn).toBe(true)
  })

  it('写者等在途读者排空：reader 在飞时 acquireWriter 挂起', async () => {
    const lock = new RwLock()
    await lock.acquireReader()
    let writerIn = false
    lock.acquireWriter().then(() => (writerIn = true))
    await flush()
    expect(writerIn).toBe(false) // 等读者排空（规则不能套到在飞请求上）
    lock.releaseReader()
    await flush()
    expect(writerIn).toBe(true)
    lock.releaseWriter()
  })

  it('写者优先：写者排队时新到的读者也排队，不插队造成写者饿死', async () => {
    const lock = new RwLock()
    await lock.acquireReader()
    let writerIn = false
    lock.acquireWriter().then(() => (writerIn = true))
    let readerBIn = false
    lock.acquireReader().then(() => (readerBIn = true))
    await flush()
    // 排空第一个读者 → 写者接棒，读者 B 仍被挡（互斥语义不被新读者打破）
    lock.releaseReader()
    await flush()
    expect(writerIn).toBe(true)
    expect(readerBIn).toBe(false)
    lock.releaseWriter()
    await flush()
    expect(readerBIn).toBe(true)
  })

  it('releaseWriter 一次放行全部等待中的读者（共享并发恢复）', async () => {
    const lock = new RwLock()
    await lock.acquireWriter()
    const inFlags = [false, false, false]
    for (let i = 0; i < 3; i++) lock.acquireReader().then(() => (inFlags[i] = true))
    await flush()
    expect(inFlags).toEqual([false, false, false])
    lock.releaseWriter()
    await flush()
    expect(inFlags).toEqual([true, true, true])
  })
})

describe('规则发号与孤儿对账', () => {
  it('mintRuleId 在自有区间内顺序递增', () => {
    const a = mintRuleId()
    const b = mintRuleId()
    expect(a).toBeGreaterThanOrEqual(RULE_ID_MIN)
    expect(b).toBe(a + 1)
    expect(b).toBeLessThan(RULE_ID_MAX)
  })

  it('sweepOrphanRules 只清自有区间内的规则，他人规则不动', async () => {
    const update = vi.fn(async () => {})
    vi.stubGlobal('chrome', {
      declarativeNetRequest: {
        getSessionRules: vi.fn(async () => [{ id: RULE_ID_MIN + 5 }, { id: 42 }, { id: RULE_ID_MAX }]),
        updateSessionRules: update,
      },
    })
    await sweepOrphanRules()
    // RULE_ID_MAX 是开区间上界，不属于自有区间；42 是他人规则
    expect(update).toHaveBeenCalledWith({ removeRuleIds: [RULE_ID_MIN + 5] })
  })

  it('declarativeNetRequest 不可用（旧 stub 环境）时对账静默跳过', async () => {
    vi.stubGlobal('chrome', {})
    await expect(sweepOrphanRules()).resolves.toBeUndefined()
  })
})

describe("manual 观测分发（handleObservation）", () => {
  it('按 URL 精确命中等待者，响应头转小写合并；无等待者时廉价空转', () => {
    const w1 = registerManualWaiter('https://x.test/r')
    expect(handleObservation({ url: 'https://other.test/', statusCode: 200 })).toBeUndefined()

    handleObservation({
      url: 'https://x.test/r',
      statusCode: 302,
      responseHeaders: [
        { name: 'Location', value: 'https://y.test/' },
        { name: 'X-Dup', value: 'a' },
        { name: 'x-dup', value: 'b' },
      ],
    })
    return w1.promise.then((obs) => {
      expect(obs.statusCode).toBe(302)
      expect(obs.headers).toEqual({
        location: 'https://y.test/',
        'x-dup': 'a, b',
      })
      // 触发后登记表已清空，重复观测不再命中
      expect(handleObservation({ url: 'https://x.test/r', statusCode: 301 })).toBeUndefined()
    })
  })

  it('cancel 后观测不再命中，等待者不悬挂（由调用方 finally 兜底）', async () => {
    const w = registerManualWaiter('https://x.test/c')
    w.cancel()
    expect(handleObservation({ url: 'https://x.test/c', statusCode: 302 })).toBeUndefined()
  })
})
