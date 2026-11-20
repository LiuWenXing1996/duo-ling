// —— 标签页录制 · MAIN 捕获件（系统脚本，走统一注册链） ——

/** 注册 id（一个扩展一份；同时是系统脚本的固定 uuid） */
export const TAB_RECORDER_ID = 'dl-tab-recorder'
/** 产物文件名（构建自包内 src/builtin/recorder/entry.ts；应用侧取其内容作系统脚本源码） */
export const TAB_RECORDER_FILE = 'duoling-recorder.js'

// —— 页面检查器 · 常驻件（系统脚本，走统一注册链） ——

/** 注册 id（一个扩展一份；同时是系统脚本的固定 uuid —— 指令下发的寻址键） */
export const INSPECTOR_HOST_ID = 'dl-page-inspector'
/**
 * 产物文件名（构建自包内 src/builtin/inspector/entry.ts）。应用侧取其内容作系统脚本源码。
 * 件没有运行期参数，注入即装通道；指令信封的字面量随脚本桥协议（api-contract），
 * 不再有独立世界（MAIN 世界只读观察，DOM 本就共享）。
 */
export const INSPECTOR_HOST_FILE = 'duoling-page-inspector.js'
