// 用户脚本项目数据的底层存储已上移进 `@duoling/userscript-runtime`（state-db.ts，随内置
// 默认存储一起归包）；此处 re-export 维持既有 import 路径不变。
export * from '@duoling/userscript-runtime'
