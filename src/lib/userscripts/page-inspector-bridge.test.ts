// page-inspector-bridge.ts 单测：指令下发的失败路径（无人接收 / 件报错 / 永不上报）+ 结果上行按 reqId 配对。
//
// 为什么这几条必须有：件是常驻的、发起侧每次都在等一条结果 —— 配对错一次就是「等满 60 秒拿到别人的
// 结果」这类难查的错；而「件不在位」必须当场失败（用户没开开关时不该看 60 秒转圈）。
// 下行走 DL Port 事件帧（stub pushCommandTo 后动态导入被测模块，让 mock 落进它的 import），
// 上行结算走 handleInspectorEvent（uuid 旁证 + reqId 配对）。真机上「DL Port 能否推进 MAIN 世界
// 系统脚本」靠实测，不在本文件的覆盖范围。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INSPECTOR_HOST_ID as INSPECTOR_ID } from '@duoling/builtin-scripts'

type Sent = { tabId: number; ev: Record<string, unknown> }
type Bridge = typeof import('./page-inspector-bridge')

/** pushCommandTo 桩：记录每次下发；ports = 0 表示该页没有件的在岗连接（件不在位） */
async function stubPush(ports = 1): Promise<{ sent: Sent[]; bridge: Bridge }> {
  const sent: Sent[] = []
  vi.doMock('@duoling/service-worker', () => ({
    pushCommandTo: (_uuid: string, tabId: number, ev: Record<string, unknown>) => {
      if (ports === 0) return 0
      sent.push({ tabId, ev })
      return ports
    },
  }))
  // 每次重新导入被测模块：mock 落进去，pending 记账也是新的一份（用例间天然隔离）
  const bridge = (await import('./page-inspector-bridge')) as Bridge
  return { sent, bridge }
}

/** 件侧那条上行（dl-bridge 分流后交 handleInspectorEvent 的形状） */
function result(reqId: string, payload: unknown, ok = true): { reqId: string; ok: boolean; payload: unknown } {
  return { reqId, ok, payload }
}

afterEach(() => {
  vi.useRealTimers()
  vi.doUnmock('@duoling/service-worker')
  vi.resetModules()
})

describe('runInspectorCommand · 下发与结算', () => {
  it('件上报成功：resolve 件给的载荷，且下发带着本次 reqId', async () => {
    const { sent, bridge } = await stubPush()
    const p = bridge.runInspectorCommand<{ tag: string }>(7, 'pick')
    expect(sent).toHaveLength(1)
    expect(sent[0].tabId).toBe(7)
    expect(sent[0].ev.t).toBe('inspector.cmd')
    expect(sent[0].ev.cmd).toBe('pick')

    bridge.handleInspectorEvent(INSPECTOR_ID, 7, result(String(sent[0].ev.reqId), { tag: 'h1' }))
    await expect(p).resolves.toEqual({ tag: 'h1' })
  })

  it('件报错：把件给的原因透出来（不换成笼统失败文案）', async () => {
    const { sent, bridge } = await stubPush()
    const p = bridge.runInspectorCommand(7, 'pick')
    bridge.handleInspectorEvent(INSPECTOR_ID, 7, result(String(sent[0].ev.reqId), '页面检查器未就绪', false))
    await expect(p).rejects.toThrow('页面检查器未就绪')
  })

  it('下发无人接收（件不在位）：当场失败，不等满 60 秒', async () => {
    const { bridge } = await stubPush(0)
    await expect(bridge.runInspectorCommand(7, 'pick')).rejects.toThrow('页面检查器未就绪')
  })

  it('件永不上报：按模式文案超时兜底（用户能分辨「自己没点」与「页面没了」）', async () => {
    const { bridge } = await stubPush()
    vi.useFakeTimers()
    const p = bridge.runInspectorCommand(7, 'pick')
    const assertion = expect(p).rejects.toThrow('60 秒内未完成点选')
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
    const p = bridge.runInspectorCommand<{ n: number }>(7, 'pick')
    bridge.handleInspectorEvent(INSPECTOR_ID, 7, result(String(sent[0].ev.reqId), { n: 1 }))
    await expect(p).resolves.toEqual({ n: 1 })
    expect(() =>
      bridge.handleInspectorEvent(INSPECTOR_ID, 7, result(String(sent[0].ev.reqId), { n: 2 })),
    ).not.toThrow()
  })
})

describe('cancelPicker · 与「开始」走同一根线', () => {
  it('没有进行中的拾取：静默（不下发也不抛）', async () => {
    const { sent, bridge } = await stubPush()
    await expect(bridge.cancelPicker()).resolves.toBeUndefined()
    expect(sent).toHaveLength(0)
  })

  it('有进行中的拾取：收工指令发往那一页，不额外等回执（那次调用由件自行 resolve null 收场）', async () => {
    const { sent, bridge } = await stubPush()
    const p = bridge.runInspectorCommand<unknown>(42, 'pick')
    await bridge.cancelPicker()
    expect(sent.map((s) => [s.tabId, s.ev.cmd])).toEqual([
      [42, 'pick'],
      [42, 'cancel'],
    ])

    // 件把「被取消」表现为 resolve null：这是本次调用唯一的收场方式，收掉它不留跨用例状态
    bridge.handleInspectorEvent(INSPECTOR_ID, 42, result(String(sent[0].ev.reqId), null))
    await expect(p).resolves.toBeNull()
  })
})
