// 用户脚本运行时：把 GM API 变成真的。
//
// 两层：
//   · 语义层（L1，零 chrome / 零 IDB / 零 DOM）—— 注入源码生成、API 契约与目录、grants 真相源、
//     metadata 解析与脚本配置形状；
//   · 宿主层（L2，SW 侧）—— 命令分发（dl-bridge）、事件底座（dl-port）、cookie 域名门
//     （cookie-gate）、内置默认存储（idb-core / state-db / usdata-db / gm-values）与数据变更广播。
//     chrome 由扩展环境提供（SW 全局）；应用耦合收敛为注入点（host-config.ts）：
//     扩展身份 / offscreen 就绪 / 遥测全部可选，不注入 = 相应观测不发生，脚本行为不受损。
//
// 依赖方向：src → userscript-runtime → shared（无环）。契约名归 shared，本包只管实现侧。

// —— 语义层（L1）——
export * from './api-contract'
export * from './gm-grants'
export * from './gm-api-catalog'
export * from './gm-wrapper'
export * from './script-bridge'
export * from './script-config'
export * from './match-pattern'
export * from './metadata'
export * from './script-project'

// —— 宿主层（L2）——
export * from './idb-core'
export * from './state-db'
export * from './usdata-db'
export * from './gm-values'
export * from './data-broadcast'
export * from './cookie-gate'
export * from './dl-fetch-priv'
export * from './dl-port'
export * from './dl-bridge'
export * from './host-config'
export * from './util'
