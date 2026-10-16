// keepalive.ts 单测：认领范围与应答形状。
//
// 应答值没有消费者（保活效果来自消息到达 SW 本身），故这里只钉「认领哪条 type、回什么值」——
// 走库的 listener 端到端：投一条报文，看回调拿到什么、不该认的让不让路。
//
// chrome 用手写壳（只留 onMessage 两口）；库按 type 单例注册，每例退订干净，跨例不残留。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC_SW_KEEPALIVE } from '@duoling/messaging'
import { registerKeepalive } from './keepalive'

type MsgListener = (msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => unknown

let listeners: MsgListener[]
let teardowns: Array<() => void>

beforeEach(() => {
  listeners = []
  teardowns = []
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: (listener: MsgListener) => listeners.push(listener),
        removeListener: (listener: MsgListener) => {
          const i = listeners.indexOf(listener)
          if (i >= 0) listeners.splice(i, 1)
        },
      },
    },
  })
})

afterEach(() => {
  for (const off of teardowns) off()
  vi.unstubAllGlobals()
})

/** 注册并登记退订：库的 listener 是语境级单例，漏退订会让下一例的注册直接抛错 */
function register(): void {
  teardowns.push(registerKeepalive())
}

/** 投一条报文给已注册的 listener：返回应答；让路（未认领）为 undefined */
async function deliver(msg: unknown): Promise<unknown> {
  for (const listener of listeners) {
    let answered: unknown = undefined
    let done = false
    const ret = listener(msg, {}, (r) => {
      answered = r
      done = true
    })
    if (ret !== true) continue
    // 异步应答：库把 sendResponse 排在微任务后面
    for (let i = 0; i < 10 && !done; i++) await Promise.resolve()
    return answered
  }
  return undefined
}

const ping = () => ({ id: 1, type: IPC_SW_KEEPALIVE, data: undefined, timestamp: Date.now() })

describe('registerKeepalive', () => {
  it('注册即同步挂上 listener，并认领保活 type：回库的信封 { res: { alive: true } }', async () => {
    register()
    expect(listeners).toHaveLength(1)

    expect(await deliver(ping())).toEqual({ res: { alive: true } })
  })

  it('只认保活 type：别的 type 让路；总线形状的报文（只有 kind）同样让路', async () => {
    register()

    expect(await deliver({ id: 2, type: 'userscript:list', timestamp: Date.now() })).toBeUndefined()
    expect(await deliver({ kind: 'userscript:list' })).toBeUndefined()
  })

  it('退订后不再认领，也不再占 listener 位', async () => {
    register()
    teardowns.pop()?.()

    expect(listeners).toHaveLength(0)
    expect(await deliver(ping())).toBeUndefined()
  })
})
