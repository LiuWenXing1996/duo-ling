// inspector/install.ts 单测：件在独立 USER_SCRIPT 世界跑，这里用最小假全局把它跑起来，
// 验证指令通道两端 —— 下行认信封（非指令消息不响应）、上行按 reqId 配对回一条、载荷形状对得上
// @duoling/shared 的 page-context.ts —— 以及幂等守卫。
//
// 拾取模式（pick）**不在覆盖范围**：它要真实 hit-testing、事件流与渲染，最小桩测不出行为
// （e2e 里也没有检查器用例），只能靠真机点选验证。这里测的是另外两个模式与通道本身。
//
// 注入方式：件读裸全局（window / document / location / navigator / chrome），故这里把它们
// 都装成全局再调安装函数 —— 与真注入同一条路径。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { INSPECTOR_CMD_TAG, INSPECTOR_RESULT_TAG } from '@duoling/shared'
import { installPageInspector } from './install'

/** 一次微任务 + 定时器轮空：等 .then 链上的上报落到 sent 里 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

interface FakeHost {
  /** 件上报出去的信封（chrome.runtime.sendMessage 收到的东西） */
  sent: Array<Record<string, unknown>>
  /** 从 SW 下发一条消息进件（模拟 chrome.tabs.sendMessage 投到本世界） */
  fire: (msg: unknown) => void
  /** 装监听时是否抛（世界未开 messaging 的形态） */
  breakListener: () => void
}

function stubEnv(): FakeHost {
  const sent: Array<Record<string, unknown>> = []
  const listeners: Array<(msg: unknown) => void> = []
  let broken = false

  vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 2 })
  vi.stubGlobal('document', { documentElement: { outerHTML: '<html><body>hello</body></html>' } })
  vi.stubGlobal('location', { href: 'https://page.test/app' })
  vi.stubGlobal('navigator', { userAgent: 'test-ua/1.0' })
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: {
        addListener: (fn: (msg: unknown) => void) => {
          if (broken) throw new Error('no messaging')
          listeners.push(fn)
        },
      },
      sendMessage: (msg: Record<string, unknown>) => {
        sent.push(msg)
        return Promise.resolve()
      },
    },
  })

  return {
    sent,
    fire: (msg: unknown) => {
      for (const fn of listeners) fn(msg)
    },
    breakListener: () => {
      broken = true
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dl-page-inspector（USER_SCRIPT 世界常驻件）', () => {
  it('snapshot 指令：回一条 ok 信封，reqId 原样带上、载荷是渲染后 outerHTML', async () => {
    const host = stubEnv()
    installPageInspector()

    host.fire({ [INSPECTOR_CMD_TAG]: true, cmd: 'snapshot', reqId: 'r1' })
    await flush()

    expect(host.sent).toHaveLength(1)
    const out = host.sent[0]
    expect(out[INSPECTOR_RESULT_TAG]).toBe(true)
    expect(out.reqId).toBe('r1')
    expect(out.ok).toBe(true)
    expect(out.payload).toMatchObject({
      pageUrl: 'https://page.test/app',
      html: '<html><body>hello</body></html>',
    })
  })

  it('env 指令：回视口 / 像素比 / 页面里读到的 UA（读的是页面事实，非机器真值）', async () => {
    const host = stubEnv()
    installPageInspector()

    host.fire({ [INSPECTOR_CMD_TAG]: true, cmd: 'env', reqId: 'r2' })
    await flush()

    expect(host.sent).toHaveLength(1)
    expect(host.sent[0].payload).toEqual({
      capturedAt: expect.any(Number),
      pageUrl: 'https://page.test/app',
      viewport: { width: 1280, height: 720 },
      dpr: 2,
      ua: 'test-ua/1.0',
    })
  })

  it('非指令消息不响应；重复安装只装一条监听（幂等守卫）', async () => {
    const host = stubEnv()
    installPageInspector()
    installPageInspector() // 第二次应被 window.__dlInspectorHost 挡下

    host.fire({ other: true }) // 没有指令信封：静默忽略
    host.fire({ [INSPECTOR_CMD_TAG]: true, cmd: 'snapshot' }) // 没有 reqId：静默忽略（无从配对）
    host.fire({ [INSPECTOR_CMD_TAG]: true, cmd: 'snapshot', reqId: 'r3' })
    await flush()

    // 只回一条 = 既没重复装监听，也没把无效消息算成一次调用
    expect(host.sent).toHaveLength(1)
    expect(host.sent[0].reqId).toBe('r3')
  })

  it('cancel 指令：没有进行中的拾取时静默（不产生任何上报）', async () => {
    const host = stubEnv()
    installPageInspector()

    host.fire({ [INSPECTOR_CMD_TAG]: true, cmd: 'cancel', reqId: 'r4' })
    await flush()

    expect(host.sent).toHaveLength(0)
  })

  it('世界未开 messaging（装监听即抛）：记一条 warn 兜底，不让安装炸掉页面', () => {
    const host = stubEnv()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    host.breakListener()

    expect(() => installPageInspector()).not.toThrow()
    expect(warn).toHaveBeenCalled()
  })
})
