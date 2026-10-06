// scripts/probe-target.mjs 的类型声明：端测从 TS 里 import 靶站，需要这份声明才能过类型检查
// （scripts/ 不在 tsconfig 的 include 里，allowJs 也未开）。契约见该 .mjs 的注释。

export declare const DEFAULT_PORT: number
export declare const TARGET_META_NAME: string

export interface ProbeTarget {
  port: number
  base: string
  url: string
  close: () => Promise<void>
}

export declare function startProbeTarget(options?: { port?: number; host?: string }): Promise<ProbeTarget>
