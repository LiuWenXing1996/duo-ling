// dl-port.ts 纯逻辑单测：Port name / 菜单 id 解析 + 注册表路由。
// 不 mock chrome：DlPortRegistry 与解析函数是纯 JS，Port 用假对象（onDisconnect 无人触发）。
import { describe, expect, it, vi } from 'vitest'
import {
  DlPortRegistry,
  getDlPortRegistry,
  parseDlPortName,
  parseMenuitemId,
  pushEvent,
  pushFetchProgress,
} from './dl-port'
import type { ApiEvent } from './api-contract'

function fakePort(name = 'duoling:dl:u1:c1'): chrome.runtime.Port {
  return { name, postMessage: () => {} } as unknown as chrome.runtime.Port
}

function addPort(reg: DlPortRegistry, uuid: string, connId: string, tabId: number | null) {
  const port = fakePort(`duoling:dl:${uuid}:${connId}`)
  reg.addPort(port, { uuid, connId, tabId })
  return port
}

describe('parseDlPortName', () => {
  it('解析 uuid 与 connId', () => {
    expect(parseDlPortName('duoling:dl:abc-123:c-xyz')).toEqual({ uuid: 'abc-123', connId: 'c-xyz' })
  })
  it('非 DL 前缀 / 缺段 / 空 connId 返回 null', () => {
    expect(parseDlPortName('duoling:panel')).toBeNull()
    expect(parseDlPortName('duoling:dl:abc')).toBeNull()
    expect(parseDlPortName('duoling:dl:abc:')).toBeNull()
  })
})

describe('parseMenuitemId', () => {
  it('解析 us: 前缀的 DL 菜单 id', () => {
    expect(parseMenuitemId('us:uuid1:menu2')).toEqual({ uuid: 'uuid1', menuId: 'menu2' })
  })
  it('非字符串（项目自身数字 id）/ 非 us: 前缀返回 null', () => {
    expect(parseMenuitemId(42)).toBeNull()
    expect(parseMenuitemId('other:item')).toBeNull()
  })
})

describe('DlPortRegistry', () => {
  it('menu.click 按 uuid+tabId 路由：只推点击所在 tab，同 tab 多 frame 全触发', () => {
    const reg = new DlPortRegistry()
    const t1a = addPort(reg, 'u1', 'c1', 11)
    const t1b = addPort(reg, 'u1', 'c2', 11)
    const t2 = addPort(reg, 'u1', 'c3', 22)
    const other = addPort(reg, 'u9', 'c4', 11)
    const got: string[] = []
    for (const p of [t1a, t1b, t2, other]) {
      p.postMessage = (m: { ev?: { t?: string } }) => got.push(`${p.name}:${m.ev?.t}`)
    }
    const ports = reg.portsForMenuClick('u1', 11)
    expect(ports.sort((a, b) => a.name.localeCompare(b.name)).map((p) => p.name)).toEqual([
      'duoling:dl:u1:c1',
      'duoling:dl:u1:c2',
    ])
    expect(ports).not.toContain(t2)
    expect(ports).not.toContain(other)
  })

  it('store 订阅挂 connId 对应的 Port，断开自动清理', () => {
    const reg = new DlPortRegistry()
    const p1 = addPort(reg, 'u1', 'c1', 11)
    addPort(reg, 'u1', 'c2', 11)
    expect(reg.attachWatch('u1', 'c1', 'k1')).toBe(true)
    expect(reg.watchersForKey('u1', 'k1')).toEqual([p1])
    // 未订阅的 key / 其他脚本不路由
    expect(reg.watchersForKey('u1', 'k2')).toEqual([])
    expect(reg.watchersForKey('u9', 'k1')).toEqual([])
    // 断开即摘
    reg.removePort(p1)
    expect(reg.watchersForKey('u1', 'k1')).toEqual([])
  })

  it('attachWatch 找不到 connId 对应 Port 返回 false（未就绪竞态防御）', () => {
    const reg = new DlPortRegistry()
    addPort(reg, 'u1', 'c1', 11)
    expect(reg.attachWatch('u1', 'c-other', 'k')).toBe(false)
  })

  it('detachWatch 只摘对应 connId 的订阅', () => {
    const reg = new DlPortRegistry()
    addPort(reg, 'u1', 'c1', 11)
    addPort(reg, 'u1', 'c2', 11)
    reg.attachWatch('u1', 'c1', 'k')
    reg.attachWatch('u1', 'c2', 'k')
    reg.detachWatch('u1', 'c1', 'k')
    expect(reg.watchersForKey('u1', 'k').map((p) => p.name)).toEqual(['duoling:dl:u1:c2'])
  })

  it('notify 点击归属：登记可查，未知 id 返回 null', () => {
    const reg = new DlPortRegistry()
    reg.trackNotification('n1', 'u1')
    expect(reg.ownerOfNotification('n1')).toBe('u1')
    expect(reg.ownerOfNotification('n2')).toBeNull()
  })

  it('notify.click 推给该 uuid 全部连接（通知无 tab 归属）', () => {
    const reg = new DlPortRegistry()
    addPort(reg, 'u1', 'c1', 11)
    addPort(reg, 'u1', 'c2', 22)
    addPort(reg, 'u9', 'c3', 33)
    expect(reg.portsByUuid('u1')).toHaveLength(2)
  })

})

describe('pushEvent', () => {
  it('正常推帧；Port 已断（postMessage 抛错）时静默摘除', () => {
    const reg = new DlPortRegistry()
    const alive = addPort(reg, 'u1', 'c1', 11)
    const dead = addPort(reg, 'u1', 'c2', 11)
    const frames: unknown[] = []
    alive.postMessage = (m: unknown) => frames.push(m)
    dead.postMessage = () => {
      throw new Error('Attempting to use a disconnected port object')
    }
    const ev: ApiEvent = { t: 'store.change', key: 'k', value: null, oldValue: 1, remote: true }
    pushEvent(reg, dead, ev)
    pushEvent(reg, alive, ev)
    expect(frames).toEqual([{ __dlApiEvent: true, ev }])
    // dead 已被摘除，不再出现在路由里
    expect(reg.portsByUuid('u1')).toEqual([alive])
  })
})

// 2026-09-22 真机踩过的坑：脚本只调 GM_xmlhttpRequest / GM_download（不读值、不注册菜单、不订阅
// 音频）时页面侧从未建下行 Port → portsByConnId 命中 0 → 每一帧都被静默丢掉，脚本只看到「回调
// 永不触发」。这里锁住「推不到时不抛、且喊一声」这条底线。
describe('帧无人接收', () => {
  it('目标连接不存在：不抛、按连接只喊一次', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const frame = { requestId: 'r1', loaded: 1, total: null }
    expect(() => pushFetchProgress('u-noport', 'c-noport', frame)).not.toThrow()
    // 同一个连接再来一帧（推帧很频繁）：不该刷屏
    pushFetchProgress('u-noport', 'c-noport', { ...frame, loaded: 2 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('帧无处可推')

    // 有连接时不喊（同一个 mock 下计数不涨）
    addPort(getDlPortRegistry(), 'u-hasport', 'c-hasport', 1)
    pushFetchProgress('u-hasport', 'c-hasport', frame)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
