// 浮层宿主常驻件 · 装配侧（注册时 `js` 的第二段）。
//
// 件的本体是 src/public/duoling-float-host.js —— vanilla IIFE，不进打包链路（src/public/ 随包
// 分发到产物根），组件逻辑与注释都在那份文件里。本模块只持「注册要用的三样 + 装配段源码」。
//
// 装配段存在的理由：注册项是**静态字符串**，而件要用到两样只有扩展侧才取得到的值 ——
//   · 浮层页地址（`chrome.runtime.getURL`）
//   · 扩展显示名（EXTENSION_NAME，改名的唯一真相源在 lib/extension-identity.ts）
// 件自己写死会漂移（改名漏改 / 地址带扩展 id），故在装配时当参数递进去。
//
// 与页面检查器（page-inspector-host.ts）同形：`js: [{ file }, { code }]` 两段落在**同一世界**，前一段定义
// `window.__duolingFloatHost`，后一段调它的 init。顺序不能换。
//
// ⚠️ 契约：件的指令 kind 是手写字符串（vanilla JS 不在类型检查范围内），与
// shared/extension-ipc.ts 常量的对齐由单测把守 —— float-host-source.test.ts 会真的执行件源码
// 再逐条比对（件改 kind 而契约没跟，测试即红）。

import { EXTENSION_NAME } from '@/lib/extension-identity'

/** 常驻件的注册 id（一个扩展一份） */
export const FLOAT_HOST_ID = 'dl-float-host'
/**
 * 常驻件的独立世界 id。
 *
 * 必须单独 `configureWorld({ messaging: true })`：自定义世界**不继承**默认世界的配置（与中继件 /
 * 页面检查器 / 录制转发件同一个坑），没配则该世界里没有 chrome.runtime，指令收不到、件形同不存在。
 */
export const FLOAT_HOST_WORLD_ID = 'us-dl-float'
/** 宿主件文件（src/public/ 随包分发到产物根）：常驻注册的第一段 */
export const FLOAT_HOST_FILE = 'duoling-float-host.js'

/** 浮层页文件（`?tab=` 由件按指令里的 tabId 自行补，见 FloatOpenRequest） */
export const FLOAT_PANEL_FILE = 'floatpanel.html'

/** 浮层页的扩展内地址（须在 web_accessible_resources 里，见 wxt.config.ts） */
export function floatPanelUrl(): string {
  return chrome.runtime.getURL(FLOAT_PANEL_FILE)
}

/**
 * 装配段源码：把运行期才知道的两样值递进件里再装配。
 *
 * 取不到 `window.__duolingFloatHost` = 两段 js 没落在同一世界（装配错误，浮层会静默挂不出来），
 * 故明确报一声 —— 与页面检查器件缺运行器时同样出声。
 */
export function buildFloatHostInit(panelUrl: string): string {
  return `
;(function () {
  var host = window.__duolingFloatHost
  if (!host) {
    console.warn('[duoling:float] 宿主件未装配到本世界，浮层不可用')
    return
  }
  host.init(${JSON.stringify(panelUrl)}, ${JSON.stringify(EXTENSION_NAME)})
})()`
}
