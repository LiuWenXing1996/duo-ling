// match entry：把 VM 的 meta 解析与 URL 匹配判定以库产物形式交给宿主。
//
// 这是「以 VM 为准」要拿的第一块：宿主（扩展的 SW）靠它们决定「这个页面该注入哪些脚本」，
// 从而不必再维护第二套匹配实现 —— 匹配语义天然与 VM 一致（含 @include 的正则形态，
// 那是 VM 支持、我们自研实现明确不支持的）。
import { parseMeta } from '@/background/utils/script'
import { testScript } from '@/background/utils/tester'

globalThis.__gmRuntimeMatch = { parseMeta, testScript }
