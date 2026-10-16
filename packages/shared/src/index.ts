// 跨世界契约包的唯一出口：桥 / 录制 / 页面检查器 / 浮层宿主的信封、常量与形状。
//
// 只放**两端必须逐字节一致**的东西 —— 信封标记、协议版本、超时、判别键、载荷形状，
// 以及摘要与脱敏这类「写侧剥一遍、读侧再剥一遍」必须同源的纯函数。
//
// 为什么独立成包：这些常量被三方同时消费 —— 应用侧（SW / UI / 测试）、件包
// （@duoling/builtin-scripts 的 relay / recorder / inspector / float-host）、
// 以及用户脚本运行时的桥脚本侧。放在三方中任何一方，另外两方都得反向依赖它。
//
// 边界：零依赖、零 `chrome.*`、零 DOM 假设、无副作用 —— 只有形状与纯函数，不含宿主能力。
//
// 与 src/shared/ 的分工：那边是**应用内部**几个载体（SW / UI / offscreen）之间的信封，
// 自身依赖件包；这里是**跨世界**契约，被件包与应用共同消费。

export * from './bridge'
export * from './tab-record'
export * from './inspector'
export * from './page-context'
export * from './idb-core'
export * from './data-broadcast'
export * from './ipc'
export * from './media-types'
export * from './data-url'
export * from './archive-transfer'
