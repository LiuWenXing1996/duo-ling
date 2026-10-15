// page-inspector-bridge.ts 单测：指令下发的失败路径（无人接收 / 件报错 / 永不上报）+ 结果上行按 reqId 配对。
//
// 为什么这几条必须有：件是常驻的、发起侧每次都在等一条消息 —— 配对错一次就是「等满 60 秒拿到别人的
// 结果」这类难查的错；而「件不在位」必须当场失败（用户没开开关时不该看 60 秒转圈）。
// chrome 只有 tabs.sendMessage 一个面经手，其余（reqId 配对、世界门禁、取消）都是纯逻辑。
// 真机上「tabs.sendMessage 能否投进 USER_SCRIPT 世界」靠实测，不在本文件的覆盖范围。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cancelPicker, handleInspectorResult, runInspectorCommand } from './page-inspector-bridge'
import { INSPECTOR_CMD_TAG, INSPECTOR_RESULT_TAG } from '@duoling/shared'
import { INSPECTOR_HOST_WORLD_ID } from '@duoling/builtin-scripts'

type Sent = { tabId: number; msg: Record<string, unknown> }

/** chrome.tabs.sendMessage 桩：记录每次下发；fail = 该页没有接收方（件不在位） */
function stubTabs(fail = false): Sent[] {
  const sent: Sent[] = []
  vi.stubGlobal('chrome', {
    tabs: {
      sendMessage: (tabId: number, msg: Record<string, unknown>) => {
        sent.push({ tabId, msg })
        return fail ? Promise.reject(new Error('Could not establish connection.')) : Promise.resolve()
      },
    },
  })
  return sent
}

/** 件侧那条上行消息（信封常量与件源码同源，改名两边一起改） */
function result(reqId: string, payload: unknown, ok = true): Record<string, unknown> {
  return { [INSPECTOR_RESULT_TAG]: true, reqId, ok, payload }
}

/** 上行消息的发送方：世界 id 由浏览器按注册件填，页面伪造不了 */
function senderFrom(worldId: string | undefined): chrome.runtime.MessageSender {
  return { userScriptWorldId: worldId } as chrome.runtime.MessageSender
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('runInspectorCommand · 下发与结算', () => {
  it('件上报成功：resolve 件给的载荷，且下发带着本次 reqId', async () => {
    const sent = stubTabs()
    const p = runInspectorCommand<{ tag: string }>(7, 'pick')
    expect(sent).toHaveLength(1)
    expect(sent[0].tabId).toBe(7)
    expect(sent[0].msg[INSPECTOR_CMD_TAG]).toBe(true)
    expect(sent[0].msg.cmd).toBe('pick')

    handleInspectorResult(
      result(String(sent[0].msg.reqId), { tag: 'h1' }),
      senderFrom(INSPECTOR_HOST_WORLD_ID),
    )
    await expect(p).resolves.toEqual({ tag: 'h1' })
  })

  it('件报错：把件给的原因透出来（不换成笼统失败文案）', async () => {
    const sent = stubTabs()
    const p = runInspectorCommand(7, 'pick')
    handleInspectorResult(
      result(String(sent[0].msg.reqId), '页面检查器未就绪：运行器未装配到本世界', false),
      senderFrom(INSPECTOR_HOST_WORLD_ID),
    )
    await expect(p).rejects.toThrow('运行器未装配到本世界')
  })

  it('下发无人接收（件不在位）：当场失败，不等满 60 秒', async () => {
    stubTabs(true)
    await expect(runInspectorCommand(7, 'pick')).rejects.toThrow('页面检查器未就绪')
  })

  it('件永不上报：按模式文案超时兜底（用户能分辨「自己没点」与「页面没了」）', async () => {
    stubTabs()
    vi.useFakeTimers()
    const p = runInspectorCommand(7, 'pick')
    const assertion = expect(p).rejects.toThrow('60 秒内未完成点选')
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  it('上行消息的世界 id 对不上：不结算挂起的调用，最终按超时收场', async () => {
    const sent = stubTabs()
    vi.useFakeTimers()
    const p = runInspectorCommand(7, 'snapshot')
    const assertion = expect(p).rejects.toThrow('60 秒内未完成')
    // 信封对得上、世界不对：认领但不结算（页面里同款信封可能来自任何一件）
    expect(
      handleInspectorResult(result(String(sent[0].msg.reqId), { x: 1 }), senderFrom('some-other-world')),
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })

  it('上行没带世界 id（SW 常规 onMessage 面的投递没有该字段）：照常按 reqId 结算', async () => {
    const sent = stubTabs()
    const p = runInspectorCommand<{ n: number }>(7, 'pick')
    expect(
      handleInspectorResult(result(String(sent[0].msg.reqId), { n: 1 }), senderFrom(undefined)),
    ).toBe(true)
    await expect(p).resolves.toEqual({ n: 1 })
  })

  it('信封标签不认识：不认领（交 dl-bridge 继续往下分流）', () => {
    expect(handleInspectorResult({ other: true }, senderFrom(INSPECTOR_HOST_WORLD_ID))).toBe(false)
  })
})

describe('cancelPicker · 与「开始」走同一根线', () => {
  it('没有进行中的拾取：静默（不下发也不抛）', async () => {
    const sent = stubTabs()
    await expect(cancelPicker()).resolves.toBeUndefined()
    expect(sent).toHaveLength(0)
  })

  it('有进行中的拾取：收工指令发往那一页，不额外等回执（那次调用由件自行 resolve null 收场）', async () => {
    const sent = stubTabs()
    const p = runInspectorCommand<unknown>(42, 'pick')
    await cancelPicker()
    expect(sent.map((s) => [s.tabId, s.msg.cmd])).toEqual([
      [42, 'pick'],
      [42, 'cancel'],
    ])

    // 件把「被取消」表现为 resolve null：这是本次调用唯一的收场方式，收掉它不留跨用例状态
    handleInspectorResult(result(String(sent[0].msg.reqId), null), senderFrom(INSPECTOR_HOST_WORLD_ID))
    await expect(p).resolves.toBeNull()
  })
})
