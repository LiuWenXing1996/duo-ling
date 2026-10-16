// 内置件的注册面：注册 id 与产物文件名。
//
// 为什么集中在这里：件「自己声明自己」—— 消费方（engine.ts）只 import 本模块，不再各自
// 维护一份 id 与文件名。产物文件名必须与 esbuild.config.mjs 的入口表键一致（`<键>.js`），
// registry.test.ts 会比对两边，改名漏一处即红。
//
// 产物文件名不带目录前缀：构建脚本产出的 dist/*.js 由 wxt.config.ts 的 build:publicAssets
// 钩子原样落到扩展产物根，应用侧按文件名取内容作系统脚本源码。
//
// 注意：脚本桥中继件（relay）**不在本文件** —— 它已随 `@duoling/userscript-sw` 包内化
// （SCRIPT_RELAY_ID / buildRelayInit / syncScriptRelay 都在包的 relay/sync.ts，IIFE 以
// `{ code }` 字符串注册，无公共资产文件）。
// 三件内置件（录制 / 检查器 / 浮层宿主）都已转**系统脚本**（走统一注册链，见应用侧
// system-scripts.ts）：本文件只声明各自的 id 与产物文件名，不再有独立世界与装配段。

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

// —— 浮层宿主 · 常驻件（系统脚本，走统一注册链） ——

/** 注册 id（一个扩展一份；同时是系统脚本的固定 uuid —— 指令下发的寻址键） */
export const FLOAT_HOST_ID = 'dl-float-host'
/**
 * 产物文件名（构建自包内 src/float-host/entry.ts）。应用侧取其内容作系统脚本源码，
 * 并替换其中的 `__DL_FLOAT_PANEL_URL__` / `__DL_FLOAT_EXT_NAME__` 占位符
 * （浮层页地址与扩展显示名只有扩展侧取得到，而注册项是静态字符串）。
 * 历史形态是「独立 USER_SCRIPT 世界 + 两段注册（件文件 + 装配段递参）」，已随统一脚本链退役。
 */
export const FLOAT_HOST_FILE = 'duoling-float-host.js'
