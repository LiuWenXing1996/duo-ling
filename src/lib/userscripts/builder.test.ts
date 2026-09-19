import { readFileSync } from 'node:fs'
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing/fake-browser'
import { BuildError, buildProject } from './builder'

// —— esbuild-wasm 在 Node 下的加载适配（构建冒烟的关键）——
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

// —— UMD / 资源依赖内联（_deps/）——

/** fetch mock 的响应形状（builder 只用 ok / status / headers.get / text / arrayBuffer） */
function fakeRes(body: string, ct: string, status = 200): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => ct },
    text: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  // beforeAll 里 stub 的 self 被上一行一并清掉，须重建（esbuild wasm 引导依赖它）
  vi.stubGlobal('self', globalThis)
})

describe('buildProject deps 内联', () => {
  const depJs = "window.__jq = '3.7.1'"

  it('JS 依赖按文本拼接进 bundle 头部（在模块产物之前），源码持久化进 _deps/', async () => {
    const fetchMock = vi.fn(async () => fakeRes(depJs, 'application/javascript'))
    vi.stubGlobal('fetch', fetchMock)

    const outcome = await buildProject(projectFiles, 'entry.ts', ['https://cdn.example/jquery.js'])

    // 拼接：依赖文本在最前，其后才是 esbuild 产物（单 IIFE）
    expect(outcome.code.startsWith(depJs)).toBe(true)
    expect(outcome.code).toContain('(() => {')
    expect(outcome.code).toContain('entry-total:')
    // 不进资源表（拍板点①：JS 依赖只拼接）
    expect(outcome.code).not.toContain('DL.__res')

    // 持久化：清单 + 内容文件进文件树
    const depPaths = Object.keys(outcome.files).filter((p) => p.startsWith('_deps/'))
    expect(depPaths.filter((p) => p.endsWith('.js'))).toHaveLength(1)
    expect(outcome.files['_deps/index.json']).toBeDefined()
    const index = JSON.parse(outcome.files['_deps/index.json']!) as Record<string, { file: string; kind: string; mode: string }>
    const entry = index['https://cdn.example/jquery.js']!
    expect(entry).toMatchObject({ kind: 'script', mode: 'text' })
    expect(outcome.files[entry.file]).toBe(depJs)

    expect(outcome.remoteFetched).toEqual(['https://cdn.example/jquery.js'])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('缓存优先：清单与内容文件都在时不发请求（断网重构建不失败）', async () => {
    const fetchMock = vi.fn(async () => fakeRes(depJs, 'application/javascript'))
    vi.stubGlobal('fetch', fetchMock)

    const first = await buildProject(projectFiles, 'entry.ts', ['https://cdn.example/jquery.js'])
    expect(fetchMock).toHaveBeenCalledOnce()

    const second = await buildProject(first.files, 'entry.ts', ['https://cdn.example/jquery.js'])
    expect(fetchMock).toHaveBeenCalledOnce() // 未再拉取
    expect(second.remoteFetched).toEqual([])
    expect(second.code.startsWith(depJs)).toBe(true)
  })

  it('refreshDeps：无视缓存全量重拉，新内容替换进文件树与 bundle', async () => {
    const fetchMock = vi.fn(async () => fakeRes(depJs, 'application/javascript'))
    vi.stubGlobal('fetch', fetchMock)
    const first = await buildProject(projectFiles, 'entry.ts', ['https://cdn.example/jquery.js'])

    const depJsV2 = "window.__jq = '3.7.2'"
    fetchMock.mockImplementation(async () => fakeRes(depJsV2, 'application/javascript'))
    const outcome = await buildProject(first.files, 'entry.ts', ['https://cdn.example/jquery.js'], {
      refreshDeps: true,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2) // 有缓存也重拉（与缓存优先语义相反）
    expect(outcome.remoteFetched).toEqual(['https://cdn.example/jquery.js'])
    expect(outcome.code.startsWith(depJsV2)).toBe(true)
    const index = JSON.parse(outcome.files['_deps/index.json']!) as Record<string, { file: string }>
    expect(outcome.files[index['https://cdn.example/jquery.js']!.file]).toBe(depJsV2)
  })

  it('refreshDeps：任一拉取失败 → BuildError 且调用方文件树原封不动（事务性，旧缓存未被替换）', async () => {
    const fetchMock = vi.fn(async () => fakeRes(depJs, 'application/javascript'))
    vi.stubGlobal('fetch', fetchMock)
    const first = await buildProject(projectFiles, 'entry.ts', [
      'https://cdn.example/jquery.js',
      'https://cdn.example/other.js',
    ])
    const snapshot = JSON.stringify(first.files)

    fetchMock.mockImplementation(async () => fakeRes('nope', 'text/plain', 503))
    const err: BuildError = await buildProject(
      first.files,
      'entry.ts',
      ['https://cdn.example/jquery.js', 'https://cdn.example/other.js'],
      { refreshDeps: true },
    ).then(
      () => {
        throw new Error('应当抛 BuildError')
      },
      (e: unknown) => e as BuildError,
    )
    expect(err).toBeInstanceOf(BuildError)
    expect(err.issues[0]).toContain('已保留旧缓存')
    expect(err.issues[0]).toContain('https://cdn.example/other.js')
    expect(JSON.stringify(first.files)).toBe(snapshot) // 调用方文件树未被触碰
  })

  it('非 JS 依赖进 DL.__res 资源表（不拼接），DL.resource 读文本', async () => {
    const css = 'body { color: red }'
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(css, 'text/css')))

    const outcome = await buildProject(projectFiles, 'entry.ts', ['https://cdn.example/style.css'])

    // 不拼接进头部，而是整条打进 DL.__res 表（url → { text }）
    expect(outcome.code).toContain('DL.__res')
    expect(outcome.code).toContain('"https://cdn.example/style.css":{"text":"body { color: red }"}')
    const index = JSON.parse(outcome.files['_deps/index.json']!) as Record<string, { kind: string; mode: string }>
    expect(index['https://cdn.example/style.css']).toMatchObject({ kind: 'resource', mode: 'text' })
  })

  it('二进制依赖（image/png）存 .b64 文件，资源表带 b64 形态', async () => {
    const bytes = 'PNGDATA'
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(bytes, 'image/png')))

    const outcome = await buildProject(projectFiles, 'entry.ts', ['https://cdn.example/i.png'])

    const index = JSON.parse(outcome.files['_deps/index.json']!) as Record<string, { file: string; mode: string; kind: string }>
    const entry = index['https://cdn.example/i.png']!
    expect(entry.mode).toBe('base64')
    expect(entry.file.endsWith('.b64')).toBe(true)
    // 'PNGDATA' 的 base64
    expect(outcome.files[entry.file]).toBe('UE5HREFUQQ==')
    expect(outcome.code).toContain('"b64":"UE5HREFUQQ=="')
  })

  it('octet-stream 误标 .js：按扩展名兜底判为文本 JS，照常拼接（拍板点③）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(depJs, 'application/octet-stream')))

    const outcome = await buildProject(projectFiles, 'entry.ts', ['https://cdn.example/jquery.min.js'])

    expect(outcome.code.startsWith(depJs)).toBe(true)
    const index = JSON.parse(outcome.files['_deps/index.json']!) as Record<string, { kind: string; mode: string }>
    expect(index['https://cdn.example/jquery.min.js']).toMatchObject({ kind: 'script', mode: 'text' })
  })

  it('缺失 content-type：按文本兜底', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(depJs, '')))

    const outcome = await buildProject(projectFiles, 'entry.ts', ['https://cdn.example/lib.js'])
    expect(outcome.code.startsWith(depJs)).toBe(true)
  })

  it('拉取失败（HTTP 404）→ BuildError，明确带状态与 URL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes('nope', 'text/plain', 404)))

    const err: BuildError = await buildProject(
      projectFiles,
      'entry.ts',
      ['https://cdn.example/missing.js'],
    ).then(
      () => {
        throw new Error('应当抛 BuildError')
      },
      (e: unknown) => e as BuildError,
    )
    expect(err).toBeInstanceOf(BuildError)
    expect(err.issues[0]).toContain('HTTP 404')
    expect(err.issues[0]).toContain('https://cdn.example/missing.js')
  })

  it('URL 从 deps 清单删除 → 孤儿文件与清单一并清理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeRes(depJs, 'application/javascript')))

    const first = await buildProject(projectFiles, 'entry.ts', ['https://cdn.example/jquery.js'])
    expect(Object.keys(first.files).some((p) => p.startsWith('_deps/'))).toBe(true)

    const second = await buildProject(first.files, 'entry.ts', [])
    expect(Object.keys(second.files).some((p) => p.startsWith('_deps/'))).toBe(false)
    expect(second.files['entry.ts']).toBe(projectFiles['entry.ts'])
  })

  it('deps 含非 http(s) URL → BuildError；重复 URL 去重保序只拉一次', async () => {
    const err: BuildError = await buildProject(
      projectFiles,
      'entry.ts',
      ['ftp://cdn.example/x.js'],
    ).then(
      () => {
        throw new Error('应当抛 BuildError')
      },
      (e: unknown) => e as BuildError,
    )
    expect(err.issues[0]).toContain('仅支持 http/https')

    const fetchMock = vi.fn(async () => fakeRes(depJs, 'application/javascript'))
    vi.stubGlobal('fetch', fetchMock)
    await buildProject(projectFiles, 'entry.ts', [
      'https://cdn.example/a.js',
      'https://cdn.example/a.js',
    ])
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
