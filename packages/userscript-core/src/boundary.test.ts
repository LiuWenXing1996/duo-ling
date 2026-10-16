// 包边界单测：守住「零应用依赖 + 不依赖件包 + 不依赖兄弟包」这条线。
//
// 判据只取不会误报的形态：
//   ① import 源不得指向应用侧（`@/…` / `~/…`）、件包（`@duoling/builtin-scripts`）
//      或兄弟包（userscript-sw / userscript-offscreen）—— 本包是最底层实现包，
//      依赖方向只允许指向 @duoling/shared；
//   ② 源码里不得出现 `indexedDB` —— 只对**语义层**（L1）：索引库属宿主能力，
//      存储层（state-db / usdata-db 等）名正言顺地用 IndexedDB。
//
// 为什么不面上查 `chrome.*` 与 `document.`：本包会**生成** MAIN 世界源码（gm-wrapper 的
// 模板字符串），合法地含 `document.createElement` 这类页面侧写法；存储与广播层的
// chrome.runtime 是降级路径的防御式使用。chrome 由扩展环境提供，单测整体 stub
// （vi.stubGlobal）—— import 判据之外的部分没有自动化守卫，改这些文件时人眼多看一眼。
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 包内全部源文件（含测试，不含本文件自身） */
const FILES = readdirSync(HERE)
  .filter((f) => f.endsWith('.ts') && f !== 'boundary.test.ts')
  .sort()

/** 存储与广播层：允许 IndexedDB（存储）与防御式 chrome.*（降级路径）的文件 */
const STORAGE_LAYER = new Set([
  'state-db.ts',
  'usdata-db.ts',
  'gm-values.ts',
  'data-broadcast.ts',
  // 测试文件随被测模块归层（存储类测试用 fake-indexeddb）
  'state-db.test.ts',
  'usdata-db.test.ts',
  'gm-values.test.ts',
])

const SEMANTIC_FILES = FILES.filter((f) => !STORAGE_LAYER.has(f))

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
  it('import 源不指向应用侧、件包与兄弟包', () => {
    const bad = FILES.flatMap((file) =>
      importSources(read(file))
        .filter(
          (s) =>
            s.startsWith('@/') ||
            s.startsWith('~/') ||
            s === '@duoling/builtin-scripts' ||
            s.startsWith('@duoling/builtin-scripts/') ||
            s === '@duoling/userscript-sw' ||
            s === '@duoling/userscript-offscreen',
        )
        .map((s) => `${file} → ${s}`),
    )
    expect(bad).toEqual([])
  })

  it('语义层源码不含 indexedDB', () => {
    const bad = SEMANTIC_FILES.filter((file) => stripComments(read(file)).includes('indexedDB'))
    expect(bad).toEqual([])
  })
})
