// float-host/install.ts 单测：件在独立 USER_SCRIPT 世界跑，这里用最小假全局把它跑起来，
// 验证三件事 —— 世界级 hook 的形状、装配（init）与消息面、拖拽落点的夹取。
//
// **件的 DOM 行为不在这里验** —— 挂容器、开合、拖拽、遮罩、拾取让位要真实渲染与事件流，最小桩
// 测不出（也容易把桩的行为当件的行为），由 e2e/float-task-state.spec.ts 用真浏览器覆盖。
//
// 与历史形态的差别：这份测试过去跑的是件源码（件当时还是 src/public 下的 vanilla JS，件以资产形态
// 随包分发、不进类型检查，故靠「执行源码 + 比对 kind 字面量」兜住漂移）。件迁进包并 TS 化后，kind
// 的真相源就是 protocol/float-host.ts，两侧 import 同一组常量、对齐由编译器守，那条防线随之退化为
// 一条「接错线」检查（见下）—— 真正的形状约束现在来自类型。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONTENT_PING_KIND,
  FLOAT_BUSY_KIND,
  FLOAT_COLLAPSE_KIND,
  FLOAT_HOST_HOOK_KEY,
  FLOAT_OPEN_KIND,
} from '../protocol/float-host'
import { clampPoint, installFloatHost, type FloatHostHook } from './install'

const PANEL_URL = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/floatpanel.html'
const EXTENSION_NAME = '测试扩展名'

interface StubEnv {
  hook: FloatHostHook
  warns: string[]
  addListener: ReturnType<typeof vi.fn>
}

/**
 * 在最小壳里装载件（件读裸全局，故装成全局再调安装函数 —— 与真注入同一条路径）。
 *
 * 默认 `documentElement: null` → init 走「等文档就绪再装观察器」那条分支，正好一并覆盖到；
 * warn 的监视范围包住装载与 run 全程：init 里的警告（世界没开 messaging）恰恰是最要紧的诊断出口。
 */
function stubEnv(
  run?: (hook: FloatHostHook) => void,
  opts: { runtime?: 'ok' | 'missing' } = {},
): StubEnv {
  const addListener = vi.fn()
  const warns: string[] = []
  vi.stubGlobal('window', {})
  // documentElement 为 null：init 里那条 DOMContentLoaded 兜底路径也一并跑到
  vi.stubGlobal('document', { documentElement: null, addEventListener: vi.fn() })
  vi.stubGlobal(
    'chrome',
    opts.runtime === 'missing' ? {} : { runtime: { onMessage: { addListener } } },
  )
  vi.stubGlobal(
    'MutationObserver',
    class {
      observe(): void {}
    },
  )
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(' '))
  })
  try {
    installFloatHost()
    const hook = (window as unknown as Record<string, FloatHostHook | undefined>)[
      FLOAT_HOST_HOOK_KEY
    ]
    if (!hook) throw new Error('件没有挂出世界级 hook')
    if (run) run(hook)
    return { hook, warns, addListener }
  } finally {
    spy.mockRestore()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dl-float-host（USER_SCRIPT 世界常驻件）· 世界级 hook', () => {
  it('装载即挂出 hook，三个口都在；装载本身不出声、不碰 DOM', () => {
    const { hook, warns } = stubEnv()
    expect(typeof hook.init).toBe('function')
    expect(typeof hook.clamp).toBe('function')
    expect(typeof hook.kinds).toBe('object')
    expect(warns).toEqual([])
    // 只装 hook，不建任何 DOM（页面里那份待命代码零 UI）
    expect(document.createElement).toBeUndefined()
  })

  it('kinds 四个口接的是各自那条指令（接错线时红）', () => {
    const { hook } = stubEnv()
    expect(hook.kinds).toEqual({
      open: FLOAT_OPEN_KIND,
      collapse: FLOAT_COLLAPSE_KIND,
      busy: FLOAT_BUSY_KIND,
      ping: CONTENT_PING_KIND,
    })
  })

  it('同一 realm 重复注入只装一遍（重注册 / 导航竞态）', () => {
    const first = stubEnv()
    first.hook.init(PANEL_URL, EXTENSION_NAME)
    expect(first.addListener).toHaveBeenCalledTimes(1)
    installFloatHost() // 第二次注入：hook 已在，直接返回
    expect(first.addListener).toHaveBeenCalledTimes(1)
  })
})

describe('dl-float-host · init 装配', () => {
  it('装消息面且幂等；ping 同步应答，其余未知 kind 静默', () => {
    const { addListener, warns } = stubEnv((hook) => {
      hook.init(PANEL_URL, EXTENSION_NAME)
      hook.init(PANEL_URL, EXTENSION_NAME) // 幂等：同一文档重复装配只生效一次
    })
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(warns).toEqual([]) // 装配正常时不该出声

    const listener = addListener.mock.calls[0]![0] as (
      raw: unknown,
      sender: unknown,
      respond: (r: unknown) => void,
    ) => void

    const respond = vi.fn()
    listener({ kind: CONTENT_PING_KIND }, {}, respond)
    expect(respond).toHaveBeenCalledWith({ ok: true })

    // 同一标签页的各个世界都会收到 tabs.sendMessage：不认识的 kind 一律静默（连应答都不做）
    const respond2 = vi.fn()
    listener({ kind: 'float:不存在的指令' }, {}, respond2)
    expect(respond2).not.toHaveBeenCalled()
  })

  it('非对象载荷（null / 字符串）静默，不炸', () => {
    const { addListener } = stubEnv((hook) => hook.init(PANEL_URL, EXTENSION_NAME))
    const listener = addListener.mock.calls[0]![0] as (raw: unknown) => void
    expect(() => listener(null)).not.toThrow()
    expect(() => listener('float:open')).not.toThrow()
  })

  it('世界未开 messaging（拿不到 chrome.runtime）时出声，不静默', () => {
    const { warns } = stubEnv((hook) => hook.init(PANEL_URL, EXTENSION_NAME), {
      runtime: 'missing',
    })
    expect(warns.some((w) => w.includes('messaging'))).toBe(true)
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
