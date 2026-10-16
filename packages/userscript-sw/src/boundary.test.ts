// 包边界单测：守住「零应用依赖 + 不依赖件包」这条线。
//
// 判据：import 源不得指向应用侧（`@/…` / `~/…`）或件包（`@duoling/builtin-scripts`）。
// 允许的依赖只有 @duoling/shared（契约）与 @duoling/userscript-core（语义与存储），
// 兄弟包 userscript-offscreen 不是本包的依赖（两侧经 shared 契约互通，互不 import）。
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
  it('import 源不指向应用侧、件包与兄弟包', () => {
    const bad = FILES.flatMap((file) =>
      importSources(read(file))
        .filter(
          (s) =>
            s.startsWith('@/') ||
            s.startsWith('~/') ||
            s === '@duoling/builtin-scripts' ||
            s.startsWith('@duoling/builtin-scripts/') ||
            s === '@duoling/userscript-offscreen',
        )
        .map((s) => `${file} → ${s}`),
    )
    expect(bad).toEqual([])
  })
})
