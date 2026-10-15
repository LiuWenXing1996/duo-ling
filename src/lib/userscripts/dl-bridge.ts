// GM 后台桥已上移进 `@duoling/userscript-runtime`（dl-bridge.ts）；本文件只剩
// re-export 维持既有 import 路径不变。
// 宿主注入（遥测 / offscreen 就绪 / 扩展身份）改由 background 调 createServiceWorkerHost
// 时显式传入（遥测对象见 ./telemetry.ts）—— 配置与监听注册同点完成，时序天然满足
// 「SW 顶层同步段」纪律。
export * from '@duoling/userscript-runtime'
