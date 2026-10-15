// 页面检查器的通道协议：下行指令信封 + 上行结果信封 + 拾取遮罩的类名。
//
// 与 protocol/page-context.ts 的分工：那边定义**载荷形状**（件造什么数据），这里定义**信封**
// （数据怎么传）。两侧共用同一组字面量 —— 消费方是件（inspector/install.ts）与应用侧
// page-inspector-bridge.ts，改名必须两边一起改。

/** 下行指令信封字段（SW 经 chrome.tabs.sendMessage 投递；件侧与发起侧共用同一字面量） */
export const INSPECTOR_CMD_TAG = '__dlInspectorCmd'
/** 上行结果信封字段（同上） */
export const INSPECTOR_RESULT_TAG = '__dlInspector'

/**
 * 件的三个工作模式。
 *
 * `cancel` 不在内：它不是一种读页面的模式，而是让进行中的拾取收工 —— 走同一条下行通道，
 * 但没有结果可等（那条 pick 的 Promise 自己 resolve null）。
 */
export type InspectorMode = 'pick' | 'snapshot' | 'env'

/**
 * 拾取高亮框的类名命名空间（件造遮罩时用，不污染页面样式）；遮罩本身是 `命名空间 + '-box'`。
 *
 * ⚠️ 跨世界契约：那个 `-box` 类名同时是浮层宿主件判定「拾取进行中」的信号 —— 拾取期间浮层
 * 必须藏起来（否则浮层挡住待选元素、自身还会被 elementFromPoint 命中而误选）。两个世界 JS
 * 隔离、DOM 共享，遮罩的生死即拾取区间。
 *
 * 浮层宿主尚未迁入本包（仍在 src/public/duoling-float-host.js），那边是小写的选择器字面量
 * `.duoling-picker-box`；它迁进来后改用本常量拼，这条手写链接届时才真正消失。
 */
export const INSPECTOR_PICKER_NS = 'duoling-picker'
