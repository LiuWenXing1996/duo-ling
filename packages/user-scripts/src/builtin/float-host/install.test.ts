// float-host/install.ts 单测：件在 MAIN 世界系统脚本（GM 包装）里跑，这里用最小假全局把它跑起来，
//
// **件的 DOM 行为不在这里验** —— 挂容器、开合、拖拽、遮罩、拾取让位要真实渲染与事件流，最小桩
// 测不出（也容易把桩的行为当件的行为），由 e2e/float-task-state.spec.ts 用真浏览器覆盖。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clampPoint, installFloatHost } from './install'

function stubGlobals() {
  vi.stubGlobal('window', {})
  // documentElement 为 null：观察器走「等文档就绪再装」那条分支，一并覆盖到
  vi.stubGlobal('document', { documentElement: null, addEventListener: vi.fn() })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('dl-float-host（MAIN 世界系统脚本）· 安装', () => {
  it('内核不在（typeof DL 未定义）：不抛，只是没注册打开命令', () => {
    stubGlobals()
    expect(() => installFloatHost()).not.toThrow()
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
