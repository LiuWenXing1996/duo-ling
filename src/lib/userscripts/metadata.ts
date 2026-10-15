// 用户脚本 metadata 块解析已上移进 `@duoling/userscript-runtime`（metadata.ts：解析与归一化
// 是运行期语义，归运行时包）；本文件仅作路径兼容桶。
// 消费方：engine / background / project-write / zip-transfer / script-tools / 面板。
export * from '@duoling/userscript-runtime'
