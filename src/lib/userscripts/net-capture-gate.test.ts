// net-capture-gate.ts 单测：per-tab 录制会话的开关、幂等与对账。
// 门禁存 duoling-app 库（扩展自有 kv），用 fake-indexeddb 直测。
// （host 归一化 / match pattern 的用例在同目录 net-record-protocol.test.ts——
//   那两条是跨上下文共用的纯函数，实现已上移到协议模块。）
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import * as appDb from '../app-db'
import { clearAllForTests } from '../app-db'
import {
  getNetCaptureSessions,
  getRecordingHosts,
  reconcileNetSessions,
  startNetSession,
  stopNetSessionsByTab,
} from './net-capture-gate'

/** 门禁的 kv 键：这里要直接写脏数据验收敛，故与实现共用同一份存储契约（值必须一致） */
const SESSIONS_KEY = 'netCaptureSessions'

beforeEach(async () => {
  await clearAllForTests()
})

describe('会话集合读写', () => {
  it('默认空集', async () => {
    expect(await getNetCaptureSessions()).toEqual([])
    expect(await getRecordingHosts()).toEqual([])
  })

  it('start 归一 host 并生成 id，集合里只此一条', async () => {
    const { session, sessions } = await startNetSession({ tabId: 7, host: 'Example.com', title: '示例页' })
    expect(session.host).toBe('example.com')
    expect(session.tabId).toBe(7)
    expect(session.title).toBe('示例页')
    expect(session.id).toBeTruthy()
    expect(sessions).toHaveLength(1)
    expect((await getNetCaptureSessions())[0]?.id).toBe(session.id)
  })

  it('同标签页同站点重复 start 幂等：不换会话、不新增', async () => {
    const first = await startNetSession({ tabId: 7, host: 'a.test' })
    const again = await startNetSession({ tabId: 7, host: 'https://a.test/path' })
    expect(again.session.id).toBe(first.session.id)
    expect(again.replaced).toEqual([])
    expect(await getNetCaptureSessions()).toHaveLength(1)
  })

  it('同标签页换站点：旧会话从集合摘掉并交给调用方归档', async () => {
    const first = await startNetSession({ tabId: 7, host: 'a.test' })
    const next = await startNetSession({ tabId: 7, host: 'b.test' })
    expect(next.replaced.map((s) => s.id)).toEqual([first.session.id])
    expect(next.replaced[0]?.endedAt).toBeTypeOf('number')
    expect((await getNetCaptureSessions()).map((s) => s.host)).toEqual(['b.test'])
  })

  it('不同标签页可以同时录同一站点', async () => {
    await startNetSession({ tabId: 1, host: 'a.test' })
    await startNetSession({ tabId: 2, host: 'a.test' })
    expect(await getNetCaptureSessions()).toHaveLength(2)
    expect(await getRecordingHosts()).toEqual(['a.test'])
  })

  it('start 非法 host / 非法 tabId 抛错', async () => {
    await expect(startNetSession({ tabId: 1, host: '   ' })).rejects.toThrow()
    await expect(startNetSession({ tabId: 0, host: 'a.test' })).rejects.toThrow()
  })

  it('stop 只结束该标签页的会话，返回带 endedAt 的结果', async () => {
    await startNetSession({ tabId: 1, host: 'a.test' })
    await startNetSession({ tabId: 2, host: 'a.test' })
    const { sessions, ended } = await stopNetSessionsByTab(1)
    expect(ended).toHaveLength(1)
    expect(ended[0]?.endedAt).toBeTypeOf('number')
    expect(sessions.map((s) => s.tabId)).toEqual([2])
  })

  it('stop 对没在录的标签页是 no-op', async () => {
    await startNetSession({ tabId: 1, host: 'a.test' })
    const { sessions, ended } = await stopNetSessionsByTab(9)
    expect(ended).toEqual([])
    expect(sessions).toHaveLength(1)
  })
})

describe('对账与脏数据收敛', () => {
  it('reconcile 丢掉标签页已不在的会话，保留其余的', async () => {
    await startNetSession({ tabId: 1, host: 'a.test' })
    await startNetSession({ tabId: 2, host: 'b.test' })
    const { sessions, ended } = await reconcileNetSessions(new Set([2]))
    expect(ended.map((s) => s.tabId)).toEqual([1])
    expect(sessions.map((s) => s.tabId)).toEqual([2])
    expect((await getNetCaptureSessions()).map((s) => s.tabId)).toEqual([2])
  })

  it('存储里缺判据字段 / 非数组一律收敛为空集', async () => {
    await appDb.set(SESSIONS_KEY, 'not-an-array')
    expect(await getNetCaptureSessions()).toEqual([])
    await appDb.set(SESSIONS_KEY, [{ id: 'x' }, { host: 'a.test' }, { id: 'y', host: 'a.test', tabId: 0 }])
    expect(await getNetCaptureSessions()).toEqual([])
  })
})
