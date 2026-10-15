// esbuild.config.mjs 的类型声明：本仓未开 allowJs，.mjs 不参与类型检查，而产物名比对用例
// 要 import 它（registry.test.ts）—— 声明用到的导出即可（与 scripts/*.d.mts 同规）。
export declare const OUT_DIR: string
export declare const ENTRY_POINTS: Record<string, string>
export declare const buildOptions: Record<string, unknown>
