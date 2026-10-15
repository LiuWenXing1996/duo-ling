// 内置件的注册面：注册 id、独立世界 id、产物文件名、装配段构建器。
//
// 为什么集中在这里：件「自己声明自己」—— 消费方（engine.ts）只 import 本模块，不再各自
// 维护一份 id 与文件名。产物文件名必须与 esbuild.config.mjs 的入口表键一致（`<键>.js`），
// registry.test.ts 会比对两边，改名漏一处即红。
//
// 产物文件名不带目录前缀：构建脚本产出的 dist/*.js 由 wxt.config.ts 的 build:publicAssets
// 钩子原样落到扩展产物根，`{ file }` 就写这个裸文件名。

import { BRIDGE_RELAY_BOOT_KEY } from './protocol/bridge'

// —— 脚本主世界桥 · 中继件 ——

/** 注册 id（一个扩展一份） */
export const SCRIPT_RELAY_ID = 'dl-script-relay'
/** 独立世界 id：必须 configureWorld({ messaging: true })，否则世界内无 chrome.runtime */
export const SCRIPT_RELAY_WORLD_ID = 'us-dl-bridge'
/** 产物文件名（构建自包内 src/relay/entry.ts） */
export const SCRIPT_RELAY_FILE = 'duoling-relay.js'

/**
 * 中继件的装配段：运行器文件注入后由本段把运行期密钥递进去。
 *
 * 为什么必须两段：secret 每扩展一把、运行期才生成，塞不进文件；而 chrome.userScripts 的
 * js[] 只认 `{ file }` 与 `{ code }` 两种注入，两者按数组顺序在同一世界执行 —— 于是
 * 「文件装运行器 + 本段递参数」是唯一形态。
 *
 * 运行器缺失（两段没落在同一世界 / 文件没进产物）是装配错误，这里出声而不是静默：
 * 静默的话脚本侧只能等 GM 调用超时，看不出是装配问题。
 */
export function buildRelayInit(secret: string): string {
  const key = JSON.stringify(BRIDGE_RELAY_BOOT_KEY)
  return `;(function () {
  var boot = window[${key}]
  if (typeof boot !== 'function') {
    console.warn('[duoling:relay] 中继件运行器未装配到本世界，GM 桥不可用')
    return
  }
  boot(${JSON.stringify(secret)})
})()`
}

// —— 标签页录制 · MAIN 捕获件 + USER_SCRIPT 转发件 ——

/** MAIN 捕获件注册 id（一个扩展一份） */
export const TAB_RECORDER_ID = 'dl-tab-recorder'
/** USER_SCRIPT 转发件注册 id（一个扩展一份） */
export const TAB_FORWARDER_ID = 'dl-tab-forwarder'
/** 转发件的独立世界 id：必须 configureWorld({ messaging: true })，否则世界内无 chrome.runtime */
export const TAB_FORWARDER_WORLD_ID = 'us-dl-tab'
/** 捕获件产物文件名（构建自包内 src/recorder/entry.ts） */
export const TAB_RECORDER_FILE = 'duoling-recorder.js'
/** 转发件产物文件名（构建自包内 src/forwarder/entry.ts） */
export const TAB_FORWARDER_FILE = 'duoling-forwarder.js'

// —— 页面检查器 · 常驻件 ——

/** 注册 id（一个扩展一份） */
export const INSPECTOR_HOST_ID = 'dl-page-inspector'
/** 独立世界 id：必须 configureWorld({ messaging: true })，否则世界内无 chrome.runtime */
export const INSPECTOR_HOST_WORLD_ID = 'us-builtin-inspector'
/**
 * 产物文件名（构建自包内 src/inspector/entry.ts）。
 *
 * 与中继件不同，注册时**只有这一段**（无装配段）—— 件没有运行期参数，注入即安装；
 * 指令信封的字面量由件自己从 protocol/inspector.ts import。
 */
export const INSPECTOR_HOST_FILE = 'duoling-page-inspector.js'
