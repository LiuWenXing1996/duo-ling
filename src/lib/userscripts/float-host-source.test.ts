// 防漂移单测：浮层宿主件（src/public/duoling-float-host.js）←→ 扩展侧契约。
//
// 件是手写的 vanilla JS，**不进类型检查**：改了件里的 kind 字面量而 extension-ipc 没跟（或反过来），
// typecheck 一声不响，要等真机 / e2e 才红。故这里把件源码**真的执行一遍**，拿它挂出来的
// `window.__duolingFloatHost` 反射真实取值，与契约常量逐条比对 —— 与 gm-api-catalog.test.ts 反射
// 注入源码同一套思路，只是这份直接跑、不走正则。
//
// 执行面只给最小壳（window / document / chrome / MutationObserver 皆作参数传入），故本文件在 node
// 环境下跑得动、不需要 DOM。**件的 DOM 行为不在这里验** —— 挂容器、开合、拖拽、遮罩、拾取让位
// 由 e2e/float-task-state.spec.ts 用真浏览器覆盖。
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  CONTENT_PING_REQUEST,
  FLOAT_BUSY_REQUEST_KIND,
  FLOAT_COLLAPSE_REQUEST,
  floatOpenRequest,
} from '../../shared/extension-ipc'
import { EXTENSION_NAME } from '../extension-identity'
import { buildFloatHostInit, FLOAT_HOST_FILE } from './float-host-source'

// 路径从本文件位置推出，不写死项目根（见 AGENTS.md 的路径约束）
const HOST_SRC = readFileSync(new URL(`../../public/${FLOAT_HOST_FILE}`, import.meta.url), 'utf8')
const PANEL_URL = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/floatpanel.html'

interface Point {
  x: number
  y: number
}
interface Size {
  width: number
  height: number
}
/** 件挂在 `window.__duolingFloatHost` 上的三个口（只有这三个，其余都关在闭包里） */
interface FloatHostHook {
  init: (url?: unknown, name?: unknown) => void
  clamp: (point: Point, panel: Size, viewport: Size) => Point
  kinds: Record<string, string>
}

/**
 * 在最小壳里执行件源码。
 *
 * `run` 会连同装载一起落在 console.warn 的监视范围内 —— init 里的警告（世界没开 messaging）
 * 恰恰是最要紧的诊断出口，必须收得到，故不能只监视装载那一段。
 */
function loadHost(
  run?: (hook: FloatHostHook) => void,
  opts: { runtime?: 'ok' | 'missing' } = {},
): { hook: FloatHostHook; warns: string[]; addListener: ReturnType<typeof vi.fn> } {
  const win: Record<string, unknown> = {}
  // documentElement 为 null → init 走「等文档就绪再装观察器」那条分支，正好一并覆盖到
  const doc = { documentElement: null, addEventListener: vi.fn() }
  const addListener = vi.fn()
  const chromeStub = opts.runtime === 'missing' ? {} : { runtime: { onMessage: { addListener } } }
  const warns: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(' '))
  })
  try {
    new Function('window', 'document', 'chrome', 'MutationObserver', HOST_SRC)(
      win,
      doc,
      chromeStub,
      class {
        observe(): void {}
      },
    )
    const hook = win.__duolingFloatHost as FloatHostHook
    if (run) run(hook)
    return { hook, warns, addListener }
  } finally {
    spy.mockRestore()
  }
}

describe('浮层宿主件 · 指令 kind 与契约对齐', () => {
  it('件的 KINDS 与 extension-ipc 的 kind 逐条相同（改一处必须两处一起改）', () => {
    const { hook } = loadHost()
    expect(hook.kinds).toEqual({
      open: floatOpenRequest(1).kind,
      collapse: FLOAT_COLLAPSE_REQUEST.kind,
      busy: FLOAT_BUSY_REQUEST_KIND,
      ping: CONTENT_PING_REQUEST.kind,
    })
  })

  it('装载即挂出钩子，三个口都在（件不在类型检查内，形状错了只能靠这条抓）', () => {
    const { hook, warns } = loadHost()
    expect(typeof hook.init).toBe('function')
    expect(typeof hook.clamp).toBe('function')
    expect(typeof hook.kinds).toBe('object')
    expect(warns).toEqual([]) // 装载本身不该出声
  })
})

describe('浮层宿主件 · 装配段', () => {
  it('把浮层页地址与扩展显示名递进件里（两样都只有扩展侧取得到）', () => {
    const init = vi.fn()
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(' '))
    })
    try {
      new Function('window', buildFloatHostInit(PANEL_URL))({
        __duolingFloatHost: { init },
      })
    } finally {
      spy.mockRestore()
    }
    expect(init).toHaveBeenCalledWith(PANEL_URL, EXTENSION_NAME)
    expect(warns).toEqual([])
  })

  it('件没装到本世界（两段 js 没落在同一世界）时出声，不静默', () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warns.push(a.map(String).join(' '))
    })
    try {
      new Function('window', buildFloatHostInit(PANEL_URL))({})
    } finally {
      spy.mockRestore()
    }
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('宿主件未装配')
  })
})

describe('浮层宿主件 · init 装配', () => {
  it('装消息面且幂等；ping 同步应答 pong，其余 kind 静默', () => {
    const { addListener, warns } = loadHost((hook) => {
      hook.init(PANEL_URL, EXTENSION_NAME)
      hook.init(PANEL_URL, EXTENSION_NAME) // 幂等：同一文档重复装配只装一遍
    })
    expect(addListener).toHaveBeenCalledTimes(1)
    expect(warns).toEqual([]) // 装配正常时不该出声

    const listener = addListener.mock.calls[0]![0] as (
      raw: unknown,
      sender: unknown,
      respond: (r: unknown) => void,
    ) => void

    const respond = vi.fn()
    listener({ kind: CONTENT_PING_REQUEST.kind }, {}, respond)
    expect(respond).toHaveBeenCalledWith({ ok: true })

    // 同一标签页的各个世界都会收到 tabs.sendMessage：不认识的 kind 一律静默（连应答都不做）
    const respond2 = vi.fn()
    listener({ kind: 'float:不存在的指令' }, {}, respond2)
    expect(respond2).not.toHaveBeenCalled()
  })

  it('世界未开 messaging（拿不到 chrome.runtime）时出声，不静默', () => {
    const { warns } = loadHost((hook) => hook.init(PANEL_URL, EXTENSION_NAME), {
      runtime: 'missing',
    })
    expect(warns.some((w) => w.includes('messaging'))).toBe(true)
  })
})

describe('浮层宿主件 · clamp（拖拽落点夹进视口）', () => {
  const PANEL: Size = { width: 384, height: 560 }
  const VIEWPORT: Size = { width: 1280, height: 800 }

  it('视口内的落点原样保留', () => {
    const { hook } = loadHost()
    expect(hook.clamp({ x: 100, y: 120 }, PANEL, VIEWPORT)).toEqual({ x: 100, y: 120 })
  })

  it('越过左 / 上边界：贴边（把手仍在屏内）', () => {
    const { hook } = loadHost()
    expect(hook.clamp({ x: -50, y: -1 }, PANEL, VIEWPORT)).toEqual({ x: 0, y: 0 })
  })

  it('越过右 / 下边界：贴到反向边界，浮层整体不出屏', () => {
    const { hook } = loadHost()
    expect(hook.clamp({ x: 9999, y: 9999 }, PANEL, VIEWPORT)).toEqual({
      x: VIEWPORT.width - PANEL.width,
      y: VIEWPORT.height - PANEL.height,
    })
  })

  it('恰好贴边：不越界也不回弹', () => {
    const { hook } = loadHost()
    expect(
      hook.clamp(
        { x: VIEWPORT.width - PANEL.width, y: VIEWPORT.height - PANEL.height },
        PANEL,
        VIEWPORT,
      ),
    ).toEqual({ x: VIEWPORT.width - PANEL.width, y: VIEWPORT.height - PANEL.height })
  })

  it('浮层比视口还大：下界为负时取 0，贴左上而不是把浮层推到屏幕外', () => {
    const { hook } = loadHost()
    expect(hook.clamp({ x: 10, y: 10 }, PANEL, { width: 300, height: 400 })).toEqual({ x: 0, y: 0 })
  })
})
