// GM 包装 · MAIN 世界 GM API 内核的组装层（注入源码 = 前缀 + @require + 脚本正文 + 后缀）。
// 设计决策（独立成模块 / 同作用域局部注入 / 同步值快照 / 常驻通道 / @grant 裁剪 / 降级项）
// 见 docs/adr/0001-gm-wrapper-same-scope-injection.md；速查页防漂移单测从构建产物反射。
//
// 注入源分两块：
//   · **动态头**（本文件拼）—— IIFE 开口 + `var __gmOpts = {...}` 常量束（GM_info / 成员
//     裁剪表 / 值快照 / @resource / 脚本名 / savedAt / 源标记）+ 桥客户端内联
//     （bridge-main/script-bridge.ts，注册时按密钥与 uuid 生成）；
//   · **GM_MAIN_SRC** —— 页面世界真源码（src/）经 esbuild 逐段构建的片段（gen 常量，
//     build 后可用；防漂移单测从它反射真实 GM 面）。
//
// 注入体内部标识统一用 `__gm` 前缀（与桥的 `__dl` 信封区分）；所有部分共享一个函数作用域，
// 与脚本正文同域 —— 脚本按词法即可拿到 GM_*（这是「一条 code 注入」存在的理由）。
import type { GmWrapperOptions } from './exposure'
import type { GmMainOpts } from './opts'
import { buildScriptBridgeSource } from '../bridge-main/script-bridge'
import { GM_MAIN_SRC } from './gm-main.gen'
import { jsonLiteral, resolveGmExposure } from './exposure'

export type { GmWrapperOptions } from './exposure'
export { resolveGmExposure } from './exposure'

/** SW 侧拼装的动态头：__gmOpts 常量束 + 桥客户端内联（页面源码经 __gmOpts 读动态数据） */
function gmDynamicHead(opts: GmWrapperOptions): string {
  const gm: GmMainOpts = {
    info: opts.info,
    has: resolveGmExposure(opts.grant),
    values: opts.values,
    resources: opts.resources ?? {},
    name: opts.name,
    savedAt: opts.savedAt ?? null,
    srcMark: 'duoling://script/' + opts.uuid + '/',
  }
  return (
    ';(function () {\n' +
    'var __gmOpts = ' +
    jsonLiteral(gm) +
    '\n' +
    'var __dlBridge = ' +
    buildScriptBridgeSource(opts.pageSecret, opts.uuid) +
    '\n'
  )
}

/**
 * 生成注入源码的**开头部分**（未闭合的 IIFE）。
 *
 * 调用方（SW 侧 registration）负责把「本前缀 ＋ `@require` 源码 ＋ 脚本源码 ＋ 闭合的
 * GM_WRAPPER_SUFFIX」拼成**一条** code 注入 —— 三段必须在同一个函数作用域里，脚本才能
 * 按词法找到 `GM_*`（见文件头）。
 */
export function buildGmWrapperPrefix(opts: GmWrapperOptions): string {
  // 顺序：动态常量束 → 桥客户端内联 → 静态内核产物（段顺序即声明顺序，不可重排）
  return gmDynamicHead(opts) + GM_MAIN_SRC
}

/**
 * 包装的闭合后缀：engine 把它拼在「`@require` 源码 ＋ 脚本源码」之后，收掉前缀末尾打开的
 * try 块（catch 直报同步错误，归属口径见 src/header.ts 的错误收集段），
 * 与前缀合起来才是完整的一条 code（见文件头对「同一函数作用域」的说明）。
 */
export const GM_WRAPPER_SUFFIX = '\n} catch (e) { __gmReportCaught(e) }\n})();'
