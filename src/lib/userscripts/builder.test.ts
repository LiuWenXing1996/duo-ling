import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { BuildError, buildProject } from './builder'

// —— esbuild-wasm 在 Node 下的加载适配（层 3 冒烟的关键，结论见 notes/content/testing-plan.md）——
//
// builder.ts 按浏览器写（wasmURL + 默认 worker 模式），直接在 vitest node 环境跑不起来：
// 1) Node 解析 esbuild-wasm 命中 lib/main.js（node 入口）：它不加载 wasm，而是 spawn 原生
//    esbuild 二进制，且 initialize({ wasmURL }) 会直接抛
//    `The "wasmURL" option only works in the browser`。
// 2) 真正的 wasm 实现在 lib/browser.js：默认 worker 模式要 Blob + URL.createObjectURL +
//    Worker（offscreen 有、node 没有）；worker:false 主线程分支则要 fetch(wasmURL)，
//    而 node 的 fetch 不支持 file:// / chrome-extension:// URL。
// 3) 结论：node 下唯一走通的姿势是 wasmModule（字节内存编译）+ worker:false + stub self。
//    这里用 vi.mock 拦截 initialize 完成该转换，builder.ts 本体零改动，
//    offscreen（有 Worker，wasmURL 经 chrome.runtime.getURL 可 fetch）行为不变。
vi.mock('esbuild-wasm', async () => {
  const { createRequire } = await import('node:module')
  const req = createRequire(import.meta.url)
  // CJS require 拿 UMD 包的 module.exports（import 具名导出检测对 UMD 不可靠）
  const esb = req('esbuild-wasm/lib/browser.js') as typeof import('esbuild-wasm')
  const wasmModule = new WebAssembly.Module(
    readFileSync(req.resolve('esbuild-wasm/esbuild.wasm')),
  )
  return {
    ...esb,
    initialize: () => esb.initialize({ wasmModule, worker: false }),
  }
})

beforeAll(() => {
  // browser.js 的 wasm 引导代码会从 `self` 原型链重建 globalThis（纯浏览器假设），
  // node 没有 self 全局 → 指回同一个真 globalThis 即可
  vi.stubGlobal('self', globalThis)
  // fake-browser 未实现 runtime.getURL，builder 的 ensureEsbuild 会调它；给个假值即可
  // （node 下 wasm 经上面的 wasmModule 注入，wasmURL 的值不参与加载）
  ;(fakeBrowser.runtime as { getURL: (path: string) => string }).getURL =
    (path: string) => `chrome-extension://fake-id/${path}`
})

// 最小 ScriptProject fixture：entry + 一个本地模块（构建产物 = 单 IIFE）
const projectFiles: Record<string, string> = {
  'entry.ts': [
    "import { add } from './utils';",
    '',
    "const total = add(1, 2);",
    "console.log('entry-total:' + total);",
  ].join('\n'),
  'utils.ts': 'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
}

describe('buildProject 构建冒烟', () => {
  it('最小项目构建出非空 IIFE bundle，本地导入被打包', async () => {
    const outcome = await buildProject(projectFiles, 'entry.ts')

    // 产物非空且是单 IIFE（无残余 import 语句）
    expect(typeof outcome.code).toBe('string')
    expect(outcome.code.length).toBeGreaterThan(0)
    expect(outcome.code.startsWith('(() => {')).toBe(true)
    expect(outcome.code).not.toMatch(/^\s*import\s/m)

    // entry 与本地模块都进了 bundle（字符串字面量不被 minify，可作标记）
    expect(outcome.code).toContain('entry-total:')
    expect(outcome.code).toContain('a + b')

    // 无远程拉取，文件树原样回写
    expect(outcome.remoteFetched).toEqual([])
    expect(Object.keys(outcome.files).sort()).toEqual(['entry.ts', 'utils.ts'])
  })

  it('入口文件不存在 → BuildError（不产出半成品）', async () => {
    const err: BuildError = await buildProject(projectFiles, 'missing.ts').then(
      () => {
        throw new Error('应当抛 BuildError')
      },
      (e: unknown) => e as BuildError,
    )
    expect(err).toBeInstanceOf(BuildError)
    expect(err.issues[0]).toContain('入口文件不存在')
  })

  it('模块解析失败 → BuildError.issues 带 文件:行:列', async () => {
    const err: BuildError = await buildProject(
      { 'entry.ts': "import './nope';\n" },
      'entry.ts',
    ).then(
      () => {
        throw new Error('应当抛 BuildError')
      },
      (e: unknown) => e as BuildError,
    )
    expect(err).toBeInstanceOf(BuildError)
    expect(err.issues.length).toBeGreaterThan(0)
    // vfs 插件报「找不到模块」，位置定位到 entry.ts 第 1 行
    expect(err.issues[0]).toContain('找不到模块')
    expect(err.issues[0]).toMatch(/^entry\.ts:1:\d+/)
  })
})
