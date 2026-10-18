// build.mjs 的类型面：包内 TS 源码（registry.test.ts）import 它时供 tsc 解析（本包 allowJs 关闭）。
// 只声明被 import 的导出；构建执行体无类型面需求。
export const BUILTIN_ENTRY_POINTS: Record<string, string>
