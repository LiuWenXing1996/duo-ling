// SW 进程包：本扩展在 service worker 里的全部代码，一个进程一个包。
//
//   · GM 运行时 SW 侧宿主 —— 注册引擎（registration）/ 可用性监视（availability-watch）/
//     require+resource 缓存 / 管理面 handler pack（management）/ 宿主注入点（host-config）；
//   · GM 侧实现件 —— 注入源码生成（gm-wrapper / gm-bridge-client）、GM 值存储（gm-values）、
//     usdata 库（usdata-db）：只有 SW 会生成并注册脚本，故贴在这里而不是共享层；

export * from './offscreen-reasons'
export * from './sw-link'
export * from './host-config'
export * from './registration'
export * from './availability-watch'
export * from './cookie-gate'
export * from './gm-fetch-priv'
export * from './gm-port'
export * from './gm-bridge'
export * from './require-cache'
export * from './resource-cache'
export * from './host'
export * from './management'
export * from './relay/sync'
export * from './gm-bridge-client'
export * from './gm-wrapper'
export * from './usdata-db'
export * from './gm-values'
export * from './offscreen'
// 产品面：观测 → 监控 → 系统件 → 注册同步 → 指令桥 → 遥测（按依赖方向排）
export * from './userscripts/runtime-db'
export * from './userscripts/store'
export * from './userscripts/tab-sessions'
export * from './userscripts/page-monitor'
export * from './userscripts/system-scripts'
export * from './userscripts/engine'
export * from './userscripts/page-inspector-bridge'
export * from './userscripts/pending-pick'
export * from './userscripts/telemetry'
