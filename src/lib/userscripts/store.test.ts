// store.ts 单测：chrome.storage 侧的旧记录扫描清理 / DL.store 值 / 错误日志环形保留。
// chrome 由 WxtVitest 插件 stub 成 fakeBrowser；用例间 resetState 保证隔离。
import { beforeEach, describe, expect, it } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import {
  appendUserScriptError,
  clearDeprecatedScripts,
  clearGMValues,
  clearUserScriptErrors,
  deleteGMValue,
  getGMValue,
  listGMKeys,
  listLegacyScripts,
  listSummaries,
  listUserScriptErrors,
  setGMValue,
} from './store'
import { scriptKey, type ScriptProject } from './types'

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
    files: { 'main.js': '', 'lib/u.js': '' },
    entry: 'main.js',
    createdAt: 1,
    updatedAt: 42,
    ...overrides,
  }
}

describe('listLegacyScripts', () => {
  it('只返回带 GM 特征字段的 us:script:* 记录', async () => {
    const legacy = {
      uuid: 'old1',
      name: '旧脚本',
      enabled: true,
      matches: ['*://*/*'],
      runAt: 'document_end',
      injectInto: 'page',
      grants: ['GM_getValue'],
      source: '// old',
    }
    await chrome.storage.local.set({
      [scriptKey('old1')]: legacy,
      [scriptKey('newish')]: { v: 1, files: {}, name: '新形态残留' },
      unrelated: { source: 'x' }, // 非 us:script: 前缀，即使有特征字段也不算
    })
    const result = await listLegacyScripts()
    expect(result).toHaveLength(1)
    expect(result[0].uuid).toBe('old1')
  })
})

describe('listSummaries', () => {
  it('项目摘要不含源码字段，fileCount 正确', async () => {
    const summaries = await listSummaries([makeProject()])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toEqual({
      uuid: 'p1',
      name: '项目一',
      enabled: true,
      matches: ['*://a.com/*'],
      deprecated: false,
      fileCount: 2,
      updatedAt: 42,
    })
    expect('files' in summaries[0]).toBe(false)
  })

  it('旧记录摘要：deprecated true、不注册、fileCount 0', async () => {
    await chrome.storage.local.set({
      [scriptKey('old1')]: {
        uuid: 'old1',
        name: '旧脚本',
        enabled: true,
        matches: ['*://old/*'],
        runAt: 'document_end',
        injectInto: 'page',
        grants: [],
        source: '// old',
      },
    })
    const summaries = await listSummaries([])
    expect(summaries).toHaveLength(1)
    expect(summaries[0]).toMatchObject({
      uuid: 'old1',
      enabled: false,
      deprecated: true,
      fileCount: 0,
      updatedAt: 0,
    })
  })

  it('排序：非弃用在前 → 启用在前 → 名称字典序', async () => {
    await chrome.storage.local.set({
      [scriptKey('old1')]: {
        uuid: 'old1',
        name: 'aaa旧',
        matches: [],
        runAt: 'document_end',
        injectInto: 'page',
        grants: [],
        source: '',
      },
    })
    const projects = [
      makeProject({ uuid: 'p-off', name: 'b停用', enabled: false }),
      makeProject({ uuid: 'p-z', name: 'z启用', enabled: true }),
      makeProject({ uuid: 'p-a', name: 'a启用', enabled: true }),
    ]
    const summaries = await listSummaries(projects)
    expect(summaries.map((s) => `${s.deprecated ? 'x' : ''}${s.name}`)).toEqual([
      'a启用',
      'z启用',
      'b停用',
      'xaaa旧',
    ])
  })
})

describe('clearDeprecatedScripts', () => {
  it('清掉旧记录与其 DL.store 值，返回条数；新记录不受影响', async () => {
    await chrome.storage.local.set({
      [scriptKey('old1')]: {
        uuid: 'old1',
        name: '旧脚本',
        matches: [],
        runAt: 'document_end',
        injectInto: 'page',
        grants: [],
        source: '',
      },
      [scriptKey('keep')]: { v: 1, files: {} },
      'us:gm:old1:token': 't',
      'us:gm:keep:token': 't2',
    })
    const count = await clearDeprecatedScripts()
    expect(count).toBe(1)
    const rest = await chrome.storage.local.get(null)
    expect(Object.keys(rest).sort()).toEqual(['us:gm:keep:token', scriptKey('keep')])
  })

  it('没有旧记录时返回 0 且不报错', async () => {
    await expect(clearDeprecatedScripts()).resolves.toBe(0)
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
})
