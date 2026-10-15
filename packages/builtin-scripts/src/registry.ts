// 内置件的注册面：注册 id、独立世界 id、产物文件名、装配段构建器。
//
// 为什么集中在这里：件「自己声明自己」—— 消费方（engine.ts）只 import 本模块，不再各自
// 维护一份 id 与文件名。产物文件名必须与 esbuild.config.mjs 的入口表键一致（`<键>.js`），
// registry.test.ts 会比对两边，改名漏一处即红。
//
// 产物文件名不带目录前缀：构建脚本产出的 dist/*.js 由 wxt.config.ts 的 build:publicAssets
// 钩子原样落到扩展产物根，`{ file }` 就写这个裸文件名。
//
// 注意：脚本桥中继件（relay）**不在本文件** —— 它已随 `@duoling/userscript-runtime` 包内化
// （SCRIPT_RELAY_ID / SCRIPT_RELAY_WORLD_ID / buildRelayInit / syncScriptRelay 都在包的
// relay/sync.ts，IIFE 以 `{ code }` 字符串注册，无公共资产文件）。
// 标签页录制件已转**系统脚本**（走统一注册链，见应用侧 system-scripts.ts）：本文件只声明
// 它的 id 与产物文件名，不再有独立世界与装配段。

import { FLOAT_HOST_HOOK_KEY } from '@duoling/shared'

// —— 标签页录制 · MAIN 捕获件（系统脚本，走统一注册链） ——

/** 注册 id（一个扩展一份；同时是系统脚本的固定 uuid） */
export const TAB_RECORDER_ID = 'dl-tab-recorder'
/** 产物文件名（构建自包内 src/recorder/entry.ts；应用侧取其内容作系统脚本源码） */
export const TAB_RECORDER_FILE = 'duoling-recorder.js'

// —— 页面检查器 · 常驻件（系统脚本，走统一注册链） ——

/** 注册 id（一个扩展一份；同时是系统脚本的固定 uuid —— 指令下发的寻址键） */
export const INSPECTOR_HOST_ID = 'dl-page-inspector'
/**
 * 产物文件名（构建自包内 src/inspector/entry.ts）。应用侧取其内容作系统脚本源码。
 * 件没有运行期参数，注入即装通道；指令信封的字面量随脚本桥协议（api-contract），
 * 不再有独立世界（MAIN 世界只读观察，DOM 本就共享）。
 */
export const INSPECTOR_HOST_FILE = 'duoling-page-inspector.js'

// —— 浮层宿主 · 常驻件 ——

/** 注册 id（一个扩展一份） */
export const FLOAT_HOST_ID = 'dl-float-host'
/**
 * 独立世界 id：必须单独 `configureWorld({ messaging: true })` —— 自定义世界不继承默认世界的配置
 * （与中继件 / 页面检查器 / 录制转发件同一个坑），没配则该世界里没有 chrome.runtime，指令收不到、
 * 件形同不存在。
 */
export const FLOAT_HOST_WORLD_ID = 'us-dl-float'
/** 产物文件名（构建自包内 src/float-host/entry.ts） */
export const FLOAT_HOST_FILE = 'duoling-float-host.js'

/**
 * 浮层宿主件的装配段：件装好后把两样运行期值递进去调 init。
 *
 * **与页面检查器不同，本件必须两段**（页面检查器没有运行期参数，已合并单段）：件要用浮层页地址
 * （`chrome.runtime.getURL`）与扩展显示名（`EXTENSION_NAME`，真相源在应用侧
 * lib/extension-identity.ts），两样都只有扩展侧取得到，而注册项是**静态字符串** —— 值由应用侧取好
 * 当参数传进来，本包因此不认识 `chrome.*`、也不认识扩展身份。
 *
 * 件没装到本世界（两段没落在同一世界 / 文件没进产物）是装配错误，这里出声而不是静默 ——
 * 静默的话浮层只会「点了没反应」。与中继件同形。
 */
export function buildFloatHostInit(panelUrl: string, extensionName: string): string {
  const key = JSON.stringify(FLOAT_HOST_HOOK_KEY)
  return `;(function () {
  var host = window[${key}]
  if (!host) {
    console.warn('[duoling:float] 宿主件未装配到本世界，浮层不可用')
    return
  }
  host.init(${JSON.stringify(panelUrl)}, ${JSON.stringify(extensionName)})
})()`
}
