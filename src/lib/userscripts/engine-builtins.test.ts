// 内置件的注册查询与「这一页用不用得上」的推导（两处 UI 只读透出的数据源）。
//
// 四条语义各守一处：引擎不可用时注册件全部按未注册回退（不是件本身的错）、未注册的不算在用、
// 录制件只在该页正在记录时才算在用、地址为空直接不给结论；注册面之外的静态件（声明式内容
// 脚本恒在、按需拾取器永不算在用）各有一条专用判据。
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
  it('引擎不可用（getScripts 抛错）：三个注册件全部按未注册返回，不抛', async () => {
    vi.stubGlobal('chrome', {
      userScripts: { getScripts: async () => Promise.reject(new Error('不可用')) },
    })
    const all = await listBuiltinRegistrations()
    // 五件全透出：三个注册件 + 两个注册面之外的静态件（声明式内容脚本 / 按需拾取器）
    expect(all).toHaveLength(5)
    const registeredOnes = all.filter((b) => b.presence === 'registered')
    expect(registeredOnes).toHaveLength(3)
    expect(registeredOnes.every((b) => b.registered === false)).toBe(true)
    expect(registeredOnes.every((b) => b.matches.length === 0)).toBe(true)
  })

  it('chrome.userScripts 不存在（权限未开 / 非 Chromium）：注册件同样回退为未注册', async () => {
    vi.stubGlobal('chrome', {})
    const all = await listBuiltinRegistrations()
    expect(all.filter((b) => b.presence === 'registered').every((b) => !b.registered)).toBe(true)
  })

  it('静态件不随引擎可用性变化：声明式内容脚本恒在，按需件不构成状态', async () => {
    vi.stubGlobal('chrome', {})
    const all = await listBuiltinRegistrations()
    const host = all.find((b) => b.id === 'dl-content-host')!
    expect(host.presence).toBe('declarative')
    expect(host.registered).toBe(true) // 普通网页上恒在
    const picker = all.find((b) => b.id === 'duoling-picker')!
    expect(picker.presence).toBe('onDemand')
    expect(picker.registered).toBe(false)
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
    world: '扩展世界',
    note: 'x',
    matches: ['https://a.example/*'],
    registered: true,
    presence: 'registered' as const,
  }
  const recorder = {
    ...relay,
    id: 'dl-tab-recorder',
    name: '页面录制',
    matches: ['*://*/*'],
  }
  const host = {
    ...relay,
    id: 'dl-content-host',
    name: '浮层宿主',
    matches: ['<all_urls>'],
    presence: 'declarative' as const,
  }
  const picker = {
    ...relay,
    id: 'duoling-picker',
    name: '元素拾取器',
    matches: [],
    registered: false,
    presence: 'onDemand' as const,
  }

  it('地址为空：直接不给结论（内部页 / 读不到 url 的页不在概览里）', () => {
    expect(builtinsOnPage([relay, host], '', false)).toEqual([])
  })

  it('未注册的注册件不算在用（引擎没开时页面上没有它）', () => {
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

  it('声明式内容脚本恒算在用（概览只收普通网页），按需件永不算在用', () => {
    expect(builtinsOnPage([host, picker], 'https://a.example/p', false).map((b) => b.id)).toEqual([
      'dl-content-host',
    ])
  })
})
