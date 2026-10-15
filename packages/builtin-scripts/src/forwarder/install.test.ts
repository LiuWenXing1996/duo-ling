// forwarder/install.ts 单测：USER_SCRIPT 世界侧的转发件。
//
// 注入方式：件读全局 window / chrome，故这里把两个假货装成全局再调安装函数（与真注入同一条路径）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NET_TAB_KIND, TAB_RECORD_TAG } from '@duoling/shared'
import { installTabForwarder } from './install'

type AnyWin = Record<string, unknown>

describe('dl-tab-forwarder（USER_SCRIPT 转发件）', () => {
  /** 装上假 window 与假 chrome，返回同帧那条 window 与收到的 message 监听器列表 */
  function setup(): {
    win: AnyWin
    listeners: Array<(e: { source: unknown; data: unknown }) => void>
    sendMessage: ReturnType<typeof vi.fn>
  } {
    const listeners: Array<(e: { source: unknown; data: unknown }) => void> = []
    const win: AnyWin = {
      // 转发件不读 location：归属由 SW 按 sender.tab.id 自己认
      addEventListener: (type: string, fn: (e: unknown) => void) => {
        if (type === 'message') listeners.push(fn as (e: { source: unknown; data: unknown }) => void)
      },
    }
    const sendMessage = vi.fn()
    vi.stubGlobal('window', win)
    vi.stubGlobal('chrome', { runtime: { sendMessage, lastError: undefined } })
    installTabForwarder()
    return { win, listeners, sendMessage }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('把同帧的采集消息转给 SW（信封原样带 TAG 与种类判别键，不带任何归属）', () => {
    const { win, listeners, sendMessage } = setup()
    const record = { type: 'fetch', url: 'https://api.shop.test/x', method: 'GET' }
    for (const fn of listeners) {
      fn({ source: win, data: { kind: NET_TAB_KIND, record, [TAB_RECORD_TAG]: true } })
    }
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [out] = sendMessage.mock.calls[0] as [Record<string, unknown>]
    expect(out).toEqual({ kind: NET_TAB_KIND, record, [TAB_RECORD_TAG]: true })
    // 归属不在这里声明：录制按标签页，SW 用 sender.tab.id 自己认
    expect(out).not.toHaveProperty('host')
  })

  it('忽略非本帧 / 非本协议的消息', () => {
    const { win, listeners, sendMessage } = setup()
    for (const fn of listeners) fn({ source: {}, data: { kind: NET_TAB_KIND, record: {}, [TAB_RECORD_TAG]: true } }) // 非本帧
    for (const fn of listeners) fn({ source: win, data: { other: 1 } }) // 非本协议
    for (const fn of listeners) fn({ source: win, data: { kind: NET_TAB_KIND, [TAB_RECORD_TAG]: true } }) // 缺 record
    for (const fn of listeners) fn({ source: win, data: { kind: 5, record: {}, [TAB_RECORD_TAG]: true } }) // kind 非串
    for (const fn of listeners) fn({ source: win, data: { kind: NET_TAB_KIND, record: {} } }) // 缺 TAG
    expect(sendMessage).not.toHaveBeenCalled()
  })
})
