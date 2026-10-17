#!/usr/bin/env node
// 用户脚本样例构建：src/ 下的 TS 模块源码 → dist/ 下的单文件 .user.js。
//
// 形态与内置件包（packages/builtin-scripts）同族：esbuild bundle + iife，产物自包含、
// 无 import/export 残留 —— 扩展与 Tampermonkey 两侧都只认「单文件纯 JS 源码」。
// 与内置件的差异：样例是用户脚本，产物头部要有 `// ==UserScript==` 元数据块，
// 而 esbuild 会剥掉源码注释 —— 故元数据写在各样例的 meta.json 里，构建时生成 banner。
//
// 用法：
//   node build.mjs            构建一次（根的 build / typecheck / test 经 pnpm -r build 前置）
//   node build.mjs --watch    监听重建（改样例源码时用）
//
// dist 布局与 pack-uscripts（scripts/pack-uscripts.mts）的素材目录约定对齐：
//     dist/<样例名>/<样例名>.user.js   每目录一份源码
// raw/ 里的坏源码样本（语法错 / 运行时错）不参与构建（编不过是特性），构建时原样拷进 dist。
//
// dist 不入库（.gitignore）：源码是真相源，产物随 `pnpm -r build` 重建，防 drift。
import { build, context } from 'esbuild'
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(here, 'dist')

/**
 * 入口表：键 = 样例目录名（产物 dist/<键>/<键>.user.js，键名即目录名）。
 * 元数据取入口同目录的 meta.json；键改名时 raw 目录、e2e / coverage 的路径引用一并同步。
 */
const ENTRIES = {
  'omni-probe': 'src/omni-probe/main.ts',
  'run-log-demo': 'src/run-log-demo/main.ts',
}

/** 不参与构建的坏源码样本（raw/<名>/<名>.user.js，编不过是特性），原样拷进 dist */
const RAW_DIRS = ['syntax-error', 'runtime-error']

/** esbuild 选项基座（builtin-scripts 同款档位；outfile / banner 逐样例另给） */
const buildOptions = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome135',
  minify: false,
  sourcemap: false,
  charset: 'utf8',
  legalComments: 'none',
  // 严格性：原 .user.js 在 IIFE 里显式 'use strict'；ESM 源码本身就是严格语义，esbuild 的
  // iife 包裹不再回填指令 —— 样例源码不含 this/with/未声明赋值这类两种模式的差异点，行为一致。
}

/** meta.json → `// ==UserScript==` 块文本。键序即行序（JSON 对象序保留），空值渲染成裸 `@key` */
function renderMeta(meta) {
  const lines = ['// ==UserScript==']
  for (const [key, value] of Object.entries(meta)) {
    for (const v of Array.isArray(value) ? value : [value]) {
      lines.push(v ? `// @${key} ${v}` : `// @${key}`)
    }
  }
  lines.push('// ==/UserScript==')
  return lines.join('\n')
}

async function buildOnce() {
  rmSync(OUT_DIR, { recursive: true, force: true })
  for (const [name, entry] of Object.entries(ENTRIES)) {
    const metaPath = resolve(here, dirname(entry), 'meta.json')
    const banner = renderMeta(JSON.parse(readFileSync(metaPath, 'utf8')))
    const outfile = join(OUT_DIR, name, `${name}.user.js`)
    await build({ ...buildOptions, entryPoints: [resolve(here, entry)], outfile, banner: { js: banner } })
    const out = readFileSync(outfile, 'utf8')
    if (!out.startsWith('// ==UserScript==')) throw new Error(`${name}：产物缺元数据头（banner 未生效？）`)
    console.log(`[uscript-samples] ${name} → ${outfile.slice(here.length + 1)}（${out.length} 字节）`)
  }
  for (const name of RAW_DIRS) {
    const src = resolve(here, 'raw', name)
    if (!existsSync(src)) throw new Error(`raw 样本缺失：${src}`)
    cpSync(src, join(OUT_DIR, name), { recursive: true })
  }
  const dirs = readdirSync(OUT_DIR).filter((d) => statSync(join(OUT_DIR, d)).isDirectory())
  console.log(`[uscript-samples] 已构建 ${Object.keys(ENTRIES).length} 个样例 + ${RAW_DIRS.length} 个 raw 样本 → dist/（${dirs.length} 目录）`)
}

if (process.argv.includes('--watch')) {
  for (const [name, entry] of Object.entries(ENTRIES)) {
    const metaPath = resolve(here, dirname(entry), 'meta.json')
    const banner = renderMeta(JSON.parse(readFileSync(metaPath, 'utf8')))
    const outfile = join(OUT_DIR, name, `${name}.user.js`)
    const ctx = await context({
      ...buildOptions,
      entryPoints: [resolve(here, entry)],
      outfile,
      banner: { js: banner },
    })
    await ctx.watch()
    console.log(`[uscript-samples] 监听 ${name}（Ctrl+C 退出）→ ${outfile.slice(here.length + 1)}`)
  }
} else {
  await buildOnce()
}
