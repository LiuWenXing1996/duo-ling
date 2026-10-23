#!/usr/bin/env node
// GM 包装的 IIFE 构建：src/gm-wrapper-entry.ts → dist/gm-wrapper.iife.js（不入库，pnpm -r build 重建）。
import { build } from 'esbuild'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

await build({
  entryPoints: [resolve(here, 'src/gm-wrapper-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome135',
  minify: false,
  sourcemap: false,
  charset: 'utf8',
  legalComments: 'none',
  outfile: resolve(here, 'dist/gm-wrapper.iife.js'),
})
console.log('[service-worker] GM 包装 IIFE → dist/gm-wrapper.iife.js')
