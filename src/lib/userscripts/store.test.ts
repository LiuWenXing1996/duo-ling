// store.ts 单测：chrome.storage 侧的 DL.store 值 / 错误日志环形保留。
// chrome 由 WxtVitest 插件 stub 成 fakeBrowser；用例间 resetState 保证隔离。
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import {
  appendUserScriptError,
  clearGMValues,
  clearUserScriptErrors,
  deleteGMValue,
  findUserScriptError,
  getGMValue,
  listGMKeys,
  listSummaries,
  listUserScriptErrors,
  setGMValue,
} from './store'
import { type ScriptProject } from './types'

beforeEach(() => {
  fakeBrowser.reset()
})

function makeProject(overrides: Partial<ScriptProject> = {}): ScriptProject {
  return {
    v: 1,
    uuid: 'p1',
    name: '项目一',
    enabled: true,
    config: { matches: ['*://a.com/*'], allFrames: true, runAt: 'document_end' },
    fileCount: 2,
    entry: 'main.js',
    createdAt: 1,
    updatedAt: 42,
    ...overrides,
  }
}

describe('listSummaries', () => {
  it('项目摘要不含源码字段，fileCount 正确', async () => {
    const summaries = await listSummaries([
      makeProject({ buildOk: true, lastBuildAt: 99, bundle: { code: 'x', builtAt: 99 } }),
    ])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toEqual({
      uuid: 'p1',
      name: '项目一',
      enabled: true,
      matches: ['*://a.com/*'],
      fileCount: 2,
      updatedAt: 42,
      buildOk: true,
      lastBuildAt: 99,
    })
    expect('files' in summaries[0]).toBe(false)
    expect('bundle' in summaries[0]).toBe(false)
  })

  it('构建终态：旧记录（无 buildOk）按 bundle 有无兜底推导', async () => {
    const [okLegacy, failedLegacy] = await listSummaries([
      makeProject({ uuid: 'ok', bundle: { code: 'x', builtAt: 1 } }),
      makeProject({ uuid: 'failed' }), // 旧记录：产物置空即构建失败
    ])
    expect(okLegacy.buildOk).toBe(true)
    expect(failedLegacy.buildOk).toBe(false)
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

describe('DL.store 值（us:gm:*）', () => {
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
})

describe('错误日志（us:errors 环形保留）', () => {
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

  it('按脚本清空最后一条后，整个键被移除（不留空数组）', async () => {
    await appendUserScriptError({ uuid: 'u1', name: 'a', phase: 'runtime', message: 'm', time: 1 })
    await clearUserScriptErrors('u1')
    await expect(listUserScriptErrors()).resolves.toEqual([])
    expect(await fakeBrowser.storage.local.get('us:errors')).toEqual({})
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
