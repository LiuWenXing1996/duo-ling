// 标签页录制 · MAIN 世界件（机制层框架）。
//
// buildTabRecorderSource() 返回的字符串由 engine.ts 在注册 dl-tab-recorder 时注入页面
// MAIN 世界（world: 'MAIN'）。为什么必须 MAIN：要拦页面**自己**发出的请求/日志，
// 钩子只能挂在页面世界——USER_SCRIPT 世界是独立 realm，挂它的 window.fetch 拦不到。
//
// 本件只管**通道**，不管「录什么」：
//   · 信封形状（TAB_RECORD_TAG + kind + record）、出口 emit、幂等守卫、postMessage 目标；
//   · 各类信号的具体采法在**种类件**里（当前：net-probe.ts 的网络请求），
//     它们由本件插进同一作用域并逐个 install —— 加一类就是多插一段、多调一次，不改本件。
// 这样命名与职责才对得上：本件叫 `tab-record`（按页录制的框架），不叫 `net-*`。
//
// 设计硬边界（与 script-relay.ts 同款）：
//   - 无 chrome.*（MAIN 世界本就没有），采集后只靠同帧 window.postMessage 交给转发件；
//   - 与页面同级、无特权：页面看得见它做的一切；
//   - **不阻塞页面网络层**：这一条由种类件负责（本件只提供通道，不做任何采样）。

import { TAB_RECORD_TAG } from './tab-record-protocol'
import { buildNetProbeSource } from './net-probe'

export function buildTabRecorderSource(): string {
  return `
;(function () {
  var TAG = ${JSON.stringify(TAB_RECORD_TAG)}
  // 幂等：同一 realm 里被注入两次也只包一层（防重复注册 / 导航竞态）
  if (window.__dlTabRecorder) return
  window.__dlTabRecorder = true

  function origin() {
    try { return window.location.origin || '*' } catch (e) { return '*' }
  }

  /**
   * 种类件唯一的出口。信封三件套（TAG / kind / record）形状只在这里定，
   * 种类件不必知道 TAG 叫什么、也不必自己拼信封。
   */
  function emit(kind, record) {
    var m = { kind: kind, record: record }
    m[TAG] = true
    try { window.postMessage(m, origin()) } catch (e) { /* 页面卸载中 */ }
  }

  // 机制层交给种类件的三件。刻意只给这些：种类件的职责是「采样本类信号」，
  // 采样工具（读流 / 摘要 / 头处理）属各类自己的事，不在这里预置。
  var ctx = {
    emit: emit,
    now: function () { return Date.now() },
    origin: origin,
  }

${buildNetProbeSource()}

  installNetProbe(ctx)
})();`
}
