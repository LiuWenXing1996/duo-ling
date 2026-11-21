// 页面检查器的通道协议：拾取遮罩的类名（信封已随脚本桥协议走 —— 下行 `inspector.cmd` 事件帧、
//
// 与 page-context.ts 的分工：那边定义**载荷形状**（件造什么数据），这里定义页面可见的约定。

/**
 * 件的工作模式。
 *
 * `cancel` 不在内：它不是一种读页面的模式，而是让进行中的拾取收工 —— 走同一条下行通道，
 * 但没有结果可等（那条 pick 的 Promise 自己 resolve null）。
 */
export type InspectorMode = 'pick' | 'snapshot' | 'env' | 'frame'

export const INSPECTOR_PICKER_NS = 'duoling-picker'
