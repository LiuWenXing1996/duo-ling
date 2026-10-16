// 遥测接线的系统脚本过滤：三件系统脚本（录制 / 检查器 / 浮层宿主）带 GM 包装后注入即广播
// runstart，若不拦会把角标 / 灵动岛 / 活动历史一并污染（普通网页角标凭空 +2）。
// 过滤只认 uuid 集（真相源 @duoling/builtin-scripts 的 registry.ts）；用户脚本一切照旧。
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
type RunEventArgs = [uuid: string, runId: string, event: { kind: string; detail: string; time: number }]
type PageErrorArgs = [tabId: number, info: { uuid: string | null; name: string; message: string; runId: string | null }]

/** mock 须经 vi.hoisted（工厂被 vi.mock 提升到顶层 const 之前执行，直接引用会撞 TDZ） */
const {
  noteRunStart,
  notePageError,
  recordRunStart,
  recordRunEvent,
  appendUserScriptError,
} = vi.hoisted(() => ({
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
vi.mock('./page-inspector-bridge', () => ({ handleInspectorEvent: vi.fn() }))
vi.mock('./float-bridge', () => ({ handleFloatEvent: vi.fn() }))

import { duolingTelemetry } from './telemetry'

describe('duolingTelemetry · 系统脚本不进用户脚本观测面', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('三件系统脚本的 runstart 不登记（角标 / 灵动岛 / popup 都吃这张表）', () => {
    for (const uuid of ['dl-tab-recorder', 'dl-page-inspector', 'dl-float-host']) {
      duolingTelemetry.noteRunStart?.(1, uuid, 'r1')
      expect(noteRunStart, uuid).not.toHaveBeenCalled()
    }
  })

  it('用户脚本的 runstart 照常登记', () => {
    duolingTelemetry.noteRunStart?.(1, 'u1', 'r1')
    expect(noteRunStart).toHaveBeenCalledWith(1, 'u1', 'r1')
  })

  it('系统脚本的错误不实时推送（快照侧按 runId 对不上本就不显示）；用户脚本的照推', () => {
    duolingTelemetry.notePageError?.(1, { uuid: 'dl-float-host', name: 'x', message: 'm', runId: null })
    expect(notePageError).not.toHaveBeenCalled()
    duolingTelemetry.notePageError?.(1, { uuid: 'u1', name: 'x', message: 'm', runId: null })
    expect(notePageError).toHaveBeenCalledTimes(1)
  })

  it('系统脚本的运行日志（runstart / act）不落盘', async () => {
    await duolingTelemetry.recordRunStart?.('dl-page-inspector', 'r1')
    await duolingTelemetry.recordRunEvent?.('dl-float-host', 'r1', { kind: 'a', detail: 'd', time: 1 })
    expect(recordRunStart).not.toHaveBeenCalled()
    expect(recordRunEvent).not.toHaveBeenCalled()
  })

  it('用户脚本的运行日志照常落盘', async () => {
    await duolingTelemetry.recordRunStart?.('u1', 'r1')
    await duolingTelemetry.recordRunEvent?.('u1', 'r1', { kind: 'a', detail: 'd', time: 1 })
    expect(recordRunStart).toHaveBeenCalledWith('u1', 'r1', undefined, undefined)
    expect(recordRunEvent).toHaveBeenCalled()
  })

  it('系统脚本的错误不进用户脚本错误日志；无 uuid（注册期错误）与用户脚本的照落', async () => {
    await duolingTelemetry.appendError?.({ phase: 'runtime', message: 'x', uuid: 'dl-tab-recorder' })
    expect(appendUserScriptError).not.toHaveBeenCalled()

    await duolingTelemetry.appendError?.({ phase: 'register', message: 'y' })
    await duolingTelemetry.appendError?.({ phase: 'runtime', message: 'z', uuid: 'u1' })
    expect(appendUserScriptError).toHaveBeenCalledTimes(2)
  })
})
