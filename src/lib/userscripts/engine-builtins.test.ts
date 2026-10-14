// 内置件的注册查询与「这一页用不用得上」的推导（两处 UI 只读透出的数据源）。
//
// 三条语义各守一处：引擎不可用时全员按未注册回退（不是件本身的错）、未注册的不算在用、
// 录制件只在该页正在记录时才算在用；地址为空直接不给结论。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { builtinsOnPage, listBuiltinRegistrations } from './engine'

/** 装一个假的 userScripts：getScripts 返回给定的在册件 */
function stubUserScripts(registered: Array<{ id: string; matches: string[] }>): void {
  vi.stubGlobal('chrome', {
    userScripts: { getScripts: async () => registered },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listBuiltinRegistrations（内置件注册状态）', () => {
  it('引擎不可用（getScripts 抛错）：五件全部按未注册返回，不抛', async () => {
    vi.stubGlobal('chrome', {
      userScripts: { getScripts: async () => Promise.reject(new Error('不可用')) },
    })
    const all = await listBuiltinRegistrations()
    expect(all).toHaveLength(5)
    expect(all.every((b) => b.registered === false)).toBe(true)
    expect(all.every((b) => b.matches.length === 0)).toBe(true)
  })

  it('chrome.userScripts 不存在（权限未开 / 非 Chromium）：同样回退为未注册', async () => {
    vi.stubGlobal('chrome', {})
    const all = await listBuiltinRegistrations()
    expect(all.every((b) => !b.registered)).toBe(true)
  })

  it('浮层宿主与页面检查器同属注册件：在册时带全匹配面（注册面之外已无件）', async () => {
    stubUserScripts([
      { id: 'dl-float-host', matches: ['<all_urls>'] },
      { id: 'dl-page-inspector', matches: ['<all_urls>'] },
    ])
    const all = await listBuiltinRegistrations()
    const host = all.find((b) => b.id === 'dl-float-host')!
    expect(host.registered).toBe(true)
    expect(host.matches).toEqual(['<all_urls>'])
    expect(host.name).not.toBe(host.id) // 展示名不是注册 id
    expect(host.world).toBe('用户脚本世界')
  })

  it('在册的件带回匹配面，不在册的 matches 为空', async () => {
    stubUserScripts([{ id: 'dl-script-relay', matches: ['https://a.example/*'] }])
    const all = await listBuiltinRegistrations()
    const relay = all.find((b) => b.id === 'dl-script-relay')!
    expect(relay.registered).toBe(true)
    expect(relay.matches).toEqual(['https://a.example/*'])
    expect(relay.name).not.toBe(relay.id) // 展示名不是注册 id
    const recorder = all.find((b) => b.id === 'dl-tab-recorder')!
    expect(recorder.registered).toBe(false)
    expect(recorder.matches).toEqual([])
  })
})

describe('builtinsOnPage（某一页真正在用的内置件）', () => {
  const relay = {
    id: 'dl-script-relay',
    name: '脚本桥',
    world: '用户脚本世界',
    note: 'x',
    matches: ['https://a.example/*'],
    registered: true,
  }
  const recorder = {
    ...relay,
    id: 'dl-tab-recorder',
    name: '页面录制',
    matches: ['*://*/*'],
  }
  const floatHost = {
    ...relay,
    id: 'dl-float-host',
    name: '浮层宿主',
    matches: ['<all_urls>'],
  }
  const inspector = {
    ...relay,
    id: 'dl-page-inspector',
    name: '页面检查器',
    matches: ['<all_urls>'],
  }

  it('地址为空：直接不给结论（内部页 / 读不到 url 的页不在概览里）', () => {
    expect(builtinsOnPage([relay, floatHost], '', false)).toEqual([])
  })

  it('未注册的件不算在用（引擎没开时页面上没有它）', () => {
    expect(builtinsOnPage([{ ...relay, registered: false }], 'https://a.example/p', false)).toEqual(
      [],
    )
  })

  it('中继件按匹配面判：命中站点才算在这一页上', () => {
    expect(builtinsOnPage([relay], 'https://a.example/p', false).map((b) => b.id)).toEqual([
      'dl-script-relay',
    ])
    expect(builtinsOnPage([relay], 'https://b.example/p', false)).toEqual([])
  })

  it('录制件只看记录开关：它是全匹配注册，没开记录的页上列出来是噪音', () => {
    expect(builtinsOnPage([recorder], 'https://a.example/p', false)).toEqual([])
    expect(builtinsOnPage([recorder], 'https://a.example/p', true).map((b) => b.id)).toEqual([
      'dl-tab-recorder',
    ])
  })

  it('全匹配的浮层宿主与页面检查器按匹配面判：普通网页上都在用', () => {
    expect(
      builtinsOnPage([floatHost, inspector], 'https://a.example/p', false).map((b) => b.id),
    ).toEqual(['dl-float-host', 'dl-page-inspector'])
  })
})
