// 包边界单测：守住「零应用依赖 + 不依赖件包」这条线。
//
// 判据只取不会误报的形态：
//   ① import 源不得指向应用侧（`@/…` / `~/…`）或件包（`@duoling/builtin-scripts`）——对全部文件；
//   ② 源码里不得出现 `indexedDB` —— 只对**语义层**（L1）：索引库属宿主能力，宿主层
//      （L2 的 state-db / usdata-db 等）名正言顺地用 IndexedDB。
//
// 为什么不面上查 `chrome.*` 与 `document.`：本包会**生成** MAIN 世界源码（gm-wrapper 的
// 模板字符串）与面板展示文本，两者都合法地含 `document.createElement` 这类页面侧写法；
// 宿主层（dl-bridge / dl-port）更是直接跑在 SW 里用 chrome.*。chrome 由扩展环境提供，
// 单测整体 stub（vi.stubGlobal）—— 纯度判据对宿主层的表达是「应用耦合只准走 host-config 注入」，
// 由 import 判据 ① 加人工评审把守。
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 包内全部源文件（含测试，不含本文件自身） */
const FILES = readdirSync(HERE)
  .filter((f) => f.endsWith('.ts') && f !== 'boundary.test.ts')
  .sort()

/** 宿主层（L2）：允许 IndexedDB（存储）与 chrome.*（SW 环境）的文件 */
const HOST_LAYER = new Set([
  'idb-core.ts',
  'state-db.ts',
  'usdata-db.ts',
  'gm-values.ts',
  'data-broadcast.ts',
  'cookie-gate.ts',
  'dl-fetch-priv.ts',
  'dl-port.ts',
  'dl-bridge.ts',
  'host-config.ts',
  'host.ts',
  'util.ts',
  // 测试文件随被测模块归层（存储类测试用 fake-indexeddb，桥测试整体 stub chrome）
  'state-db.test.ts',
  'usdata-db.test.ts',
  'cookie-gate.test.ts',
  'dl-port.test.ts',
  'dl-fetch-priv.test.ts',
  'host.test.ts',
])

const SEMANTIC_FILES = FILES.filter((f) => !HOST_LAYER.has(f))

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

  it('语义层源码不含 indexedDB', () => {
    const bad = SEMANTIC_FILES.filter((file) => stripComments(read(file)).includes('indexedDB'))
    expect(bad).toEqual([])
  })
})
