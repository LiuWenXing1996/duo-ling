#!/usr/bin/env node
// dl-core 装配件的构建：把各入口（连同它 import 的模块）各 bundle 成一段 IIFE，
// 产出 dist/ 下的同名产物（不入库，每次从源码重建）。
//
// 产物形态是「一段可内联的 JS 文本」，不是独立注册、也不是 `{ file }` 注册。TARGETS 表里每个入口一份：
// - mount-dl：内核。注入体被硬约束成一条 code（见 `src/build-user-script.ts` 文件头），内核必须
//   与外层那个 `var DL = undefined` 处于同一个函数作用域，脚本正文才能按词法拿到 `DL`。
//   落成另一条注册，作用域随之断开 —— 那时 `DL` 要么挂在 window 上、要么脚本根本看不见。
//
// 消费方用 `?raw` 把产物读成字符串常量再拼进注入体。也就是说产物文件名与内容是包内契约，
// 改格式（加 banner、换 ESM）会直接改掉注入体。
//
// 用法：
//   node build.mts           构建一次（`pnpm -r build` 的一环，dev 前置也走它）
//   node build.mts --watch   监听重建
import { build, context, type BuildOptions, type Plugin } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

interface Target {
  /** 相对包根的入口 */
  entry: string
  /** 相对包根的产物路径 */
  out: string
  /** 日志与报错里显示的名字 */
  label: string
  /** 产物里不许出现的形状（命中即构建失败，脏产物不落盘） */
  forbidden: { re: RegExp; why: string }[]
  /** 产物里必须出现的形状（缺失即构建失败） */
  required: { re: RegExp; why: string }[]
}

/** IIFE 里出现 import/export 说明打包形态错了 —— 所有产物通用 */
const MODULE_STMT = {
  re: /^\s*(?:import|export)[\s{('"]/m,
  why: '残留 import / export 语句 —— 装配件必须自成一段 IIFE',
}

const TARGETS: Target[] = [
  {
    entry: 'src/mount-dl.ts',
    out: 'dist/mount-dl-iife.js',
    label: '内核装配件',
    forbidden: [
      MODULE_STMT,
      {
        // 本地 `DL` 声明会遮住外层挂载点，脚本正文读到的就成了另一个变量
        re: /\b(?:var|let|const|class|function)\s+DL\b/,
        why: '出现本地 DL 声明 —— 会遮住外层挂载点，内核必须写入自由变量 DL',
      },
      {
        re: /\bchrome\s*\.(?!runtime\b)/,
        why: '引用了 chrome.runtime 之外的扩展 API —— 内核注入体只许直连传输',
      },
      {
        // idb 不碰 chrome，上一道拦不住；真被打进来就会拿页面的 indexedDB 开库
        re: /\bopenDB\b/,
        why: '把 idb 打进了注入产物 —— 存储只在 SW 侧，主世界不许开库',
      },
    ],
    required: [
      {
        // 必须真的给外层 `DL` 赋值（排除 `x.DL =` 这种属性赋值）
        re: /(?<![\w.$])DL\s*=/,
        why: '没有给 DL 赋值 —— 装配件没跑起来，或入口不再写这个自由变量',
      },
      {
        re: /\bconnect\s*\(/,
        why: '没有发起 runtime.connect —— 内核的传输是脚本世界直连 SW 的 Port',
      },
    ],
  },
]

// 插件与配置都标注 esbuild 的入参类型：不标的话对象字面量会把 'iife' / 'none' 这类
// 字面量推断成 string，`build(options)` 因而不接受（根 typecheck 走 noEmit 会撞上）
const emitPlugin = (target: Target): Plugin => ({
  name: 'dl-core-emit',
  setup(builder) {
    builder.onEnd((result) => {
      if (result.errors.length) return
      const code = result.outputFiles?.[0]?.text
      // `write: false` 才会有 outputFiles；拿不到就是配置被人改了，当场报而不是写出空文件
      if (!code)
        throw new Error(
          `dl-core ${target.label}产物为空 —— 需要 write: false 才能从 outputFiles 取文本`,
        )
      for (const { re, why } of target.forbidden) {
        if (re.test(code)) throw new Error(`dl-core ${target.label}产物${why} —— 脏产物不落盘`)
      }
      for (const { re, why } of target.required) {
        if (!re.test(code)) throw new Error(`dl-core ${target.label}产物${why}`)
      }
      const out = resolve(here, target.out)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, code.endsWith('\n') ? code : code + '\n')
      console.log(`[dl-core] ${target.label} IIFE 已生成 → ${target.out}（${code.length} 字节）`)
    })
  },
})

const buildOptions = (target: Target): BuildOptions => ({
  entryPoints: [resolve(here, target.entry)],
  bundle: true,
  // 产物里的 `// src/dl.ts` 这类路径注释按工作目录相对化：钉死成包根，
  // 从仓库根跑 `node packages/dl-core/build.mts` 与在包内跑必须产出同一份字节
  absWorkingDir: here,
  format: 'iife',
  platform: 'browser',
  // 与扩展的 minimum_chrome_version 同一档（用户脚本世界需内核 133+，本项目取 135）
  target: 'chrome135',
  // 产物要注入第三方页面并被调试：保持可读，devtools 里看到的就是源码形状
  minify: false,
  sourcemap: false,
  // 诊断信息里有中文：按 utf8 输出，别转成 \uXXXX
  charset: 'utf8',
  legalComments: 'none',
  // 产物经 outputFiles 交给 emitPlugin 校验后再落盘：脏产物不进 dist
  write: false,
  plugins: [emitPlugin(target)],
})

// main 守卫：被单测 / 其他脚本 import 时只取配置，不触发构建
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--watch')) {
    const ctxs = await Promise.all(TARGETS.map((target) => context(buildOptions(target))))
    await Promise.all(ctxs.map((ctx) => ctx.watch()))
    console.log('[dl-core] 监听中（Ctrl+C 退出）')
  } else {
    for (const target of TARGETS) await build(buildOptions(target))
  }
}
