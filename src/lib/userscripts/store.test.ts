// store.ts 单测：GM 值（duoling-usdata 库）/ 观测数据（duoling-runtime 库）。
// 全走 fake-indexeddb，用例间 clearAllForTests 清库保证隔离（不再依赖 fakeBrowser）。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendUserScriptError,
  clearGMValues,
  clearRunLog,
  clearTabActivity,
  clearUserScriptErrors,
  deleteGMValue,
  deleteTabActivity,
  findUserScriptError,
  getGMValue,
  listGMKeys,
  listRunEvents,
  listRunTimeline,
  listSummaries,
  listUserScriptErrors,
  markRunEnd,
  onGmValueChange,
  recordRunEvent,
  recordRunStart,
  setGMValue,
} from './store'
import {
  appendTabCapture,
  appendTabEvent,
  clearAllForTests as clearRuntime,
  listTabEvents,
  listTabSessions,
  listTabTimeline,
  mintTabSession,
} from './runtime-db'
import { clearAllForTests as clearUsdata } from '@duoling/userscript-runtime'
import type { NetCaptureRecord } from '@duoling/shared'
import { RUN_EVENT_MAX, RUN_LOG_MAX, type ScriptProject } from './types'

beforeEach(async () => {
  await Promise.all([clearUsdata(), clearRuntime()])
})

/** 一键一页：造一个「开着活动记录」的页，返回它的存续 id —— 运行条目只在这样的页上产生 */
let tabSeq = 0
function newRecordingTab(): Promise<string> {
  tabSeq += 1
  return mintTabSession({ tabId: tabSeq, recording: true })
}

/** 一条挂在某存续行上的录制采样（活动历史连带清录制时用）——归属只认 tabSessionId，没有站点维度 */
function cap(url: string, tabSessionId: string): NetCaptureRecord {
  return {
    tabSessionId,
    type: 'fetch',
    url,
    method: 'GET',
    reqHeaders: {},
    reqBody: null,
    status: 200,
    respHeaders: {},
    respBody: '{}',
    t: 1,
  }
}

function makeProject(overrides: Partial<ScriptProject> = {}): ScriptProject {
  return {
    v: 2,
    uuid: 'p1',
    name: '项目一',
    enabled: true,
    config: { matches: ['*://a.com/*'], allFrames: true, runAt: 'document_end' },
    group: '',
    source: { code: '// x', savedAt: 1 },
    createdAt: 1,
    ...overrides,
  }
}

describe('listSummaries', () => {
  it('项目摘要不含源码搬运副本，只带列表所需字段', async () => {
    const summaries = await listSummaries([makeProject()])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toEqual({
      uuid: 'p1',
      name: '项目一',
      enabled: true,
      matches: ['*://a.com/*'],
      group: '',
      savedAt: 1,
    })
    expect('source' in summaries[0]).toBe(false)
  })

  it('排序：启用在前，组内按源码保存时间倒序', async () => {
    const projects = [
      makeProject({ uuid: 'p-off', name: 'b停用', enabled: false, source: { code: '// x', savedAt: 100 } }),
      makeProject({ uuid: 'p-z', name: 'z启用', enabled: true, source: { code: '// x', savedAt: 300 } }),
      makeProject({ uuid: 'p-a', name: 'a启用', enabled: true, source: { code: '// x', savedAt: 400 } }),
    ]
    const summaries = await listSummaries(projects)
    // 启用组按 savedAt 降序：p-a(400) > p-z(300)，均排在未启用 p-off(100) 之前
    expect(summaries.map((s) => s.name)).toEqual(['a启用', 'z启用', 'b停用'])
  })
})

describe('GM 值（duoling-usdata 库）', () => {
  it('set / get 往返', async () => {
    await setGMValue('u1', 'k', { a: [1, 'x'] })
    await expect(getGMValue('u1', 'k')).resolves.toEqual({ a: [1, 'x'] })
  })

  it('不存在的键返回 undefined', async () => {
    await expect(getGMValue('u1', 'nope')).resolves.toBeUndefined()
  })

  it('按 uuid + key 隔离', async () => {
    await setGMValue('u1', 'k', 'v1')
    await setGMValue('u2', 'k', 'v2')
    await setGMValue('u1', 'other', 'v3')
    await expect(getGMValue('u2', 'k')).resolves.toBe('v2')
    await expect(listGMKeys('u1')).resolves.toEqual(['k', 'other'])
    await expect(listGMKeys('u3')).resolves.toEqual([])
  })

  it('deleteGMValue 删除单键', async () => {
    await setGMValue('u1', 'k', 'v')
    await deleteGMValue('u1', 'k')
    await expect(getGMValue('u1', 'k')).resolves.toBeUndefined()
  })

  it('clearGMValues 只清该脚本的全部键', async () => {
    await setGMValue('u1', 'a', 1)
    await setGMValue('u1', 'b', 2)
    await setGMValue('u2', 'a', 3)
    await clearGMValues('u1')
    await expect(listGMKeys('u1')).resolves.toEqual([])
    await expect(getGMValue('u2', 'a')).resolves.toBe(3)
  })

  it('写出口发变更事件：set 带新值、delete 置空、clear 逐键删除；附带 oldValue 与 writerConnId', async () => {
    const got: Array<Record<string, unknown>> = []
    const off = onGmValueChange((c) => got.push({ ...c }))
    try {
      await setGMValue('u1', 'k', { n: 1 })
      await deleteGMValue('u1', 'k')
      await setGMValue('u1', 'a', 1)
      await setGMValue('u1', 'b', 2)
      await clearGMValues('u1', 'conn-9')
      // oldValue 支撑 GM_addValueChangeListener 的第 2 参；writerConnId 支撑第 4 参（remote 判定）。
      // 两个可选字段**只在有值时挂上**（事件要过结构化克隆过桥，不留 undefined 键）。
      // clear 是批量操作：逐键发删除事件但**不携带旧值**（清空前不逐个回读，见 clearGMValues 注释）。
      expect(got).toEqual([
        { uuid: 'u1', key: 'k', deleted: false, value: { n: 1 } },
        { uuid: 'u1', key: 'k', deleted: true, value: null, oldValue: { n: 1 } },
        { uuid: 'u1', key: 'a', deleted: false, value: 1 },
        { uuid: 'u1', key: 'b', deleted: false, value: 2 },
        { uuid: 'u1', key: 'a', deleted: true, value: null, writerConnId: 'conn-9' },
        { uuid: 'u1', key: 'b', deleted: true, value: null, writerConnId: 'conn-9' },
      ])
    } finally {
      off()
    }
  })

  it('写入方 connId 原样回传（推送侧据此把「自己写的」标 remote=false）', async () => {
    const got: Array<Record<string, unknown>> = []
    const off = onGmValueChange((c) => got.push({ ...c }))
    try {
      await setGMValue('u1', 'k', 1, 'conn-7')
      expect(got[0]!.writerConnId).toBe('conn-7')
      await deleteGMValue('u1', 'k', 'conn-8')
      expect(got[1]!.writerConnId).toBe('conn-8')
    } finally {
      off()
    }
  })

  it('值未变化的 set、删除不存在的键都不发事件（storage.onChanged 同款语义）', async () => {
    const got: unknown[] = []
    const off = onGmValueChange((c) => got.push(c))
    try {
      await setGMValue('u1', 'k', { a: 1 })
      await setGMValue('u1', 'k', { a: 1 }) // 值未变
      await deleteGMValue('u1', 'nope') // 键不存在
      expect(got).toHaveLength(1)
    } finally {
      off()
    }
  })
})

describe('错误记录（runtime 库 tab_events，判据键 kind = \'error\'，环形保留）', () => {
  it('追加后可读，缺省 id / time 自动补', async () => {
    await appendUserScriptError({
      uuid: 'u1',
      name: '脚本',
      phase: 'runtime',
      message: 'boom',
    })
    const list = await listUserScriptErrors()
    expect(list).toHaveLength(1)
    expect(list[0].id).toBeTruthy()
    expect(list[0].time).toBeGreaterThan(0)
  })

  it('超过 50 条时环形保留最近 50 条', async () => {
    for (let i = 1; i <= 60; i++) {
      await appendUserScriptError({
        uuid: 'u1',
        name: 's',
        phase: 'runtime',
        message: `m${i}`,
        time: i, // 固定时间便于断言
      })
    }
    const list = await listUserScriptErrors()
    expect(list).toHaveLength(50)
    expect(list[0].message).toBe('m60') // 最新在前
    expect(list[49].message).toBe('m11') // 最早保留的是第 11 条
    expect(list.some((e) => e.message === 'm1')).toBe(false)
  })

  it('listUserScriptErrors 最新在前', async () => {
    await appendUserScriptError({ uuid: null, name: 's', phase: 'register', message: 'a', time: 1 })
    await appendUserScriptError({ uuid: null, name: 's', phase: 'bridge', message: 'b', time: 2 })
    const list = await listUserScriptErrors()
    expect(list.map((e) => e.message)).toEqual(['b', 'a'])
  })

  it('调用方传 id / time 时尊重原值', async () => {
    await appendUserScriptError({
      id: 'fixed-id',
      uuid: null,
      name: 's',
      phase: 'runtime',
      message: 'x',
      time: 12345,
    })
    const list = await listUserScriptErrors()
    expect(list[0].id).toBe('fixed-id')
    expect(list[0].time).toBe(12345)
  })

  it('clearUserScriptErrors 清空', async () => {
    await appendUserScriptError({ uuid: null, name: 's', phase: 'runtime', message: 'x' })
    await clearUserScriptErrors()
    await expect(listUserScriptErrors()).resolves.toEqual([])
  })

  it('clearUserScriptErrors(uuid) 只清该脚本，其余保留', async () => {
    await appendUserScriptError({ uuid: 'u1', name: 'a', phase: 'runtime', message: 'u1-1', time: 1 })
    await appendUserScriptError({ uuid: 'u2', name: 'b', phase: 'runtime', message: 'u2-1', time: 2 })
    await appendUserScriptError({ uuid: 'u1', name: 'a', phase: 'register', message: 'u1-2', time: 3 })
    await clearUserScriptErrors('u1')
    await expect(listUserScriptErrors()).resolves.toEqual([
      expect.objectContaining({ message: 'u2-1' }),
    ])
  })

  it('clearUserScriptErrors(null) 只清「无脚本上下文」记录（不清 string uuid 的）', async () => {
    await appendUserScriptError({ uuid: null, name: 's', phase: 'register', message: 'orphan-1', time: 1 })
    await appendUserScriptError({ uuid: 'u1', name: 'a', phase: 'runtime', message: 'u1-1', time: 2 })
    await appendUserScriptError({ uuid: null, name: 's', phase: 'bridge', message: 'orphan-2', time: 3 })
    await clearUserScriptErrors(null)
    await expect(listUserScriptErrors()).resolves.toEqual([
      expect.objectContaining({ message: 'u1-1' }),
    ])
  })

  it('按脚本清空：无该脚本记录时不误伤其他脚本', async () => {
    await appendUserScriptError({ uuid: 'u2', name: 'b', phase: 'runtime', message: 'u2-1', time: 1 })
    await clearUserScriptErrors('不存在')
    await expect(listUserScriptErrors()).resolves.toHaveLength(1)
  })

  it('按脚本清空最后一条后，读取为空', async () => {
    await appendUserScriptError({ uuid: 'u1', name: 'a', phase: 'runtime', message: 'm', time: 1 })
    await clearUserScriptErrors('u1')
    await expect(listUserScriptErrors()).resolves.toEqual([])
  })

  it('页归属由写侧从所属运行条继承：运行期错误不必调用方自己带 tabSessionId', async () => {
    const t = await newRecordingTab()
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t })
    await appendUserScriptError({ uuid: 'u1', name: '甲', phase: 'runtime', message: 'boom', runId: 'r1' })
    expect((await listUserScriptErrors())[0]!.tabSessionId).toBe(t)
  })

  it('注册失败（无 runId）恒无页归属 —— 只落盘，按页查不到', async () => {
    const t = await newRecordingTab()
    await appendUserScriptError({ uuid: 'u1', name: '甲', phase: 'register', message: 'reg' })
    const [rec] = await listUserScriptErrors()
    expect(rec!.tabSessionId).toBeUndefined()
    // 「按页查不到」由索引天然保证：合表后无归属行不进 by_session_seq
    expect((await listTabTimeline(t)).errors).toEqual([])
  })

  describe('findUserScriptError（错误 ID 查询）', () => {
    it('精确 id 命中（优先于前缀匹配）', async () => {
      await appendUserScriptError({
        id: 'aaaaaaaa-1111',
        uuid: 'u1',
        name: 's',
        phase: 'runtime',
        message: 'm1',
      })
      const r = await findUserScriptError('aaaaaaaa-1111')
      expect(r).toEqual({ found: true, record: expect.objectContaining({ message: 'm1' }) })
    })

    it('唯一 8 位前缀命中', async () => {
      await appendUserScriptError({ id: '11111111aaaa', uuid: 'u1', name: 's', phase: 'runtime', message: 'm1' })
      await appendUserScriptError({ id: '22222222bbbb', uuid: 'u2', name: 's', phase: 'runtime', message: 'm2' })
      const r = await findUserScriptError('11111111')
      expect(r).toEqual({ found: true, record: expect.objectContaining({ message: 'm1' }) })
    })

    it('前缀多命中 → ambiguous（绝不猜）', async () => {
      await appendUserScriptError({ id: '33333333aaaa', uuid: 'u1', name: 's', phase: 'runtime', message: 'm1' })
      await appendUserScriptError({ id: '33333333bbbb', uuid: 'u2', name: 's', phase: 'runtime', message: 'm2' })
      expect(await findUserScriptError('33333333')).toEqual({ found: false, reason: 'ambiguous' })
      expect(await findUserScriptError('33333333a')).toEqual({
        found: true,
        record: expect.objectContaining({ message: 'm1' }),
      })
    })

    it('短于 8 位的前缀直接 not-found；不存在的 id → not-found', async () => {
      await appendUserScriptError({ id: '44444444aaaa', uuid: 'u1', name: 's', phase: 'runtime', message: 'm1' })
      expect(await findUserScriptError('4444')).toEqual({ found: false, reason: 'not-found' })
      expect(await findUserScriptError('99999999')).toEqual({ found: false, reason: 'not-found' })
    })
  })
})

describe('运行条目（tab_events 里 kind = \'run\'：一次运行一行）', () => {
  it('没有所在页的存续 id 就不记 —— 一切观测只在开着活动记录的页上产生', async () => {
    await recordRunStart('u1', 'r1', '甲')
    expect(await listRunTimeline()).toEqual([])
  })

  it('开着记录的页上每次运行记一条（含名字快照与页归属）；同一 runId 的补播整体 no-op', async () => {
    const t = await newRecordingTab()
    await recordRunStart('u1', 'r1', '脚本甲', { tabSessionId: t })
    await recordRunStart('u1', 'r1', '脚本甲', { tabSessionId: t }) // engine 的 load 补救补播
    const rows = await listRunTimeline()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'run', uuid: 'u1', name: '脚本甲', tabSessionId: t })
  })

  it('时间线按时间倒序；运行期错误按 runId 挂到所属运行条上', async () => {
    // 同毫秒内多次写入会让排序不稳定：mock Date.now 给每个事件可区分的时刻
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1000)
    const t = await newRecordingTab()
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t })
    nowSpy.mockReturnValue(1001)
    await appendUserScriptError({ uuid: 'u1', name: '甲', phase: 'runtime', message: 'boom', runId: 'r1' })
    nowSpy.mockReturnValue(1002)
    await recordRunStart('u1', 'r2', '甲', { tabSessionId: t })
    nowSpy.mockRestore()
    const rows = await listRunTimeline()
    expect(rows.map((r) => (r.kind === 'run' ? r.runId : 'err'))).toEqual(['r2', 'r1']) // 最新在前
    const r1 = rows.find((r) => r.kind === 'run' && r.runId === 'r1')
    if (!r1 || r1.kind !== 'run') throw new Error('运行行缺失')
    expect(r1.errors.map((e) => e.message)).toEqual(['boom'])
  })

  it('无 runId 的错误（注册 / 依赖抓取）单独成行；runId 对不上任何运行条的错误也单独成行', async () => {
    const t = await newRecordingTab()
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t })
    await appendUserScriptError({ uuid: 'u1', name: '甲', phase: 'register', message: 'reg', time: 2001 })
    await appendUserScriptError({ uuid: 'u1', name: '甲', phase: 'runtime', message: 'late', runId: 'gone', time: 2002 })
    const rows = await listRunTimeline()
    const loose = rows.filter((r) => r.kind === 'error')
    expect(loose).toHaveLength(2)
    expect(loose.map((r) => (r.kind === 'error' ? r.record.message : ''))).toEqual(['late', 'reg']) // 倒序
  })

  it('环形裁剪：超过 RUN_LOG_MAX 只留最近 N 条；被挤出的运行条连带删掉它的动作', async () => {
    const t = await newRecordingTab()
    await recordRunStart('u1', 'oldest', '甲', { tabSessionId: t })
    await recordRunEvent('u1', 'oldest', { kind: 'fetch', detail: 'x', time: 1 })
    for (let i = 0; i < RUN_LOG_MAX; i++) await recordRunStart('u1', `r${i}`, '甲', { tabSessionId: t })

    const rows = await listRunTimeline()
    expect(rows).toHaveLength(RUN_LOG_MAX)
    expect(rows.some((r) => r.kind === 'run' && r.runId === 'oldest')).toBe(false) // 最老的被挤出
    expect(rows.some((r) => r.kind === 'run' && r.runId === `r${RUN_LOG_MAX - 1}`)).toBe(true)
    expect(await listRunEvents('oldest')).toEqual([]) // 动作不留孤儿
  })

  it('clearRunLog：缺省清全部；带 uuid 只清该脚本；null 不动', async () => {
    const t = await newRecordingTab()
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t })
    await recordRunStart('u2', 'r2', '乙', { tabSessionId: t })
    await clearRunLog('u1')
    let rows = await listRunTimeline()
    expect(rows.some((r) => r.kind === 'run' && r.runId === 'r1')).toBe(false)
    expect(rows.some((r) => r.kind === 'run' && r.runId === 'r2')).toBe(true)
    await clearRunLog(null) // 无 uuid 范围：运行条不动
    expect(await listRunTimeline()).toHaveLength(1)
    await clearRunLog()
    expect(await listRunTimeline()).toHaveLength(0)
  })

  it('clearRunLog(该脚本) 连带删掉它的动作，另一个脚本的不动', async () => {
    const t = await newRecordingTab()
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t })
    await recordRunEvent('u1', 'r1', { kind: 'fetch', detail: 'x', time: 1 })
    await recordRunStart('u2', 'r2', '乙', { tabSessionId: t })
    await recordRunEvent('u2', 'r2', { kind: 'fetch', detail: 'y', time: 2 })

    await clearRunLog('u1')
    expect(await listRunEvents('r1')).toEqual([])
    expect(await listRunEvents('r2')).toHaveLength(1)
  })

  it('markRunEnd：给结束的运行盖戳；已带 endedAt 的不再改写（幂等），其余保持「还在跑」', async () => {
    const t = await newRecordingTab()
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(5000)
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t })
    await recordRunStart('u2', 'r2', '乙', { tabSessionId: t })
    await markRunEnd(['r1'], 'navigated')
    nowSpy.mockReturnValue(9999)
    await markRunEnd(['r1'], 'closed') // 幂等：首次的结束戳与原因不被覆盖
    await markRunEnd(['gone'], 'closed') // 环形已挤掉：no-op
    nowSpy.mockRestore()

    const rows = await listRunTimeline()
    const r1 = rows.find((r) => r.kind === 'run' && r.runId === 'r1')
    const r2 = rows.find((r) => r.kind === 'run' && r.runId === 'r2')
    if (!r1 || r1.kind !== 'run' || !r2 || r2.kind !== 'run') throw new Error('运行行缺失')
    expect(r1.endedAt).toBe(5000)
    expect(r1.endReason).toBe('navigated')
    expect(r2.endedAt).toBeUndefined() // 不在这次结束集里 = 还在跑
  })
})

describe('运行动作（tab_events 里 kind = \'act\'：一条动作一行，按 runId 索引）', () => {
  it('动作落在轴上、运行条只带计数；归属不到的运行条不补造记录', async () => {
    const t = await newRecordingTab()
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t })
    await recordRunEvent('u1', 'r1', { kind: 'fetch', detail: 'GET https://a.test/', time: 1100 })
    await recordRunEvent('u1', 'r1', { kind: 'store.set', detail: 'token', time: 1200 })
    await recordRunEvent('u1', 'gone', { kind: 'fetch', detail: 'x', time: 1300 }) // 环形已挤掉 / 未登记

    // 动作不与运行条同字段：时间线列表只带计数，明细按 runId 单拉
    const rows = await listRunTimeline()
    const r1 = rows.find((r) => r.kind === 'run' && r.runId === 'r1')
    if (!r1 || r1.kind !== 'run') throw new Error('运行行缺失')
    expect(r1.eventCount).toBe(2)
    expect(r1.events).toBeUndefined()
    expect(rows.filter((r) => r.kind === 'run')).toHaveLength(1) // 没为 'gone' 补造一条
    expect((await listRunEvents('r1')).map((e) => e.kind)).toEqual(['fetch', 'store.set'])
    expect(await listRunEvents('gone')).toEqual([])
  })

  it('动作从所属运行条继承页归属（合表后按页读整根轴就能一并拿到）', async () => {
    const t = await newRecordingTab()
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t })
    await recordRunEvent('u1', 'r1', { kind: 'fetch', detail: 'GET https://a.test/', time: 1 })
    const timeline = await listTabTimeline(t)
    expect(timeline.acts.map((a) => a.event.kind)).toEqual(['fetch'])
    expect(timeline.acts[0]!.runId).toBe('r1')
  })

  it('超过 RUN_EVENT_MAX 后不再落盘动作，计数继续涨（读侧据此看出被截断）', async () => {
    const t = await newRecordingTab()
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t })
    for (let i = 0; i < RUN_EVENT_MAX + 5; i++) {
      await recordRunEvent('u1', 'r1', { kind: 'fetch', detail: `u${i}`, time: 1000 + i })
    }
    const rows = await listRunTimeline()
    const r1 = rows.find((r) => r.kind === 'run' && r.runId === 'r1')
    if (!r1 || r1.kind !== 'run') throw new Error('运行行缺失')
    expect(await listRunEvents('r1')).toHaveLength(RUN_EVENT_MAX)
    // 计数是「收到总数」，大于实存条数 —— 面板与 AI 靠这个差额说明「还有更多已省略」
    expect(r1.eventCount).toBe(RUN_EVENT_MAX + 5)
  })
})

describe('活动历史（存续表 + 整根活动轴的删除 / 清空）', () => {
  it('删除某一页：存续行 + 它的运行条与错误一起走，别的页不动', async () => {
    const t1 = await mintTabSession({ tabId: 1, url: 'https://1.test/', recording: true })
    const t2 = await mintTabSession({ tabId: 2, url: 'https://2.test/', recording: true })
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t1 })
    await recordRunStart('u1', 'r2', '甲', { tabSessionId: t2 })
    await appendUserScriptError({ uuid: 'u1', name: '甲', phase: 'runtime', message: 'boom1', runId: 'r1' })
    await appendUserScriptError({ uuid: 'u1', name: '甲', phase: 'runtime', message: 'boom2', runId: 'r2' })

    await deleteTabActivity(t1)

    const runs = await listRunTimeline()
    expect(runs.some((r) => r.kind === 'run' && r.runId === 'r1')).toBe(false)
    expect(runs.some((r) => r.kind === 'run' && r.runId === 'r2')).toBe(true)
    // 错误行与运行条同页：合表后靠索引一次删干净，不必按 runId 反查
    const errors = await listUserScriptErrors()
    expect(errors.some((e) => e.message === 'boom1')).toBe(false)
    expect(errors.some((e) => e.message === 'boom2')).toBe(true)
    expect(await listTabSessions()).toHaveLength(1)
  })

  it('删除某一页：它的动作也级联清掉（不留孤儿）', async () => {
    const t1 = await newRecordingTab()
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t1 })
    await recordRunEvent('u1', 'r1', { kind: 'fetch', detail: 'x', time: 1 })

    await deleteTabActivity(t1)
    expect(await listRunEvents('r1')).toEqual([])
  })

  it('清空全部：存续行、运行条、错误（含无归属的）一并清掉', async () => {
    const t1 = await newRecordingTab()
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t1 })
    await appendUserScriptError({ uuid: 'u1', name: '甲', phase: 'runtime', message: 'x', runId: 'r1' })
    await appendUserScriptError({ uuid: null, name: '甲', phase: 'register', message: '无归属' })

    await clearTabActivity()

    expect(await listTabSessions()).toHaveLength(0)
    expect(await listRunTimeline()).toHaveLength(0)
    expect(await listUserScriptErrors()).toHaveLength(0)
  })

  it('删一个不存在的页：no-op，不动任何数据', async () => {
    const t = await newRecordingTab()
    await recordRunStart('u1', 'r1', '甲', { tabSessionId: t })
    await deleteTabActivity('不存在的页')
    expect(await listRunTimeline()).toHaveLength(1)
  })

  it('删除某一页：这一页的刷新 / 地址变更事件一并走，别的页的事件不动', async () => {
    const t1 = await mintTabSession({ tabId: 1, url: 'https://1.test/' })
    const t2 = await mintTabSession({ tabId: 2, url: 'https://2.test/' })
    await appendTabEvent(t1, 'reload', 'https://1.test/')
    await appendTabEvent(t2, 'url', 'https://2.test/next')

    await deleteTabActivity(t1)

    const events = await listTabEvents()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ tabSessionId: t2, kind: 'url' })
  })

  it('清空全部：事件也一并清掉（不留孤儿）', async () => {
    const t1 = await mintTabSession({ tabId: 1, url: 'https://1.test/' })
    await appendTabEvent(t1, 'reload', 'https://1.test/')

    await clearTabActivity()

    expect(await listTabSessions()).toHaveLength(0)
    expect(await listTabEvents()).toHaveLength(0)
  })

  it('删除某一页：它录到的接口采样一并清掉（同表一次清完），别的页不动', async () => {
    const t1 = await mintTabSession({ tabId: 1, url: 'https://1.test/' })
    const t2 = await mintTabSession({ tabId: 2, url: 'https://2.test/' })
    await appendTabCapture(cap('https://1.test/api', t1))
    await appendTabCapture(cap('https://2.test/api', t2))

    await deleteTabActivity(t1)

    expect((await listTabTimeline(t1)).captures).toEqual([])
    expect((await listTabTimeline(t2)).captures.map((r) => r.url)).toEqual(['https://2.test/api'])
  })

  it('清空全部：接口采样也一并清掉', async () => {
    const t1 = await mintTabSession({ tabId: 1, url: 'https://1.test/' })
    await appendTabCapture(cap('https://1.test/api', t1))

    await clearTabActivity()

    expect((await listTabTimeline(t1)).captures).toEqual([])
  })
})
