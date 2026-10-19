// 标准信道自测 —— 收发口的路由与信封语义（发送/订阅在契约包，接收在 src/shared/ipc-bus）。
//
// 这是全扩展唯一的收发口（发送 ipcRequest / ipcNotify，订阅 ipcSubscribe，接收 serveIpc），
// 故这里只钉「机制」不碰业务：认领顺序、无人认领让路、信封解包、超时兜底，以及
// **表按键的两种写法**怎么查 —— 各端的表组织粒度不同（SW 逐条登记完整 kind，
// offscreen 按域挂前缀键），查错法只会让命令回「未知消息类型」，从业务侧的用例看不出来。
//
// chrome 用手写壳：只留总线用到的两口（onMessage 收发 / sendMessage 发送）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipcNotify, ipcRequest, ipcSubscribe } from '@duoling/shared'
import { packMatcher, prefixMatcher, serveIpc } from './ipc-bus'
import type { RuntimeRequest } from '@duoling/shared'

type SendResponse = (response: unknown) => void
type Listener = (
  msg: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: SendResponse,
) => unknown
type Responder = (msg: { kind: string }, cb?: SendResponse) => void

/** 手写 chrome 壳：登记监听器 + 记下每一发（responder = 应答端那侧的桩，缺省无人应答） */
function stubChrome() {
  const listeners: Listener[] = []
  const sent: Array<{ msg: unknown; cb?: SendResponse }> = []
  let responder: Responder | undefined

  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: (listener: Listener) => {
          const i = listeners.indexOf(listener)
          if (i >= 0) listeners.splice(i, 1)
        },
      },
      sendMessage: (msg: { kind: string }, cb?: SendResponse): Promise<unknown> => {
        sent.push(cb ? { msg, cb } : { msg })
        responder?.(msg, cb)
        // Promise 形态（ipcNotify 走这条）：兑现成 resolve，别让 .catch 拿到 undefined
        return Promise.resolve(undefined)
      },
    },
  })

  const sender = {} as chrome.runtime.MessageSender

  /** 投递一条消息：返回首个认领者（return true）的应答；让路的不阻断后续，全让路 = undefined */
  async function deliver(msg: unknown): Promise<unknown> {
    for (const listener of listeners) {
      let answered: unknown = undefined
      let done = false
      const ret = listener(msg, sender, (r) => {
        answered = r
        done = true
      })
      if (ret !== true) continue
      // 异步应答：监听器把 sendResponse 排在微任务后面
      for (let i = 0; i < 10 && !done; i++) await Promise.resolve()
      return answered
    }
    return undefined
  }

  return {
    listeners,
    sent,
    deliver,
    setResponder: (fn: Responder | undefined) => {
      responder = fn
    },
  }
}

/** 应答端桩：把统一信封交给回调（总线走回调形态） */
const ack = (payload: unknown) => ({ ok: true, data: payload })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('serveIpc —— 每语境唯一的接收口', () => {
  it('第一个认领者应答，后面的 matcher 不再被问', async () => {
    const c = stubChrome()
    const later = vi.fn(async () => 'second')
    serveIpc({
      matchers: [
        { owns: () => true, handle: async () => 'first' },
        { owns: () => true, handle: later },
      ],
    })

    expect(await c.deliver({ kind: 'any:thing' })).toEqual({ ok: true, data: 'first' })
    expect(later).not.toHaveBeenCalled()
  })

  it('无人认领：静默让路（无响应，也不崩）', async () => {
    const c = stubChrome()
    serveIpc({ matchers: [{ owns: (kind) => kind.startsWith('mine:'), handle: async () => 1 }] })

    expect(await c.deliver({ kind: 'other:thing' })).toBeUndefined()
  })

  it('没有 kind 的消息不参与路由（留给别的监听器）', async () => {
    const c = stubChrome()
    serveIpc({ matchers: [{ owns: () => true, handle: async () => 1 }] })

    expect(await c.deliver({ nope: true })).toBeUndefined()
  })

  it('handler 抛错：包成 { ok: false, error } 而不是裸抛', async () => {
    const c = stubChrome()
    serveIpc({
      matchers: [
        {
          owns: () => true,
          handle: async () => {
            throw new Error('后端炸了')
          },
        },
      ],
    })

    expect(await c.deliver({ kind: 'x:y' })).toEqual({ ok: false, error: '后端炸了' })
  })

  it('observe 在问询前跑：无人认领的 kind 也旁听到', async () => {
    const c = stubChrome()
    const seen: string[] = []
    serveIpc({
      matchers: [{ owns: (kind) => kind.startsWith('mine:'), handle: async () => 1 }],
      observe: (msg) => seen.push(msg.kind),
    })

    await c.deliver({ kind: 'other:thing' })
    expect(seen).toEqual(['other:thing'])
  })
})

describe('prefixMatcher —— 表键收完整 kind 与 kind 前缀两种写法', () => {
  const senderOf = () => ({}) as chrome.runtime.MessageSender
  // 本组测的是 matcher 的查表算法，与协议 union 的现役成员无关 —— 故按宽入参形态造消息
  const req = (kind: string, extra: Record<string, unknown> = {}): RuntimeRequest =>
    ({ kind, ...extra }) as RuntimeRequest

  it('前缀键 = 按域分发：该域的全部 kind 落到同一格', async () => {
    const matcher = prefixMatcher(['fs:', 'conv:'], {
      'fs:': async () => 'fs 域',
      'conv:': async () => 'conv 域',
    })

    expect(matcher.owns('fs:ping')).toBe(true)
    expect(matcher.owns('conv:create')).toBe(true)
    expect(matcher.owns('chat:start')).toBe(false)
    expect(await matcher.handle(req('fs:ping'), senderOf())).toBe('fs 域')
    expect(await matcher.handle(req('conv:create', { id: 'c1' }), senderOf())).toBe('conv 域')
  })

  it('两种键混放：完整 kind 优先，其余取最长前缀', async () => {
    const matcher = prefixMatcher(['conv:'], {
      'conv:': async () => '短',
      'conv:group': async () => '中',
      'conv:group-create': async () => '长',
    })

    expect(await matcher.handle(req('conv:group-create'), senderOf())).toBe('长')
    expect(await matcher.handle(req('conv:group-rename'), senderOf())).toBe('中')
    expect(await matcher.handle(req('conv:create'), senderOf())).toBe('短')
  })

  it('前缀认领了却没有实现：报未知消息类型（不静默 undefined）', async () => {
    const matcher = prefixMatcher(['conv:', 'chat:'], { 'conv:': async () => 'conv 域' })

    await expect(matcher.handle(req('chat:start'), senderOf())).rejects.toThrow(/未知消息类型/)
  })
})

describe('packMatcher —— 包自管命令面的问询式转发', () => {
  it('owns / handle 原样透传给包', async () => {
    const handled: string[] = []
    const matcher = packMatcher({
      owns: (kind) => kind === 'userscript:availability',
      handle: async (msg) => {
        handled.push(String(msg.kind))
        return 'pong'
      },
    })

    expect(matcher.owns('userscript:availability')).toBe(true)
    expect(matcher.owns('userscript:save')).toBe(false)
    // 包自管的 kind 不进宿主前缀表 —— pack matcher 排在问询首位代为认领
    expect(
      await matcher.handle(
        { kind: 'userscript:availability' } as never,
        {} as chrome.runtime.MessageSender,
      ),
    ).toBe('pong')
    expect(handled).toEqual(['userscript:availability'])
  })
})

describe('发送原语 —— 信封解包与尽力而为', () => {
  it('ipcRequest：ok 信封里取 data', async () => {
    const c = stubChrome()
    c.setResponder((_msg, cb) => cb?.(ack({ time: 't', branch: 'main' })))

    await expect(ipcRequest({ kind: 'sw:buildInfo' })).resolves.toEqual({
      time: 't',
      branch: 'main',
    })
  })

  it('ipcRequest：业务失败按 error 文本 reject', async () => {
    const c = stubChrome()
    c.setResponder((_msg, cb) => cb?.({ ok: false, error: '浮层没接上' }))

    await expect(ipcRequest({ kind: 'float:open', tabId: 7 })).rejects.toThrow('浮层没接上')
  })

  it('ipcRequest：无人应答（应答端不在场）时给可读错误，不悬着', async () => {
    const c = stubChrome()
    c.setResponder((_msg, cb) => cb?.(undefined))

    await expect(ipcRequest({ kind: 'fs:ping' })).rejects.toThrow('扩展服务未响应')
  })

  it('ipcRequest：应答方永不回调时由 timeoutMs 兜底', async () => {
    stubChrome()

    await expect(ipcRequest({ kind: 'fs:ping' }, { timeoutMs: 5 })).rejects.toThrow(/超时/)
  })

  it('ipcNotify：单向推送不带回调（不占应答通道）', () => {
    const c = stubChrome()

    ipcNotify({ kind: 'offscreen:ready' })
    expect(c.sent).toEqual([{ msg: { kind: 'offscreen:ready' } }])
  })

  it('ipcNotify：发送口不在或无人接收都不抛（尽力而为）', () => {
    vi.stubGlobal('chrome', { runtime: {} })

    expect(() => ipcNotify({ kind: 'offscreen:ready' })).not.toThrow()
  })
})

describe('ipcSubscribe —— 按 kind 前缀收推送', () => {
  it('只收前缀命中的推送；退订后不再收', async () => {
    const c = stubChrome()
    const got: string[] = []
    const off = ipcSubscribe('chat:', (msg) => got.push(msg.kind))

    await c.deliver({ kind: 'chat:chunk' })
    await c.deliver({ kind: 'data:changed' })
    off()
    await c.deliver({ kind: 'chat:chunk' })

    expect(got).toEqual(['chat:chunk'])
    expect(c.listeners).toHaveLength(0)
  })
})
