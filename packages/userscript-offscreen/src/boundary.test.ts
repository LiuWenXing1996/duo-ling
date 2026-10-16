// 包边界单测：守住「零应用依赖 + 不依赖件包 + 不依赖兄弟包」这条线。
//
// 判据：import 源不得指向应用侧（`@/…` / `~/…`）、件包（`@duoling/builtin-scripts`）
// 或兄弟包（userscript-core / userscript-sw）。本包与 sw 侧经 @duoling/shared 的
// IPC 契约互通（clipboard:write / 保活 kind），互不 import。
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 包内全部源文件（含测试，不含本文件自身） */
const FILES = readdirSync(HERE)
  .filter((f) => f.endsWith('.ts') && f !== 'boundary.test.ts')
  .sort()

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
            s === '@duoling/userscript-core' ||
            s === '@duoling/userscript-sw',
        )
        .map((s) => `${file} → ${s}`),
    )
    expect(bad).toEqual([])
  })
})
