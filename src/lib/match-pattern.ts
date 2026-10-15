// match pattern 解析与判定已上移进 `@duoling/userscript-runtime`（match-pattern.ts：纯匹配
// 逻辑归运行时包，metadata 与未来的 cookie-gate 共用）；本文件仅作路径兼容桶。
// 消费方：cookie-gate（域名门）、engine（生效域判定）、metadata（包内）。
export * from '@duoling/userscript-runtime'
