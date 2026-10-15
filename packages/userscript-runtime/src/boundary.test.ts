// 包边界单测：守住「零应用依赖 + 不依赖件包」这条线。
//
// 判据只取不会误报的形态：
//   ① import 源不得指向应用侧（`@/…` / `~/…`）或件包（`@duoling/builtin-scripts`）；
//   ② 源码里不得出现 `indexedDB`（索引库属宿主能力，真身在应用侧的 app-db / runtime-db）。
//
// 为什么不面上查 `chrome.*` 与 `document.`：本包会**生成** MAIN 世界源码（gm-wrapper 的
// 模板字符串）与面板展示文本，两者都合法地含 `document.createElement` 这类页面侧写法。
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

/** 剥掉块注释与行注释（`[^:]` 避开 `https://` 一类的协议前缀） */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('包边界', () => {
  it('import 源不指向应用侧与件包', () => {
    const bad = FILES.flatMap((file) =>
      importSources(read(file))
        .filter((s) => s.startsWith('@/') || s.startsWith('~/') || s === '@duoling/builtin-scripts')
        .map((s) => `${file} → ${s}`),
    )
    expect(bad).toEqual([])
  })

  it('源码不含 indexedDB', () => {
    const bad = FILES.filter((file) => stripComments(read(file)).includes('indexedDB'))
    expect(bad).toEqual([])
  })
})
