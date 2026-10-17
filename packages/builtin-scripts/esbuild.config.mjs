// 内置件构建的唯一真相源：入口表 + esbuild 选项（键即产物文件名，与 registry.ts 同步由 registry.test.ts 把守）。
// 形态为什么是 IIFE 单文件见 docs/adr/0008-builtin-scripts-iife-build.md。
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 产物目录：包内 dist/，扩展产物里的那一份由 wxt.config.ts 的 build:publicAssets 钩子从这里取 */
export const OUT_DIR = resolve(here, 'dist')

/**
 * 入口表：键 = 产物文件名（不含扩展名）。键名带 `duoling-` 前缀的理由：产物落在**扩展产物根**，
 * 与扩展自身的产物同目录，前缀避免重名（与 icons / help 那类资产并列）。
 *
 * 注意：脚本桥中继件（duoling-relay）**不在本表** —— 它已随 `@duoling/service-worker`
 * 包内化（源码与 IIFE 生成物都在包里，以 `{ code }` 字符串注册，无公共资产文件）。
 */
export const ENTRY_POINTS = {
  'duoling-recorder': resolve(here, 'src/recorder/entry.ts'),
  'duoling-page-inspector': resolve(here, 'src/inspector/entry.ts'),
  'duoling-float-host': resolve(here, 'src/float-host/entry.ts'),
}

/** esbuild 选项：构建脚本与任何外部消费方都从这里取同一份 */
export const buildOptions = {
  entryPoints: ENTRY_POINTS,
  outdir: OUT_DIR,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  // 与 manifest 的 minimum_chrome_version 同一档（自定义 USER_SCRIPT 世界需内核 133+，本项目取 135）
  target: 'chrome135',
  // 件要注入第三方页面并被调试：保持可读，不做压缩；devtools 里看到的就是源码形状
  minify: false,
  // 不开 sourcemap：产物要一并进扩展产物目录，多出的 .map 只是搬运负担
  sourcemap: false,
  // 件里有中文诊断信息（console.warn）：按 utf8 输出，别转成 \uXXXX
  charset: 'utf8',
  legalComments: 'none',
}
