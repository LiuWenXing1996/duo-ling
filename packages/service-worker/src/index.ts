// SW 进程包：本扩展在 service worker 里的全部代码，一个进程一个包。
//
//   · GM 运行时 SW 侧宿主 —— 注册引擎（registration）/ 可用性监视（availability-watch）/
//     命令分发（dl-bridge）/ 事件底座（dl-port）/ cookie 域名门（cookie-gate）/
//     require+resource 缓存 / 管理面 handler pack（management）/ 宿主注入点（host-config）；
//   · GM 侧实现件 —— 注入源码生成（gm-wrapper / script-bridge）、GM 值存储（gm-values）、
//     usdata 库（usdata-db）：只有 SW 会生成并注册脚本，故贴在这里而不是共享层；

//   · offscreen 容器的生命周期管理（offscreen）与能力约定（GM_OFFSCREEN_REASONS）；
//   · 本扩展的产品面（userscripts/）—— 观测数据写出口（store / runtime-db / tab-sessions）、
//     页面脚本监控（page-monitor）、系统件注册同步（system-scripts / engine）、
//     两类指令桥（page-inspector-bridge / float-bridge）与遥测 port（telemetry）。
//
// 依赖方向：本包 → shared（跨世界契约 / GM 语义 / 存储 / 服务契约）+ user-scripts/builtin
// （系统件的注册 id 与产物文件名，只有常量、不带件本体），无环。

export * from './offscreen-reasons'
export * from './sw-link'
export * from './host-config'
export * from './registration'
export * from './availability-watch'
export * from './cookie-gate'
export * from './dl-fetch-priv'
export * from './dl-port'
export * from './dl-bridge'
export * from './require-cache'
export * from './resource-cache'
export * from './host'
export * from './management'
export * from './relay/sync'
export * from './script-bridge'
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
export * from './userscripts/float-bridge'
export * from './userscripts/telemetry'
