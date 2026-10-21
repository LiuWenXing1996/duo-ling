import { beforeEach, describe, expect, it, vi } from 'vitest'

/** store.appendUserScriptError 的入参形状（Omit id/time 再补可选）—— mock 只关心 uuid 判定 */
type ErrRec = {
  phase: 'runtime' | 'register' | 'bridge' | 'require' | 'resource'
  message: string
  uuid?: string | null
  name?: string
  time?: number
  id?: string
}
type RunStartArgs = [
  uuid: string,
  runId: string,
  name?: string,
  extra?: { url?: string; savedAt?: number; tabSessionId?: string },
]
type RunEventArgs = [
  uuid: string,
  runId: string,
  event: { kind: string; detail: string; time: number },
]
type PageErrorArgs = [
  tabId: number,
  info: { uuid: string | null; name: string; message: string; runId: string | null },
]

/** mock 须经 vi.hoisted（工厂被 vi.mock 提升到顶层 const 之前执行，直接引用会撞 TDZ） */
const { noteRunStart, notePageError, recordRunStart, recordRunEvent, appendUserScriptError } =
  vi.hoisted(() => ({
    noteRunStart: vi.fn<(tabId: number, uuid: string, runId: string) => void>(),
    notePageError: vi.fn<(...args: PageErrorArgs) => void>(),
    recordRunStart: vi.fn<(...args: RunStartArgs) => Promise<void>>(),
    recordRunEvent: vi.fn<(...args: RunEventArgs) => Promise<void>>(),
    appendUserScriptError: vi.fn<(rec: ErrRec) => Promise<void>>(),
  }))

vi.mock('./page-monitor', () => ({
  noteRunStart: (...args: [tabId: number, uuid: string, runId: string]) => noteRunStart(...args),
  notePageError: (...args: PageErrorArgs) => notePageError(...args),
}))
vi.mock('./store', () => ({
  recordRunStart: (...args: RunStartArgs) => recordRunStart(...args),
  recordRunEvent: (...args: RunEventArgs) => recordRunEvent(...args),
  appendUserScriptError: (...args: [rec: ErrRec]) => appendUserScriptError(...args),
}))
vi.mock('./tab-sessions', () => ({ recordingTabSessionId: vi.fn() }))
vi.mock('./runtime-db', () => ({ appendTabCapture: vi.fn(() => Promise.resolve()) }))

import { telemetry } from './telemetry'

describe('telemetry · 系统脚本不进用户脚本观测面', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('四件系统脚本的 runstart 不登记（角标 / 灵动岛 / popup 都吃这张表）', () => {
    for (const uuid of [
      'dl-page-env',
      'dl-page-snapshot',
      'dl-pick-page-element',
      'dl-float-host',
    ]) {
      telemetry.noteRunStart(1, uuid, 'r1')
      expect(noteRunStart, uuid).not.toHaveBeenCalled()
    }
  })

  it('用户脚本的 runstart 照常登记', () => {
    telemetry.noteRunStart(1, 'u1', 'r1')
    expect(noteRunStart).toHaveBeenCalledWith(1, 'u1', 'r1')
  })

  it('系统脚本的错误不实时推送（快照侧按 runId 对不上本就不显示）；用户脚本的照推', () => {
    telemetry.notePageError(1, { uuid: 'dl-float-host', name: 'x', message: 'm', runId: null })
    expect(notePageError).not.toHaveBeenCalled()
    telemetry.notePageError(1, { uuid: 'u1', name: 'x', message: 'm', runId: null })
    expect(notePageError).toHaveBeenCalledTimes(1)
  })

  it('系统脚本的运行日志（runstart / act）不落盘', async () => {
    await telemetry.recordRunStart('dl-page-env', 'r1')
    await telemetry.recordRunEvent('dl-float-host', 'r1', { kind: 'a', detail: 'd', time: 1 })
    expect(recordRunStart).not.toHaveBeenCalled()
    expect(recordRunEvent).not.toHaveBeenCalled()
  })

  it('用户脚本的运行日志照常落盘', async () => {
    await telemetry.recordRunStart('u1', 'r1')
    await telemetry.recordRunEvent('u1', 'r1', { kind: 'a', detail: 'd', time: 1 })
    // 透传按剩余参数展开：调用方传几参就转发几参，不人为补 undefined
    expect(recordRunStart).toHaveBeenCalledWith('u1', 'r1')
    expect(recordRunEvent).toHaveBeenCalled()
  })

  it('系统脚本的错误不进用户脚本错误日志；无 uuid（注册期错误）与用户脚本的照落', async () => {
    await telemetry.appendError({ phase: 'runtime', message: 'x', uuid: 'dl-page-env' })
    expect(appendUserScriptError).not.toHaveBeenCalled()

    await telemetry.appendError({ phase: 'register', message: 'y' })
    await telemetry.appendError({ phase: 'runtime', message: 'z', uuid: 'u1' })
    expect(appendUserScriptError).toHaveBeenCalledTimes(2)
  })
})
