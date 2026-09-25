// store.ts 单测：观测数据（duoling-runtime 库：运行统计 / 运行日志 / 错误日志）。
// 全走 fake-indexeddb，用例间 clearAllForTests 清库保证隔离（不再依赖 fakeBrowser）。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendUserScriptError,
  clearRunLog,
  clearRunStats,
  clearUserScriptErrors,
  findUserScriptError,
  listRunTimeline,
  listSummaries,
  listUserScriptErrors,
  recordRunStart,
  withRunStats,
} from './store'
import { clearAllForTests as clearRuntime, getStats } from './runtime-db'
import { clearAllForTests as clearUsdata } from './usdata-db'
import { RUN_LOG_MAX, type ScriptProject } from './types'

beforeEach(async () => {
  await Promise.all([clearUsdata(), clearRuntime()])
})

/** appendUserScriptError 内部的运行统计记账是 void 后台异步，等它排干再断言 */
async function flushStats(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
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
    updatedAt: 42,
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
      updatedAt: 42,
    })
    expect('source' in summaries[0]).toBe(false)
  })

  it('排序：启用在前，组内按更新时间倒序', async () => {
    const projects = [
      makeProject({ uuid: 'p-off', name: 'b停用', enabled: false, updatedAt: 100 }),
      makeProject({ uuid: 'p-z', name: 'z启用', enabled: true, updatedAt: 300 }),
      makeProject({ uuid: 'p-a', name: 'a启用', enabled: true, updatedAt: 400 }),
    ]
    const summaries = await listSummaries(projects)
    // 启用组按 updatedAt 降序：p-a(400) > p-z(300)，均排在未启用 p-off(100) 之前
    expect(summaries.map((s) => s.name)).toEqual(['a启用', 'z启用', 'b停用'])
  })
})


describe('错误日志（runtime 库，环形保留）', () => {
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

  it('clearUserScriptErrors(null) 只清「未归属」记录（不清 string uuid 的）', async () => {
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

describe('运行统计（runtime 库 stats store，按脚本聚合计数）', () => {
  it('recordRunStart 累计次数并记录最后运行时刻；withRunStats 挂到摘要上', async () => {
    await recordRunStart('u1', 'r1')
    await recordRunStart('u1', 'r2')
    const [s] = await withRunStats(await listSummaries([makeProject({ uuid: 'u1' })]))
    expect(s!.runCount).toBe(2)
    expect(s!.lastRunAt).toBeGreaterThan(0)
  })

  it('同一 runId 的补播去重：不重复计数、不抹掉已计的错误数', async () => {
    await recordRunStart('u1', 'r1')
    await appendUserScriptError({ uuid: 'u1', name: 's', phase: 'runtime', message: 'boom', runId: 'r1' })
    await flushStats()
    await recordRunStart('u1', 'r1') // engine 的 load 补救补播
    const [s] = await withRunStats(await listSummaries([makeProject({ uuid: 'u1' })]))
    expect(s!.runCount).toBe(1)
    expect(s!.lastRunErrors).toBe(1)
  })

  it('runtime 错误只计入最近一次运行；旧运行的迟到错误不计', async () => {
    await recordRunStart('u1', 'r1')
    await recordRunStart('u1', 'r2')
    await appendUserScriptError({ uuid: 'u1', name: 's', phase: 'runtime', message: 'late', runId: 'r1' })
    await appendUserScriptError({ uuid: 'u1', name: 's', phase: 'runtime', message: 'boom', runId: 'r2' })
    await flushStats()
    const [s] = await withRunStats(await listSummaries([makeProject({ uuid: 'u1' })]))
    expect(s!.runCount).toBe(2)
    expect(s!.lastRunErrors).toBe(1)
  })

  it('register / bridge 错误（无 runId）不影响运行统计', async () => {
    await recordRunStart('u1', 'r1')
    await appendUserScriptError({ uuid: 'u1', name: 's', phase: 'register', message: 'reg' })
    await appendUserScriptError({ uuid: 'u1', name: 's', phase: 'bridge', message: 'bridge' })
    await flushStats()
    const [s] = await withRunStats(await listSummaries([makeProject({ uuid: 'u1' })]))
    expect(s!.runCount).toBe(1)
    expect(s!.lastRunErrors).toBeUndefined()
  })

  it('多脚本互不串数；无统计的脚本保持缺省（不渲染该列）', async () => {
    await recordRunStart('u1', 'r1')
    const [a, b] = await withRunStats(
      await listSummaries([makeProject({ uuid: 'u1' }), makeProject({ uuid: 'u2' })]),
    )
    expect(a!.runCount).toBe(1)
    expect(b!.runCount).toBeUndefined()
    expect('lastRunAt' in b!).toBe(false)
  })

  it('clearRunStats 清掉该脚本的统计（删脚本时调用）', async () => {
    await recordRunStart('u1', 'r1')
    await recordRunStart('u2', 'r9')
    await clearRunStats('u1')
    const [a, b] = await withRunStats(
      await listSummaries([makeProject({ uuid: 'u1' }), makeProject({ uuid: 'u2' })]),
    )
    expect(a!.runCount).toBeUndefined()
    expect(b!.runCount).toBe(1)
    await expect(getStats('u1')).resolves.toBeUndefined()
  })
})

describe('运行日志（runtime 库 runlog 环形 + listRunTimeline 时间线）', () => {
  it('每次运行记一条日志（含名字快照）；补播去重不重复记', async () => {
    await recordRunStart('u1', 'r1', '脚本甲')
    await recordRunStart('u2', 'r9', '脚本乙')
    await recordRunStart('u1', 'r1', '脚本甲') // load 补播：整体 no-op
    const rows = await listRunTimeline()
    const runs = rows.filter((r) => r.kind === 'run')
    expect(runs).toHaveLength(2)
    expect(runs.find((r) => r.runId === 'r1')).toMatchObject({ uuid: 'u1', name: '脚本甲' })
  })

  it('时间线按时间倒序；runtime 错误按 runId 挂到所属运行行', async () => {
    // 同毫秒内多次写入会让排序不稳定：mock Date.now 给每个事件可区分的时刻
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1000)
    await recordRunStart('u1', 'r1', '甲')
    nowSpy.mockReturnValue(1001)
    await appendUserScriptError({ uuid: 'u1', name: '甲', phase: 'runtime', message: 'boom', runId: 'r1' })
    nowSpy.mockReturnValue(1002)
    await recordRunStart('u1', 'r2', '甲')
    nowSpy.mockRestore()
    await flushStats()
    const rows = await listRunTimeline()
    expect(rows.map((r) => (r.kind === 'run' ? r.runId : 'err'))).toEqual(['r2', 'r1']) // 最新在前
    const r1 = rows.find((r) => r.kind === 'run' && r.runId === 'r1')
    const r2 = rows.find((r) => r.kind === 'run' && r.runId === 'r2')
    if (!r1 || r1.kind !== 'run' || !r2 || r2.kind !== 'run') throw new Error('运行行缺失')
    expect(r1.errors).toHaveLength(1)
    expect(r1.errors[0]!.message).toBe('boom')
    expect(r2.errors).toHaveLength(0)
  })

  it('无 runId 的错误（注册/桥）单独成行；runId 落空（运行滑出环形）的错误也单独成行', async () => {
    await recordRunStart('u1', 'r1', '甲')
    await appendUserScriptError({ uuid: 'u1', name: '甲', phase: 'register', message: 'reg', time: 2001 })
    await appendUserScriptError({ uuid: 'u1', name: '甲', phase: 'runtime', message: 'late', runId: 'gone', time: 2002 })
    await flushStats()
    const rows = await listRunTimeline()
    const loose = rows.filter((r) => r.kind === 'error')
    expect(loose).toHaveLength(2)
    expect(loose.map((r) => (r.kind === 'error' ? r.record.message : ''))).toEqual(['late', 'reg']) // 倒序
  })

  it('环形裁剪：超过 RUN_LOG_MAX 只留最近 N 条', async () => {
    for (let i = 0; i < RUN_LOG_MAX + 10; i++) {
      await recordRunStart('u1', `r${i}`, '甲')
    }
    const rows = await listRunTimeline()
    expect(rows).toHaveLength(RUN_LOG_MAX)
    expect(rows.some((r) => r.kind === 'run' && r.runId === 'r0')).toBe(false) // 最老的被挤出
    expect(rows.some((r) => r.kind === 'run' && r.runId === `r${RUN_LOG_MAX + 9}`)).toBe(true)
  })

  it('clearRunLog：缺省清全部；带 uuid 只清该脚本；null 不动', async () => {
    await recordRunStart('u1', 'r1', '甲')
    await recordRunStart('u2', 'r2', '乙')
    await clearRunLog('u1')
    let rows = await listRunTimeline()
    expect(rows.some((r) => r.kind === 'run' && r.runId === 'r1')).toBe(false)
    expect(rows.some((r) => r.kind === 'run' && r.runId === 'r2')).toBe(true)
    await clearRunLog(null) // 未归属范围：run-log 不动
    expect(await listRunTimeline()).toHaveLength(1)
    await clearRunLog()
    expect(await listRunTimeline()).toHaveLength(0)
  })

  it('clearRunStats 连带清该脚本的日志条目（删脚本 = 清该脚本名下的一切）', async () => {
    await recordRunStart('u1', 'r1', '甲')
    await recordRunStart('u2', 'r2', '乙')
    await clearRunStats('u1')
    const rows = await listRunTimeline()
    expect(rows.some((r) => r.kind === 'run' && r.uuid === 'u1')).toBe(false)
    expect(rows.some((r) => r.kind === 'run' && r.uuid === 'u2')).toBe(true)
  })
})
