// logic 单测：clampFloatPoint —— 拖拽把浮层留在视口内（拖出屏幕就再也抓不回来，故这条是硬约束）。
import { describe, expect, it } from 'vitest'
import { clampFloatPoint } from './float-panel-drag'

const PANEL = { width: 384, height: 560 }
const VIEWPORT = { width: 1280, height: 800 }

describe('clampFloatPoint（落点夹进视口）', () => {
  it('视口内的落点原样保留', () => {
    expect(clampFloatPoint({ x: 100, y: 120 }, PANEL, VIEWPORT)).toEqual({ x: 100, y: 120 })
  })

  it('越过左 / 上边界：贴边（把手仍在屏内）', () => {
    expect(clampFloatPoint({ x: -50, y: -1 }, PANEL, VIEWPORT)).toEqual({ x: 0, y: 0 })
  })

  it('越过右 / 下边界：贴到反向边界，浮层整体不出屏', () => {
    expect(clampFloatPoint({ x: 9999, y: 9999 }, PANEL, VIEWPORT)).toEqual({
      x: VIEWPORT.width - PANEL.width,
      y: VIEWPORT.height - PANEL.height,
    })
  })

  it('恰好贴边：不越界也不回弹', () => {
    expect(
      clampFloatPoint(
        { x: VIEWPORT.width - PANEL.width, y: VIEWPORT.height - PANEL.height },
        PANEL,
        VIEWPORT,
      ),
    ).toEqual({ x: VIEWPORT.width - PANEL.width, y: VIEWPORT.height - PANEL.height })
  })

  it('浮层比视口还大：下界为负时取 0，贴左上而不是把浮层推到屏幕外', () => {
    expect(clampFloatPoint({ x: 10, y: 10 }, PANEL, { width: 300, height: 400 })).toEqual({
      x: 0,
      y: 0,
    })
  })
})
