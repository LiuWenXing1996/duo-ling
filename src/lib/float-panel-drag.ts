// 浮层拖拽的落点算术（纯函数，不碰 DOM）。
//
// 为什么单独一处：把手（顶栏）在 iframe 里，被定位的容器在父页内容脚本手里，抓取与落点换算
// 天然分居两侧（见 src/entrypoints/app/ChatApp.vue 与 src/entrypoints/content.ts）。
// 换算放在这里是为了能单测 —— 内容脚本整段不可测（entrypoints 不进 vitest）。

/** 视口坐标下的一个点（CSS px，原点 = 视口左上角） */
export interface FloatPoint {
  x: number
  y: number
}

/** 一块矩形尺寸 */
export interface FloatSize {
  width: number
  height: number
}

/**
 * 把浮层落点夹进视口。
 *
 * 这是拖拽唯一的硬约束：不夹的话，浮层被拖出屏幕边缘后把手（顶栏）也跟着出屏，
 * 用户再也抓不回来 —— 只能重载页面复位。
 *
 * 浮层比视口还大时右 / 下界算出来是负数，此时取 0 贴左上，至少保证把手可见
 * （面板尺寸本身也按视口收过，见 content.ts 的 FLOAT_CSS）。
 */
export function clampFloatPoint(point: FloatPoint, panel: FloatSize, viewport: FloatSize): FloatPoint {
  return {
    x: Math.min(Math.max(point.x, 0), Math.max(viewport.width - panel.width, 0)),
    y: Math.min(Math.max(point.y, 0), Math.max(viewport.height - panel.height, 0)),
  }
}
