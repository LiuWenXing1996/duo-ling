#!/usr/bin/env node
// 构建内置件：把 src/ 下的件源码打成 dist/ 下的 IIFE 文件。
//
// 用法：
//   node build.mjs            构建一次（扩展的 build / dev 前置步骤）
//   node build.mjs --watch    监听重建（改件源码时用）
//
// 产物落在**包内** dist/，扩展产物里的那一份由 wxt.config.ts 的 build:publicAssets 钩子取走。
import { build, context } from 'esbuild'
import { buildOptions, OUT_DIR } from './esbuild.config.mjs'

const watch = process.argv.includes('--watch')

if (watch) {
  const ctx = await context(buildOptions)
  await ctx.watch()
  console.log(`[builtin-scripts] 监听中（Ctrl+C 退出）→ ${OUT_DIR}`)
} else {
  const result = await build(buildOptions)
  if (result.warnings.length) {
    for (const w of result.warnings) console.warn('[builtin-scripts] 警告：', w.text)
  }
  console.log(`[builtin-scripts] 已构建 ${Object.keys(buildOptions.entryPoints).length} 个件 → ${OUT_DIR}`)
}
