// 注入体拼装：把内核装配件 + 用户脚本正文（含 `@require` 依赖）合成一条主世界 code。
//
// 三段顺序即语义：`var DL = undefined`（挂载点）→ 内核 IIFE（赋值给这个自由变量）→ 脚本正文。
// 三段同处一个 IIFE 的函数作用域，所以正文按词法就能拿到内核建好的 `DL`，不需要把它挂到
// window 上；`var` / `let` 也全部关在 IIFE 里，不外泄到页面。
//
// 内核文本由本文件自己取：`build.mts` 把 `src/mount-dl.ts` 打成 `dist/mount-dl-iife.js`，
// 下面用 `?raw` 把它的**原文**读成字符串。取文本而不是 import 它的副作用，是因为副作用
// 落在另一个模块作用域里，`DL` 就接不到外层这个挂载点上了；内核只此一份，挂哪层由 `tier` 分流。
//
// 一条 code 是硬约束：拆成多条 js 会各自独立求值，`@require` 与正文会失去先后顺序与
// 共享作用域。

// 内核装配件原文：构建产物（不入库，`pnpm -r build` 重建），`?raw` 由 Vite 处理成纯文本常量
import KERNEL_IIFE from '../dist/mount-dl-iife.js?raw'
import type { KernelTier } from './dl'

/** 单脚本注入体的拼装输入 */
export interface BuildUserScriptInput {
  /** 脚本 uuid：并进 sourceURL */
  readonly uuid: string
  /** 脚本名：只用于 sourceURL 的可读部分，不参与逻辑 */
  readonly name: string
  /** 用户脚本正文（metadata 块之外的脚本本体） */
  readonly source: string
  /** `@require` 已抓取的源码，按声明顺序前置 */
  readonly requires?: readonly string[]
  readonly tier?: KernelTier
}

/** 拼出注入主世界的最终 userscript 源码（一条 code：挂载点 + 内核 + 正文） */
export function buildUserScript(input: BuildUserScriptInput): string {
  const body = [...(input.requires ?? []), input.source].join('\n;\n')
  if (!body.trim()) throw new Error('buildUserScript：脚本正文为空，拒绝产出空注入体')
  return [
    // 开头的分号防上一条 code 以表达式结尾时被 ASI 并进来
    ';(function () {',
    // `DL` 的挂载点：内核 IIFE 紧跟着给它赋值，正文里按词法读到同一个变量
    'var DL = undefined',
    `var registerId = "${input.uuid}"`,
    // 内核就按这个自由变量分流挂载：漏了它内核会 ReferenceError，整段注入体都跑不起来
    `var tier = ${JSON.stringify(input.tier ?? 'client')}`,
    KERNEL_IIFE,
    // 首尾两条日志用脚本名做标记：多脚本同帧时按名字区分谁进来了、谁跑完了。
    // 名字走 JSON.stringify，含引号 / 换行 / 反斜杠也不会破坏注入体的语法。
    'console.log(' + JSON.stringify(input.name + ' 开始执行') + ')',
    body,
    'console.log(' + JSON.stringify(input.name + ' 执行完成') + ')',
    '})();',
    '//# sourceURL=' + sourceUrl(input.uuid, input.name),
  ].join('\n')
}

/** DevTools 里的伪文件地址：Sources 面板按 uuid 归档，名字仅作可读标识 */
function sourceUrl(uuid: string, name: string): string {
  // 名字常自带 .js（安装名 / 原始文件名），先摘掉再补，免得出 .js.js
  const base = name.replace(/\.js$/i, '').replace(/[^\w.-]/g, '_') || 'script'
  return 'duoling://script/' + uuid + '/' + base + '.js'
}
