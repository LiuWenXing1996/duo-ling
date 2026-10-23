// inspector/install.ts 单测：件在 MAIN 世界系统脚本（GM 包装）里跑，这里用最小假全局把它跑起来，
// 验证指令通道两端 —— 下行认桥事件帧（非指令帧不响应）、上行按 reqId 配对回一条、载荷形状对得上
// @duoling/shared 的 page-context.ts —— 以及常驻通道（connect + 幂等守卫）。
//
// 拾取模式（pick）**不在覆盖范围**：它要真实 hit-testing、事件流与渲染，最小桩测不出行为
// （e2e 里也没有检查器用例），只能靠真机点选验证。这里测的是另外两个模式与通道本身。
//
// （GM 包装恒注入），故把它们都装成全局再调安装函数 —— 与真注入同一条路径。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installPageInspector } from './install'

/** 一次微任务 + 定时器轮空：等 .then 链上的上报落到 sent 里 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

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

  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2 })
  vi.stubGlobal('document', { documentElement: { outerHTML: '<html><body>hello</body></html>' } })
  vi.stubGlobal('location', { href: 'https://page.test/app' })
  vi.stubGlobal('navigator', { userAgent: 'test-ua/1.0' })
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

describe('dl-page-inspector（MAIN 世界系统脚本）', () => {
  it('装通道：安装即 connect（常驻 Port 由中继件代建）', () => {
    const bridge = stubBridge()
    installPageInspector()
    expect(bridge.connects).toHaveLength(1)
  })

  it('snapshot 指令：回一条 ok 信封，reqId 原样带上、载荷是渲染后 outerHTML', async () => {
    const bridge = stubBridge()
    installPageInspector()

    bridge.fire({ t: 'inspector.cmd', cmd: 'snapshot', reqId: 'r1' })
    await flush()

    expect(bridge.sent).toHaveLength(1)
    const out = bridge.sent[0]
    expect(out.kind).toBe('notice')
    expect(out.name).toBe('页面检查器')
    const ev = out.event as Record<string, unknown>
    expect(ev.t).toBe('inspector.result')
    expect(ev.reqId).toBe('r1')
    expect(ev.ok).toBe(true)
    expect(ev.payload).toMatchObject({
      pageUrl: 'https://page.test/app',
      html: '<html><body>hello</body></html>',
    })
  })

  it('env 指令：回视口 / 像素比 / 页面里读到的 UA（读的是页面事实，非机器真值）', async () => {
    const bridge = stubBridge()
    installPageInspector()

    bridge.fire({ t: 'inspector.cmd', cmd: 'env', reqId: 'r2' })
    await flush()

    expect(bridge.sent).toHaveLength(1)
    const ev = bridge.sent[0].event as Record<string, unknown>
    expect(ev.payload).toEqual({
      capturedAt: expect.any(Number),
      pageUrl: 'https://page.test/app',
      viewport: { width: 1280, height: 720 },
      dpr: 2,
      ua: 'test-ua/1.0',
    })
  })

  it('非指令帧不响应；重复安装只装一条接收（幂等守卫）', async () => {
    const bridge = stubBridge()
    installPageInspector()
    installPageInspector()

    bridge.fire({ t: 'store.change', key: 'k' }) // 别的桥事件：静默忽略
    bridge.fire({ t: 'inspector.cmd', cmd: 'snapshot' }) // 没有 reqId：静默忽略（无从配对）
    bridge.fire({ t: 'inspector.cmd', cmd: 'snapshot', reqId: 'r3' })
    await flush()

    // 只回一条 = 既没重复装接收，也没把无效帧算成一次调用
    expect(bridge.sent).toHaveLength(1)
    expect((bridge.sent[0].event as Record<string, unknown>).reqId).toBe('r3')
  })

  it('cancel 指令：没有进行中的拾取时静默（不产生任何上报）', async () => {
    const bridge = stubBridge()
    installPageInspector()

    bridge.fire({ t: 'inspector.cmd', cmd: 'cancel', reqId: 'r4' })
    await flush()

    expect(bridge.sent).toHaveLength(0)
  })

  it('桥不可用（装接收即抛）：记一条 warn 兜底，不让安装炸掉页面', () => {
    const bridge = stubBridge()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bridge.breakListener()

    expect(() => installPageInspector()).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})
