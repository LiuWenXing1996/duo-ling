// 用户脚本「自己存的数据」的底层存储已上移进 `@duoling/userscript-runtime`（usdata-db.ts，
// 随内置默认存储一起归包）；此处 re-export 维持既有 import 路径不变。
export * from '@duoling/userscript-runtime'
