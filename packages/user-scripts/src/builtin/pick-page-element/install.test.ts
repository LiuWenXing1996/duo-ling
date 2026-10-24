import { afterEach, describe, expect, it, vi } from 'vitest'
import { PICK_ELEMENT_CANCEL_COMMAND, PICK_ELEMENT_PICK_COMMAND } from '../registry'
import { installPickPageElement } from './install'

type Handler = (data: unknown) => unknown
function stubKernel(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  vi.stubGlobal('DL', {
    registerBackgroundCommand: (name: string, handler: Handler) => {
      handlers.set(name, handler)
    },
  })
  return handlers
}

function stubDom(): void {
  vi.stubGlobal('document', {
    documentElement: { appendChild() {} },
    createElement: () => ({ className: '', style: { cssText: '' }, textContent: '', remove() {} }),
    addEventListener() {},
    removeEventListener() {},
  })
}
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
describe('dl-pick-page-element（USER_SCRIPT 世界系统脚本）', () => {
  it('装两条后台命令：拾取 + 取消', () => {
    const handlers = stubKernel()
    installPickPageElement()
    expect([...handlers.keys()]).toEqual([PICK_ELEMENT_PICK_COMMAND, PICK_ELEMENT_CANCEL_COMMAND])
  })
  it('cancel：没有进行中的拾取时原样回 null（不报错、不留状态）', () => {
    const handlers = stubKernel()
    installPickPageElement()
    expect(handlers.get(PICK_ELEMENT_CANCEL_COMMAND)!({})).toBeNull()
  })
  it('一直不点：件自己超时 reject（SW 那侧没有第二道兜底）', async () => {
    stubDom()
    const handlers = stubKernel()
    installPickPageElement()
    vi.useFakeTimers()
    const picked = handlers.get(PICK_ELEMENT_PICK_COMMAND)!({}) as Promise<unknown>
    const assertion = expect(picked).rejects.toThrow('60 秒内没有点选')
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
  })
  it('内核缺失：记一条 warn，不打断页面', () => {
    vi.stubGlobal('DL', undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => installPickPageElement()).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})
