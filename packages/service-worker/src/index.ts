// SW 进程包：本扩展在 service worker 里的全部代码，一个进程一个包。
//
//   · GM 运行时 SW 侧宿主 —— 注册引擎（registration）/ 可用性监视（availability-watch）/
//     命令分发（dl-bridge）/ 事件底座（dl-port）/ cookie 域名门（cookie-gate）/
//     require+resource 缓存 / 管理面 handler pack（management）/ 宿主注入点（host-config）；
//   · GM 侧实现件 —— 注入源码生成（gm-wrapper / script-bridge）、GM 值存储（gm-values）、
//     usdata 库（usdata-db）：只有 SW 会生成并注册脚本，故贴在这里而不是共享层；
//   · 本扩展的 SW 侧进程内服务实体（SWService）—— 保活探针，契约在 @duoling/shared；
//   · offscreen 容器的能力约定（GM_OFFSCREEN_REASONS）—— SW 建文档时取用。
//
// 依赖方向：本包 → shared（跨世界契约 / GM 语义 / 存储 / 服务契约），无环。
// offscreen 进程侧的包是 @duoling/offscreen-document，与本包**互不 import**：跨进程只有
// chrome.runtime 消息一条路（服务代理报文 / 总线命令）。

export * from './offscreen-reasons'
export * from './sw-service'
export * from './host-config'
export * from './registration'
export * from './availability-watch'
export * from './cookie-gate'
export * from './dl-fetch-priv'
export * from './dl-port'
export * from './dl-bridge'
export * from './require-cache'
export * from './resource-cache'
export * from './util'
export * from './host'
export * from './management'
export * from './relay/sync'
export * from './script-bridge'
export * from './gm-wrapper'
export * from './usdata-db'
export * from './gm-values'
