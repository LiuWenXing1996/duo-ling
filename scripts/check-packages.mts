#!/usr/bin/env node
// 包边界门禁：静态扫 `@duoling/*` import，对照下方依赖矩阵。
// 规则与 ARCHITECTURE.md「依赖方向与包边界」一致；开新边 = 改这里的矩阵 + 同步该节文档。
//
// 覆盖三类语句：静态 import / `export ... from` / 动态 `import()`；同时拦相对路径跨出包根
// 的绕行（绕开包名就绕开了矩阵，这里一并堵上）。零依赖纯文本，秒级，挂 pre-commit 与 Gate。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname, posix } from 'node:path'

// 依赖矩阵：包 → 允许 import 的 @duoling 包。根 src/ 是装配层，放行全部。
const MATRIX: Record<string, string[]> = {
  shared: [],
  'builtin-scripts': ['shared'],
  'service-worker': ['shared', 'builtin-scripts'],
  'offscreen-document': ['shared'],
  ui: ['shared'],
  workbench: ['ui', 'shared'],
  floatpanel: ['ui', 'shared'],
  popup: ['ui', 'shared'],
}

const ROOT = process.cwd()
const PKG_DIR = join(ROOT, 'packages')
const PKG_RE = /@duoling\/([a-z-]+)/g
const IMPORT_STMT = /^\s*(import|export)\b/
const DYNAMIC_IMPORT = /import\(\s*['"]@duoling\/([a-z-]+)['"]\s*\)/
const REL_IMPORT = /(?:from\s+|import\(\s*)['"](\.\.?\/[^'"]*)['"]/

interface Violation {
  file: string
  line: number
  text: string
  detail: string
}

const violations: Violation[] = []
let edgeCount = 0

// 递归收文件
function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full, out)
    } else if (/\.(ts|mts|vue)$/.test(name)) {
      out.push(full)
    }
  }
}

for (const pkg of Object.keys(MATRIX)) {
  const pkgRoot = join(PKG_DIR, pkg)
  const files: string[] = []
  walk(join(pkgRoot, 'src'), files)

  for (const file of files) {
    const rel = relative(ROOT, file)
    const lines = readFileSync(file, 'utf8').split('\n')

    lines.forEach((raw, i) => {
      if (!IMPORT_STMT.test(raw) && !DYNAMIC_IMPORT.test(raw)) return
      // 剥行内 // 注释：import 语句的路径不含 //，行尾注释会误带包名
      const line = raw.replace(/\/\/.*$/, '')
      if (!IMPORT_STMT.test(line) && !DYNAMIC_IMPORT.test(line)) return

      // 相对 import 不得跨出包根（绕开 @duoling/* 就绕开了矩阵）
      const relSpec = line.match(REL_IMPORT)?.[1]
      if (relSpec) {
        const resolved = posix.normalize(posix.join(posix.dirname(rel), relSpec))
        if (!resolved.startsWith(`packages/${pkg}/`)) {
          violations.push({
            file: rel,
            line: i + 1,
            text: raw.trim(),
            detail: `相对 import 跨出包根（落到 ${resolved}），包间一律走 @duoling/*`,
          })
        }
      }

      // @duoling/* 依赖矩阵
      for (const m of line.matchAll(PKG_RE)) {
        const target = m[1]
        edgeCount++
        if (target === pkg) continue
        if (!MATRIX[pkg].includes(target)) {
          violations.push({
            file: rel,
            line: i + 1,
            text: raw.trim(),
            detail: `${pkg} → @duoling/${target} 不在依赖矩阵内（允许：${MATRIX[pkg].join(', ') || '无'}）`,
          })
        }
      }
    })
  }
}

// 根 src/ 装配层：只拦相对 import 跳出仓库
const rootFiles: string[] = []
walk(join(ROOT, 'src'), rootFiles)
for (const file of rootFiles) {
  const rel = relative(ROOT, file)
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '')
    const relSpec = line.match(REL_IMPORT)?.[1]
    if (!relSpec) return
    const resolved = resolve(dirname(file), relSpec)
    if (!resolved.startsWith(ROOT)) {
      violations.push({ file: rel, line: i + 1, text: raw.trim(), detail: '相对 import 跳出仓库根' })
    }
  })
}

if (violations.length > 0) {
  console.error(`✗ 包边界违规 ${violations.length} 处：`)
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`)
    console.error(`    ${v.text}`)
    console.error(`    → ${v.detail}`)
  }
  console.error('  矩阵真相源在 scripts/check-packages.mts 的 MATRIX；开新边须同步 ARCHITECTURE.md「依赖方向与包边界」。')
  process.exit(1)
}
console.log(`✓ 包边界合规：9 包 @duoling 边 ${edgeCount} 条全在矩阵内，相对 import 无越界`)
