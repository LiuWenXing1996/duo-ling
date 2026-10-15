// DL Port 事件底座已上移进 `@duoling/userscript-runtime`（dl-port.ts）；此处 re-export
// 维持既有 import 路径不变。GM 值变更事件源走包内 gm-values 枢纽。
export * from '@duoling/userscript-runtime'
