// 包边界单测：守住「进程包互不依赖」这条线。
//
// 两个进程包各守一侧：本包（offscreen 进程）不得 import @duoling/service-worker，
// 反向那侧由 service-worker 的 boundary.test.ts 守。合并成「一进程一包」后，两个进程包
// 互相 import 会变成**合法的包引用**，而错进程加载当场就炸（SW 里没有 document /
// chrome.offscreen）—— 包级 import 判据是这条边界唯一可自动化的守卫。
//
// 跨进程互通只有一条路：chrome.runtime 消息（服务代理报文 / 总线命令）。
//
// 另两条既有线：不指向应用侧（`@/…` / `~/…`）、不指向件包。
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 递归收集包内全部源文件（含测试，不含本文件自身；子目录带目录前缀并入） */
function collect(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) return collect(join(dir, entry.name), rel)
    return entry.name.endsWith('.ts') && entry.name !== 'boundary.test.ts' ? [rel] : []
  })
}

const FILES = collect(HERE).sort()

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

/** 不许指向的包：应用侧（相对别名）、件包、SW 进程包 */
function forbidden(s: string): boolean {
  return (
    s.startsWith('@/') ||
    s.startsWith('~/') ||
    s === '@duoling/builtin-scripts' ||
    s.startsWith('@duoling/builtin-scripts/') ||
    s === '@duoling/service-worker'
  )
}

describe('包边界', () => {
  it('import 源不指向应用侧、件包与 SW 进程包', () => {
    const bad = FILES.flatMap((file) =>
      importSources(read(file))
        .filter(forbidden)
        .map((s) => `${file} → ${s}`),
    )
    expect(bad).toEqual([])
  })
})
