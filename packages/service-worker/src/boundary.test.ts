// 包边界单测：守住「进程包互不依赖」这条线。
//
// 判据：import 源不得指向应用侧（`@/…` / `~/…`）、件包（`@duoling/builtin-scripts`）
// 或 offscreen 进程包（`@duoling/offscreen-document`）。允许的依赖只有 @duoling/shared
// （契约）/ @duoling/userscript-core（语义与存储）/ @duoling/proxy-service-list
// （服务契约与代理工厂）。
//
// 跨进程互不依赖这条由两侧各守一半：合并成「一进程一包」后，两个进程包互相 import 会
// 变成**合法的包引用**，而错进程加载当场就炸（SW 里没有 document / chrome.offscreen）。
// 反向那侧见 @duoling/offscreen-document 的 boundary.test.ts。
//
// 全部文件都是宿主层：IndexedDB 与 chrome.*（SW 环境）名正言顺。chrome 由扩展环境提供，
// 单测整体 stub（vi.stubGlobal）—— 应用耦合只准走 host-config 注入，import 判据之外的
// 部分没有自动化守卫，改这些文件时人眼多看一眼。
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 包内全部源文件（含测试，不含本文件自身；relay/ 子目录带目录前缀并入） */
const FILES = [
  ...readdirSync(HERE)
    .filter((f) => f.endsWith('.ts') && f !== 'boundary.test.ts')
    .map((f) => f),
  ...readdirSync(join(HERE, 'relay'))
    .filter((f) => f.endsWith('.ts') && f !== 'relay-code.gen.ts')
    .map((f) => `relay/${f}`),
].sort()

const read = (file: string): string => readFileSync(join(HERE, file), 'utf8')

/** 收集 import 源：静态 / 副作用 / 动态三种形态 */
function importSources(src: string): string[] {
  const out: string[] = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]/g,
  ]
  for (const re of patterns) for (const m of src.matchAll(re)) out.push(m[1]!)
  return out
}

describe('包边界', () => {
  it('import 源不指向应用侧、件包与 offscreen 进程包', () => {
    const bad = FILES.flatMap((file) =>
      importSources(read(file))
        .filter(
          (s) =>
            s.startsWith('@/') ||
            s.startsWith('~/') ||
            s === '@duoling/builtin-scripts' ||
            s.startsWith('@duoling/builtin-scripts/') ||
            s === '@duoling/offscreen-document',
        )
        .map((s) => `${file} → ${s}`),
    )
    expect(bad).toEqual([])
  })
})
