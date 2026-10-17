// 共享层唯一出口：跨世界契约 + 被三方同时消费的共享实现。
//
// 只放**两端必须逐字节一致**的东西 —— 信封标记、协议版本、超时、判别键、载荷形状，
// 以及摘要与脱敏这类「写侧剥一遍、读侧再剥一遍」必须同源的纯函数；另加放进应用侧或
// 任一进程包都会让另一方反向依赖的模块：脚本形状（script-config / script-project /
// userscript-runtime / userscript-shapes / project-store）、GM 语义（api-contract / gm-grants /
// gm-api-catalog / metadata）、状态库（state-db）、数据变更广播（data-broadcast 契约 +
// data-broadcast-runtime 实现）、跨进程服务契约（service/）、会话域（conversation /
// chat-assets / conversation-store / conversation-message / ui-message-parts）、
// 对话载荷与模型配置（chat-ipc / model）、Agent 工具目录（agent-tools-catalog）、
// 总线原语（runtime-send）、构建注入（build-info）。
//
// 边界：零 DOM 假设。碰宿主的有两处 —— data-broadcast-runtime 的降级通道与
// runtime-send 的总线原语，都只取 globalThis 上的结构形状，不吃 chrome 类型
// （本包 tsconfig 是 `types: []`）。
// 求值期纪律：模块顶层不做任何调用，派生值一律惰性 + 缓存。单文件产物下，
// 一句顶层调用就让打包器整块保留本模块 —— package.json 的 `sideEffects: false`
// 只在模块粒度生效，救不了文件内的语句。中继件的体积直接吃这条。
// 运行依赖只有 @webext-core/proxy-service（契约的代理工厂）；ai 只作类型来源
// （消息 parts 的形状），产物里不出现它的 import。
//
// 与 src/shared/ 的分工：那边是**应用内部**几个载体（SW / UI / offscreen）之间的信封，
// 自身依赖件包；这里是**跨世界 + 跨进程**共享面，被件包、进程包与应用共同消费。

export * from './bridge'
export * from './tab-record'
export * from './panel-monitor'
export * from './inspector'
export * from './page-context'
export * from './idb-core'
export * from './db'
export * from './data-broadcast'
export * from './data-broadcast-runtime'
export * from './ipc'
export * from './app'
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
export * from './conversation'
export * from './chat-assets'
export * from './conversation-store'
export * from './model'
export * from './chat-ipc'
export * from './build-info'
export * from './runtime-send'
export * from './agent-tools-catalog'
export * from './ui-message-parts'
export * from './conversation-message'
export * from './project-store'
export * from './userscript-runtime'
export * from './userscript-shapes'
export * from './service'
