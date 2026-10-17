// 扩展两侧（SW 与扩展页）都要用的应用侧实现：小数据 kv、模型配置、构建自证、更新检查、
// 归属映射、页面检查器客户端、抓包摘要。
//
// 为什么在契约包而不是 UI 包：SW 的 background.ts 直接调它们（读模型、写更新检查、查归属），
// 放 UI 包会让进程侧反向依赖前端包 —— 前端包一旦被换掉、或它把 Vue 拖进 SW 产物，
// 就是运行期才炸的错误。判据与 shared 既有那批一致：**被两个进程同时消费 + 零 chrome 类型**。
export * from './app-db'
export * from './build-info'
export * from './conversation-tab-map'
export * from './element-picker-client'
export * from './key-cipher'
export * from './model-store'
export * from './net-digest'
export * from './update-check'
export * from './web-hostname'
