// page-inspector-bridge.ts 单测：指令下发的失败路径（无人接收 / 件报错 / 永不上报）+ 结果上行按 reqId 配对。
//
// 为什么这几条必须有：件是常驻的、发起侧每次都在等一条结果 —— 配对错一次就是「等满 60 秒拿到别人的
// 结果」这类难查的错；而「件不在位」必须当场失败（用户没开开关时不该看 60 秒转圈）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INSPECTOR_HOST_ID as INSPECTOR_ID } from '@duoling/user-scripts/builtin'

type Sent = { tabId: number; ev: Record<string, unknown> }
type Bridge = typeof import('./page-inspector-bridge')
type Pending = typeof import('./pending-pick')

/** pushCommandTo 桩：记录每次下发；ports = 0 表示该页没有件的在岗连接（件不在位） */
async function stubPush(ports = 1): Promise<{ sent: Sent[]; bridge: Bridge }> {
  const sent: Sent[] = []
  vi.doMock('../gm-port', () => ({
    pushCommandTo: (_uuid: string, tabId: number, ev: Record<string, unknown>) => {
      if (ports === 0) return 0
      sent.push({ tabId, ev })
      return ports
    },
    getGmPortRegistry: () => ({ meta: [] }),
    pushEvent: () => {},
  }))
  // 每次重新导入被测模块：mock 落进去，pending 记账也是新的一份（用例间天然隔离）
  const bridge = (await import('./page-inspector-bridge')) as Bridge
  return { sent, bridge }
}

async function stubFramePort(meta: { connId: string; tabId: number }): Promise<{
  sent: Array<{ ev: Record<string, unknown> }>
  bridge: Bridge
}> {
  const sent: Array<{ ev: Record<string, unknown> }> = []
  vi.doMock('../gm-port', () => ({
    pushCommandTo: () => 0,
    getGmPortRegistry: () => ({
      meta: [[{} as chrome.runtime.Port, { uuid: INSPECTOR_ID, ...meta }]],
    }),
    pushEvent: (_reg: unknown, _port: unknown, ev: Record<string, unknown>) => {
      sent.push({ ev })
    },
  }))
  const bridge = (await import('./page-inspector-bridge')) as Bridge
  return { sent, bridge }
}

function stubSession(): Map<string, unknown> {
  const bag = new Map<string, unknown>()
  const area = {
    get: async (keys: string | string[] | null) => {
      if (keys == null) return Object.fromEntries(bag)
      const list = Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const k of list) if (bag.has(k)) out[k] = bag.get(k)
      return out
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) bag.set(k, v)
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) bag.delete(k)
    },
  }
  vi.stubGlobal('chrome', { storage: { session: area } })
  return bag
}

function result(
  reqId: string,
  payload: unknown,
  ok = true,
): { reqId: string; ok: boolean; payload: unknown } {
  return { reqId, ok, payload }
}

afterEach(() => {
  vi.useRealTimers()
  vi.doUnmock('../gm-port')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('runInspectorCommand · 下发与结算（快照 / 环境读数）', () => {
  it('件上报成功：resolve 件给的载荷，且下发带着本次 reqId', async () => {
    const { sent, bridge } = await stubPush()
    const p = bridge.runInspectorCommand<{ html: string }>(7, 'snapshot')
    expect(sent).toHaveLength(1)
    expect(sent[0].tabId).toBe(7)
    expect(sent[0].ev.t).toBe('inspector.cmd')
    expect(sent[0].ev.cmd).toBe('snapshot')

    bridge.handleInspectorEvent(INSPECTOR_ID, 7, result(String(sent[0].ev.reqId), { html: '<p>' }))
    await expect(p).resolves.toEqual({ html: '<p>' })
  })

  it('件报错：把件给的原因透出来（不换成笼统失败文案）', async () => {
    const { sent, bridge } = await stubPush()
    const p = bridge.runInspectorCommand(7, 'snapshot')
    bridge.handleInspectorEvent(
      INSPECTOR_ID,
      7,
      result(String(sent[0].ev.reqId), '页面检查器未就绪', false),
    )
    await expect(p).rejects.toThrow('页面检查器未就绪')
  })

  it('下发无人接收（件不在位）：当场失败，不等满 60 秒', async () => {
    const { bridge } = await stubPush(0)
    await expect(bridge.runInspectorCommand(7, 'snapshot')).rejects.toThrow('页面检查器未就绪')
  })

  it('件永不上报：按模式文案超时兜底（用户能分辨「没点」与「页面没了」）', async () => {
    const { bridge } = await stubPush()
    vi.useFakeTimers()
    const p = bridge.runInspectorCommand(7, 'snapshot')
    const assertion = expect(p).rejects.toThrow('60 秒内未完成')
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  it('上行信封的 uuid 不是检查器自己的：不结算挂起的调用，最终按超时收场', async () => {
    const { sent, bridge } = await stubPush()
    vi.useFakeTimers()
    const p = bridge.runInspectorCommand(7, 'snapshot')
    const assertion = expect(p).rejects.toThrow('60 秒内未完成')
    bridge.handleInspectorEvent('some-other-script', 7, result(String(sent[0].ev.reqId), { x: 1 }))
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  it('uuid 对上但 reqId 没挂起的调用：只出声不炸（SW 重启过 / 迟到结果），挂起的照常等超时', async () => {
    stubSession()
    const { bridge } = await stubPush()
    vi.useFakeTimers()
    const p = bridge.runInspectorCommand(7, 'snapshot')
    const assertion = expect(p).rejects.toThrow('60 秒内未完成')
    bridge.handleInspectorEvent(INSPECTOR_ID, 7, result('no-such-reqId', { x: 1 }))
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  it('同一 reqId 结算两次（重复投递）：按 reqId 幂等，第二次只出声不炸', async () => {
    const { sent, bridge } = await stubPush()
    const p = bridge.runInspectorCommand<{ n: number }>(7, 'snapshot')
    bridge.handleInspectorEvent(INSPECTOR_ID, 7, result(String(sent[0].ev.reqId), { n: 1 }))
    await expect(p).resolves.toEqual({ n: 1 })
    expect(() =>
      bridge.handleInspectorEvent(INSPECTOR_ID, 7, result(String(sent[0].ev.reqId), { n: 2 })),
    ).not.toThrow()
  })
})

describe('capturePageFrameFromTab · 按 connId 定向', () => {
  it('命中那层 Port：下发 cmd=frame 且带本次 reqId，回执按 reqId 配对', async () => {
    const { sent, bridge } = await stubFramePort({ connId: 'c-1', tabId: 9 })
    const p = bridge.capturePageFrameFromTab(9, 'c-1')
    expect(sent).toHaveLength(1)
    expect(sent[0].ev).toMatchObject({ t: 'inspector.cmd', cmd: 'frame' })

    bridge.handleInspectorEvent(
      INSPECTOR_ID,
      9,
      result(String(sent[0].ev.reqId), { frameUrl: 'https://x/', html: '<p>x</p>' }),
    )
    await expect(p).resolves.toEqual({ frameUrl: 'https://x/', html: '<p>x</p>' })
  })

  it('connId 对不上（另一层 / 已重载）或 tabId 不符：当场失败，不等满 60 秒', async () => {
    const { bridge } = await stubFramePort({ connId: 'c-1', tabId: 9 })
    await expect(bridge.capturePageFrameFromTab(9, 'c-2')).rejects.toThrow('重新 page_snapshot')
    await expect(bridge.capturePageFrameFromTab(10, 'c-1')).rejects.toThrow('重新 page_snapshot')
  })
})

describe('startPick · 下发即返回，结论按页暂存', () => {
  async function setup(): Promise<{ sent: Sent[]; bridge: Bridge; pending: Pending }> {
    stubSession()
    const { sent, bridge } = await stubPush()
    const pending = (await import('./pending-pick')) as Pending
    return { sent, bridge, pending }
  }

  it('下发后立即返回 started，此刻状态是 picking', async () => {
    const { sent, bridge, pending } = await setup()
    await expect(bridge.startPick(7)).resolves.toEqual({ started: true })
    expect(sent.map((s) => [s.tabId, s.ev.cmd])).toEqual([[7, 'pick']])
    expect(await pending.readPickState(7)).toEqual({ status: 'picking' })
  })

  it('件上报元素：结论写进那一页的槽位，picking 转 done', async () => {
    const { sent, bridge, pending } = await setup()
    await bridge.startPick(7)
    bridge.handleInspectorEvent(
      INSPECTOR_ID,
      7,
      result(String(sent[0].ev.reqId), { summary: { tag: 'h1' } }),
    )
    await vi.waitFor(async () => {
      expect(await pending.readPickState(7)).toEqual({
        status: 'done',
        element: { summary: { tag: 'h1' } },
      })
    })
  })

  it('件报错：结论留成 error，文案是件给的那句', async () => {
    const { sent, bridge, pending } = await setup()
    await bridge.startPick(7)
    bridge.handleInspectorEvent(
      INSPECTOR_ID,
      7,
      result(String(sent[0].ev.reqId), '页面检查器未就绪', false),
    )
    await vi.waitFor(async () => {
      expect(await pending.readPickState(7)).toEqual({
        status: 'error',
        message: '页面检查器未就绪',
      })
    })
  })

  it('用户取消（载荷 null）：不留结论，回到 idle', async () => {
    const { sent, bridge, pending } = await setup()
    await bridge.startPick(7)
    bridge.handleInspectorEvent(INSPECTOR_ID, 7, result(String(sent[0].ev.reqId), null))
    await vi.waitFor(async () => {
      expect(await pending.readPickState(7)).toEqual({ status: 'idle' })
    })
  })

  it('下发无人接收：当场抛，且不留下记账（否则这一页会一直显示拾取中）', async () => {
    stubSession()
    const { bridge } = await stubPush(0)
    const pending = (await import('./pending-pick')) as Pending
    await expect(bridge.startPick(7)).rejects.toThrow('页面检查器未就绪')
    expect(await pending.readPickState(7)).toEqual({ status: 'idle' })
  })

  it('同一页已有一次在跑：不重复下发', async () => {
    const { sent, bridge } = await setup()
    await bridge.startPick(7)
    await expect(bridge.startPick(7)).resolves.toEqual({ started: false })
    expect(sent).toHaveLength(1)
  })
})

describe('cancelPicker · 与「开始」走同一根线', () => {
  it('收工指令发往调用方给的那一页，不额外等回执', async () => {
    stubSession()
    const { sent, bridge } = await stubPush()
    await bridge.cancelPicker(42)
    expect(sent.map((s) => [s.tabId, s.ev.cmd])).toEqual([[42, 'cancel']])
  })

  it('件不在位时静默（那条拾取由读时的超时判定收场）', async () => {
    stubSession()
    const { bridge } = await stubPush(0)
    await expect(bridge.cancelPicker(42)).resolves.toBeUndefined()
  })
})
