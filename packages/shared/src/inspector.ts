// 页面检查器的通道协议：拾取遮罩的类名（信封已随脚本桥协议走 —— 下行 `inspector.cmd` 事件帧、
// 上行 `inspector.result` __dlEvent 信封，字面量都在 shared 的 api-contract.ts）。
//
// 与 page-context.ts 的分工：那边定义**载荷形状**（件造什么数据），这里定义页面可见的约定。

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
 * 消费方是件包的两个件（inspector/install.ts 造遮罩、float-host/install.ts 拼选择器）直接
 * 引用本常量 —— 改名只需改这里一处，不再有手写链接。
 */
export const INSPECTOR_PICKER_NS = 'duoling-picker'
