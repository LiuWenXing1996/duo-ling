// 用户脚本运行时 SW 侧宿主：把 GM 运行时在 service worker 里的职责凑齐。
//
//   · 注册引擎（registration）—— chrome.userScripts 的世界配置 / 单脚本与全量注册 / 可用性检测；
//   · 可用性监视（availability-watch）—— SW 进程内轮询引擎可用性，只在状态翻转时通知消费层；
//   · 命令分发（dl-bridge）—— 脚本桥中继件发来的 GM 请求（storage / xhr / download / menu / …）；
//   · 事件底座（dl-port）—— 脚本世界 ↔ SW 的长连接下行通道（菜单点击 / 值变更 / 下载进度…）；
//   · cookie 域名门（cookie-gate）—— GM_cookie 的安全边界；
//   · require / resource 缓存 —— @require 与 @resource 的抓取与落库；
//   · IPC handler pack（management）—— 管理面只读四条，宿主总线注册；
//   · 宿主注入点（host-config）—— 扩展身份 / offscreen 就绪 / 遥测 / 密钥存储全部可选，
//     不注入 = 相应观测不发生，脚本行为不受损。
//
// 依赖方向：本包 → core（语义与存储）→ shared（契约），无环。

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
