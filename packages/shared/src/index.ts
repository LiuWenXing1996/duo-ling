// 共享层唯一出口：跨世界契约 + 被三方同时消费的共享实现。
//
// 只放**两端必须逐字节一致**的东西 —— 信封标记、协议版本、超时、判别键、载荷形状，
// 以及摘要与脱敏这类「写侧剥一遍、读侧再剥一遍」必须同源的纯函数；另加放进应用侧或
// 任一进程包都会让另一方反向依赖的模块：脚本形状（script-config / script-project）、
// GM 语义（api-contract / gm-grants / gm-api-catalog / metadata）、状态库（state-db）、
// 数据变更广播（data-broadcast 契约 + data-broadcast-runtime 实现）、跨进程服务契约（service/）。
//
// 边界：零 DOM 假设。唯一碰宿主的是 data-broadcast-runtime 的降级通道 —— 它取
// globalThis 上的结构形状，不吃 chrome 类型（本包 tsconfig 是 `types: []`）。
// 唯一的第三方依赖是 @webext-core/proxy-service（契约的代理工厂）。
//
// 与 src/shared/ 的分工：那边是**应用内部**几个载体（SW / UI / offscreen）之间的信封，
// 自身依赖件包；这里是**跨世界 + 跨进程**共享面，被件包、进程包与应用共同消费。

export * from './bridge'
export * from './tab-record'
export * from './inspector'
export * from './page-context'
export * from './idb-core'
export * from './data-broadcast'
export * from './data-broadcast-runtime'
export * from './ipc'
export * from './media-types'
export * from './data-url'
export * from './archive-transfer'
export * from './extension-identity'
export * from './error-text'
export * from './script-config'
export * from './script-project'
export * from './api-contract'
export * from './gm-grants'
export * from './gm-api-catalog'
export * from './match-pattern'
export * from './match-union'
export * from './metadata'
export * from './state-db'
export * from './service'
