// 一键路径转换：shadcn-vue CLI 拉进来的组件一律写 `@/` 别名导入（components.json 的
// aliases 口径），而本包源码直出、被主包与各页面包直接编译 —— `@/` 会撞主包自己的
// 别名，故组件落库后跑一次本脚本，把 `@/` 全部改写成包内相对路径。
//
// 覆盖四种形态：`import x from '@/a'` / `import '@/a'` / `import('@/a')` /
// `export { x } from '@/a'`（含 type 修饰，靠 `from` 归一）。脚本幂等：源码里没有
// `@/` 导入时是 no-op。CLI add 之后跑一次即可：
//
//   pnpm --filter @duoling/ui convert-paths
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src')
const exts = new Set(['.ts', '.tsx', '.vue'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = resolve(dir, name)
    if (statSync(p).isDirectory()) return walk(p)
    return exts.has(name.slice(name.lastIndexOf('.'))) ? [p] : []
  })
}

// from 前缀归一了 import/export 两种语句；import('...') 动态导入与 side-effect 导入
// 由后两个分支收。spec 捕获组是 `@/` 后面的路径。
const re = /(\bfrom\s*|\bimport\s*\(?\s*)(['"])@\/([^'"]+)\2/g

let files = 0
let total = 0
for (const file of walk(srcDir)) {
  const content = readFileSync(file, 'utf8')
  const dir = dirname(file)
  let count = 0
  const next = content.replace(re, (_whole: string, lead: string, quote: string, spec: string) => {
    count++
    let rel = relative(dir, resolve(srcDir, spec)).replaceAll('\\', '/')
    if (!rel.startsWith('.')) rel = `./${rel}`
    return `${lead}${quote}${rel}${quote}`
  })
  if (count > 0) {
    writeFileSync(file, next)
    files++
    total += count
    console.log(`  ${file.slice(srcDir.length + 1)}：${count} 处`)
  }
}

// 兜底复查：任何形如 from '@/...' 的残留都算漏网（理论上不会发生，正则同源）。
const leftovers = walk(srcDir).filter((f) => /(['"])@\//.test(readFileSync(f, 'utf8')))
if (leftovers.length > 0) {
  console.error(`仍有 ${leftovers.length} 个文件残留 @/ 导入：\n${leftovers.join('\n')}`)
  process.exit(1)
}

console.log(total === 0 ? '无 @/ 导入，无需转换' : `共改写 ${files} 个文件、${total} 处导入`)
