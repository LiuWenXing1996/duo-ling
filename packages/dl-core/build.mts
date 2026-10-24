#!/usr/bin/env node
import { build, context, type BuildOptions, type Plugin } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

interface Target {
  entry: string
  out: string
  label: string
  forbidden: { re: RegExp; why: string }[]
  required: { re: RegExp; why: string }[]
}

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
        re: /\b(?:var|let|const|class|function)\s+DL\b/,
        why: '出现本地 DL 声明 —— 会遮住外层挂载点，内核必须写入自由变量 DL',
      },
      {
        re: /\bchrome\s*\.(?!runtime\b)/,
        why: '引用了 chrome.runtime 之外的扩展 API —— 内核注入体只许直连传输',
      },
      {
        re: /\bopenDB\b/,
        why: '把 idb 打进了注入产物 —— 存储只在 SW 侧，主世界不许开库',
      },
    ],
    required: [
      {
        re: /(?<![\w.$])DL\s*=/,
        why: '没有给 DL 赋值 —— 装配件没跑起来，或入口不再写这个自由变量',
      },
      {
        re: /\bMessageChannel\b/,
        why: '没有建 MessageChannel —— MAIN 世界没有扩展 API，传输必须走跨世界私线',
      },
      {
        re: /\bpostMessage\s*\(/,
        why: '没有把私线端口交出去 —— 中继件收不到线，整条通道静默失效',
      },
    ],
  },
  {
    entry: 'src/messaging/relay-entry.ts',
    out: 'dist/messaging-relay-iife.js',
    label: '消息中继件',
    forbidden: [
      MODULE_STMT,
      {
        re: /\bopenDB\b/,
        why: '把 idb 打进了中继产物 —— 中继只搬帧，不碰存储',
      },
    ],
    required: [
      {
        re: /\bconnect\s*\(/,
        why: '没有 connect SW —— 中继件的唯一出口就是那条 Port',
      },
      {
        re: /\baddEventListener\s*\(\s*['"]message['"]/,
        why: '没有监听 window message —— 收不到 MAIN 世界交来的私线',
      },
    ],
  },
]

const emitPlugin = (target: Target): Plugin => ({
  name: 'dl-core-emit',
  setup(builder) {
    builder.onEnd((result) => {
      if (result.errors.length) return
      const code = result.outputFiles?.[0]?.text
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
  absWorkingDir: here,
  format: 'iife',
  platform: 'browser',
  target: 'chrome135',
  minify: false,
  sourcemap: false,
  charset: 'utf8',
  legalComments: 'none',
  write: false,
  plugins: [emitPlugin(target)],
})

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--watch')) {
    const ctxs = await Promise.all(TARGETS.map((target) => context(buildOptions(target))))
    await Promise.all(ctxs.map((ctx) => ctx.watch()))
    console.log('[dl-core] 监听中（Ctrl+C 退出）')
  } else {
    for (const target of TARGETS) await build(buildOptions(target))
  }
}
