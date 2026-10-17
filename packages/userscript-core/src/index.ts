// 用户脚本语义与存储内核：把 GM API 的「语义」变成可共享的真相。
//
// 三块：
//   · 语义层（L1，零 chrome / 零 IDB / 零 DOM）—— 注入源码生成、API 契约与目录、grants 真相源、
//     metadata 解析（脚本配置与项目形状归 shared）；
//   · 存储（IDB）—— 内置默认存储（state-db / usdata-db / gm-values），IndexedDB 样板
//     （idb-core）归 @duoling/shared（纯样板，应用域同源共用）；
//   · 数据变更广播 —— 跨语境广播的唯一实现（BroadcastChannel 优先、sendMessage 降级），
//     应用侧与包内写出口（gm-values）共用同一条线。
//
// 依赖方向：sw / offscreen → 本包 → shared（无环）。契约名归 shared，本包只管实现侧。

// —— 语义层（L1）——
export * from './api-contract'
export * from './gm-grants'
export * from './gm-api-catalog'
export * from './gm-wrapper'
export * from './script-bridge'
export * from './match-pattern'
export * from './match-union'
export * from './metadata'

// —— 存储 ——
export * from './state-db'
export * from './usdata-db'
export * from './gm-values'

// —— 数据变更广播 ——
export * from './data-broadcast'
