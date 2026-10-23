// float-host/install.ts 单测：件在 MAIN 世界系统脚本（GM 包装）里跑，这里用最小假全局把它跑起来，
// 验证指令通道两端 —— 下行认桥事件帧（非指令帧不响应）、ping 按 reqId 回一条 float.pong、
// open / collapse / busy 三个动作口，以及常驻通道（connect + 幂等守卫）。
//
// **件的 DOM 行为不在这里验** —— 挂容器、开合、拖拽、遮罩、拾取让位要真实渲染与事件流，最小桩
// 测不出（也容易把桩的行为当件的行为），由 e2e/float-task-state.spec.ts 用真浏览器覆盖。
//
// 故把它们都装成全局再调安装函数 —— 与真注入同一条路径。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampPoint, installFloatHost } from './install'

interface FakeBridge {
  sent: Array<Record<string, unknown>>
  fire: (ev: unknown) => void
  /** 装接收时是否抛（桥不可用的形态） */
  breakListener: () => void
  /** connect 被调用的次数（常驻通道 + 重发自愈的观测面） */
  connects: number[]
}

function stubBridge(): FakeBridge {
  const sent: Array<Record<string, unknown>> = []
  const handlers: Array<(ev: unknown) => void> = []
  const connects: number[] = []
  let broken = false

  vi.stubGlobal('window', {})
  // documentElement 为 null：观察器走「等文档就绪再装」那条分支，一并覆盖到
  vi.stubGlobal('document', { documentElement: null, addEventListener: vi.fn() })
  vi.stubGlobal('setInterval', () => 0) // 重发自愈的定时器：测试里不真跑
  vi.stubGlobal('__gmBridge', {
    connect: () => {
      connects.push(1)
      return Promise.resolve()
    },
    emit: (envelope: Record<string, unknown>) => {
      sent.push(envelope)
    },
    onEvent: (fn: (ev: unknown) => void) => {
      if (broken) throw new Error('bridge unavailable')
      handlers.push(fn)
    },
  })

  return {
    sent,
    fire: (ev: unknown) => {
      for (const fn of handlers) fn(ev)
    },
    breakListener: () => {
      broken = true
    },
    connects,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dl-float-host（MAIN 世界系统脚本）· 常驻通道', () => {
  it('装通道：安装即 connect（常驻 Port 由中继件代建）', () => {
    const bridge = stubBridge()
    installFloatHost()
    expect(bridge.connects).toHaveLength(1)
  })

  it('同一 realm 重复注入只装一遍（重注册 / 导航竞态）', () => {
    const first = stubBridge()
    installFloatHost()
    installFloatHost()
    expect(first.connects).toHaveLength(1)
  })

  it('桥不可用（装接收即抛）：记一条 warn 兜底，不让安装炸掉页面', () => {
    const bridge = stubBridge()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bridge.breakListener()

    expect(() => installFloatHost()).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})

describe('dl-float-host · 指令接收', () => {
  it('ping 指令：回一条 float.pong 信封，reqId 原样带上', async () => {
    const bridge = stubBridge()
    installFloatHost()

    bridge.fire({ t: 'float.cmd', cmd: 'ping', reqId: 'r1' })
    await new Promise((r) => setTimeout(r, 0))

    expect(bridge.sent).toHaveLength(1)
    const out = bridge.sent[0]
    expect(out.kind).toBe('notice')
    expect(out.name).toBe('浮层宿主')
    expect(out.event).toEqual({ t: 'float.pong', reqId: 'r1' })
  })

  it('ping 没带 reqId：无从配对，静默不回', async () => {
    const bridge = stubBridge()
    installFloatHost()

    bridge.fire({ t: 'float.cmd', cmd: 'ping' })
    await new Promise((r) => setTimeout(r, 0))
    expect(bridge.sent).toHaveLength(0)
  })

  it('非指令帧不响应', async () => {
    const bridge = stubBridge()
    installFloatHost()

    bridge.fire({ t: 'store.change', key: 'k' }) // 别的桥事件：静默忽略
    bridge.fire({ t: 'float.cmd', cmd: 'collapse' }) // collapse 等动作不产生上行
    await new Promise((r) => setTimeout(r, 0))
    expect(bridge.sent).toHaveLength(0)
  })

  it('未知 cmd 静默；非对象载荷（null / 字符串）不炸', () => {
    const bridge = stubBridge()
    installFloatHost()

    expect(() => bridge.fire({ t: 'float.cmd', cmd: '不存在的指令' })).not.toThrow()
    expect(() => bridge.fire(null)).not.toThrow()
    expect(() => bridge.fire('float:open')).not.toThrow()
  })
})

describe('dl-float-host · clamp（拖拽落点夹进视口）', () => {
  const PANEL = { width: 384, height: 600 }
  const VIEWPORT = { width: 1280, height: 800 }

  it('视口内的落点原样保留', () => {
    expect(clampPoint({ x: 100, y: 120 }, PANEL, VIEWPORT)).toEqual({ x: 100, y: 120 })
  })

  it('越过左 / 上边界：贴边（把手仍在屏内）', () => {
    expect(clampPoint({ x: -50, y: -1 }, PANEL, VIEWPORT)).toEqual({ x: 0, y: 0 })
  })

  it('越过右 / 下边界：贴到反向边界，浮层整体不出屏', () => {
    expect(clampPoint({ x: 9999, y: 9999 }, PANEL, VIEWPORT)).toEqual({
      x: VIEWPORT.width - PANEL.width,
      y: VIEWPORT.height - PANEL.height,
    })
  })

  it('恰好贴边：不越界也不回弹', () => {
    expect(
      clampPoint(
        { x: VIEWPORT.width - PANEL.width, y: VIEWPORT.height - PANEL.height },
        PANEL,
        VIEWPORT,
      ),
    ).toEqual({ x: VIEWPORT.width - PANEL.width, y: VIEWPORT.height - PANEL.height })
  })

  it('浮层比视口还大：下界为负时取 0，贴左上而不是把浮层推到屏幕外', () => {
    expect(clampPoint({ x: 10, y: 10 }, PANEL, { width: 300, height: 400 })).toEqual({ x: 0, y: 0 })
  })
})
