// 用户脚本构建管线（v2 方案）。
//
// esbuild-wasm 只在 offscreen document 运行：
// - offscreen 是唯一「能派生 Worker（URL.createObjectURL）+ 不被回收」的宿主，
//   编辑器保存 / 历史恢复 / AI 生成 loop 共用这里的一个常驻 wasm 实例（14MB 只编译一次）
// - wasm 资产在 src/public/esbuild.wasm，经 chrome.runtime.getURL 引用，懒加载一次进程内复用
// - MV3 默认 extension_pages CSP **不含** 'wasm-unsafe-eval'（E2E 冒烟实测）——
//   已在 wxt.config.ts manifest 显式声明放开 wasm 编译
// - 远程依赖在 offscreen fetch（扩展 host 权限覆盖 offscreen，免 CORS），源码持久化进项目
//   files（断网可重构建）
// - 传统 UMD / 资源依赖（config.deps）走 _deps/ 内联通道：缓存优先拉取进文件树，JS 文本
//   拼接进 bundle 头部、其余进 DL.__res 资源表（详见下方 _deps 小节）
// - offscreen 内直调（统一保存 saveSource / AI 生成 loop），本模块不 import 进 SW / 页面
//
// 一期边界：远程模块 = URL 可解析的导入链（esm.sh 的同源
// 绝对路径转发、包内相对导入均按 URL 解析，逐条 fetch 并持久化进项目 files）；仅拒绝
// 裸 npm 说明符 / node: 前缀（报友好错误）；入口文件约定无顶层 export（iife 格式限制）。
import type { Loader, Plugin } from 'esbuild-wasm'

/** 构建成功产物：注入代码 + 回写的文件树（含新拉取的远程依赖源码） */
export interface BuildOutcome {
  code: string
  /** 含远程依赖持久化后的完整文件树（保存时整体落盘） */
  files: Record<string, string>
  /** 本次新拉取的远程依赖 URL（UI 提示「拉取了哪些远程依赖」） */
  remoteFetched: string[]
}

/** 构建失败：issues 为 文件:行:列 可读错误列表（编辑器行内展示，不落盘半成品） */
export class BuildError extends Error {
  issues: string[]
  constructor(issues: string[]) {
    super(issues[0] ?? '构建失败')
    this.name = 'BuildError'
    this.issues = issues
  }
}

// —— esbuild 懒加载（首次保存时初始化一次，失败允许重试）——

type EsbuildModule = typeof import('esbuild-wasm')
let initPromise: Promise<EsbuildModule> | null = null

async function ensureEsbuild(): Promise<EsbuildModule> {
  if (!initPromise) {
    initPromise = (async () => {
      const esbuild = await import('esbuild-wasm')
      await esbuild.initialize({ wasmURL: chrome.runtime.getURL('esbuild.wasm') })
      return esbuild
    })()
    initPromise.catch(() => {
      initPromise = null // 初始化失败（wasm 加载失败等）下次重试
    })
  }
  return initPromise
}

// —— 路径工具 ——

/** 折叠 a/./b 与 a/../b（不动开头），返回项目内相对路径 */
function normalizePath(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/** 目录前缀：importer 的所在目录（无 importer 即项目根） */
function dirOf(importer: string): string {
  const i = importer.lastIndexOf('/')
  return i === -1 ? '' : importer.slice(0, i + 1)
}

/** 按扩展名选 esbuild loader（无扩展名默认按 js） */
function loaderFor(path: string): Loader {
  if (/\.(ts|mts|cts)$/.test(path)) return 'ts'
  if (/\.tsx$/.test(path)) return 'tsx'
  if (/\.jsx$/.test(path)) return 'jsx'
  if (/\.json$/.test(path)) return 'json'
  if (/\.css$/.test(path)) return 'css'
  return 'js'
}

/** 相对/绝对说明符 → 项目内文件命中（精确 → 补扩展名 → index） */
function resolveLocal(spec: string, importer: string, files: Record<string, string>): string | null {
  const joined = spec.startsWith('/') ? spec.slice(1) : dirOf(importer) + spec
  const base = normalizePath(joined)
  const candidates = [
    base,
    `${base}.js`, `${base}.ts`, `${base}.mjs`, `${base}.jsx`, `${base}.tsx`, `${base}.cjs`,
    `${base}/index.js`, `${base}/index.ts`, `${base}/index.mjs`,
  ]
  return candidates.find((c) => c in files) ?? null
}

// —— 虚拟文件系统插件（mem = 项目文件树；remote = https:// 单文件模块）——

function createVfsPlugin(
  files: Record<string, string>,
  remoteFetched: string[],
): Plugin {
  return {
    name: 'dl-vfs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const p = args.path
        // 远程上下文判定看**引用方**（importer 是 URL 即远程模块内部导入），与命名空间无关：
        // 已持久化的远程文件走 mem 命名空间，其内部导入同样要按 URL 解析。
        const isRemoteImporter = args.importer.startsWith('http://') || args.importer.startsWith('https://')
        if (p.startsWith('https://') || p.startsWith('http://')) {
          // 已持久化的远程文件直接走 mem（断网重构建的关键：不再发请求）
          return { path: p, namespace: p in files ? 'mem' : 'remote' }
        }
        if (isRemoteImporter) {
          // URL 可解析即支持（esm.sh 的同源绝对路径转发、包内相对导入）；仅拒绝裸包名说明符
          if (!p.startsWith('.') && !p.startsWith('/')) {
            return {
              errors: [{
                text: `远程模块「${args.importer}」引用了包名「${p}」：远程依赖链同样不支持 npm 包名，请改用完整 URL 的 CDN 构建`,
              }],
            }
          }
          let abs: string
          try {
            abs = new URL(p, args.importer).href
          } catch {
            return { errors: [{ text: `远程模块内路径无法解析：${p}（来自 ${args.importer}）` }] }
          }
          return { path: abs, namespace: abs in files ? 'mem' : 'remote' }
        }
        // 裸 npm 说明符与 node: 前缀：明确拒绝（不是装不了，是不该悄悄装）
        if (p.startsWith('node:') || (!p.startsWith('.') && !p.startsWith('/'))) {
          return {
            errors: [{
              text: `不支持 npm 包名「${p}」：本项目无 node_modules，请改用 CDN 完整 URL（如 https://esm.sh/lodash-es@4 ）或把源码放进文件树`,
            }],
          }
        }
        // 相对路径 → 项目内解析
        const hit = resolveLocal(p, args.importer, files)
        if (hit) return { path: hit, namespace: 'mem' }
        return {
          errors: [{
            text: `找不到模块「${p}」${args.importer ? `（被 ${args.importer} 引用）` : ''}：检查路径或先新建该文件`,
          }],
        }
      })

      build.onLoad({ filter: /.*/, namespace: 'mem' }, (args) => ({
        contents: files[args.path],
        loader: loaderFor(args.path),
        resolveDir: dirOf(args.path),
      }))

      build.onLoad({ filter: /.*/, namespace: 'remote' }, async (args) => {
        try {
          const res = await fetch(args.path)
          if (!res.ok) {
            return { errors: [{ text: `远程依赖拉取失败（HTTP ${res.status}）：${args.path}` }] }
          }
          const text = await res.text()
          files[args.path] = text // 持久化进文件树：断网重构建不失败
          remoteFetched.push(args.path)
          return { contents: text, loader: loaderFor(args.path), resolveDir: '' }
        } catch (e) {
          return { errors: [{ text: `远程依赖拉取异常：${args.path}（${e instanceof Error ? e.message : String(e)}）` }] }
        }
      })
    },
  }
}

// —— UMD / 资源依赖内联（_deps/，2026-09-19 提案拍板）——
//
// 与远程 ESM 依赖（VFS remote 命名空间）平行的一条通道，面向不进模块图的传统依赖：
//   · deps = config.deps 里的 URL 列表；保存时在 offscreen fetch（host 权限免 CORS），缓存优先——
//     `_deps/index.json` 里有且内容文件在 → 不发请求（断网保存 / 重构建不失败），缺失才拉取；
//   · 内容持久化进项目 files 的 `_deps/`（确定性文件名 = sha256(url) 前 16 位），随 git / zip /
//     历史恢复全链路搭车；URL 从列表删除时连同内容文件一并清掉（孤儿清理）；
//   · 分类（拍板语义）：JS 文本依赖只**按文本拼接**进 bundle 头部（不进资源表）；其余进资源表，
//     打成 `DL.__res` 表供 DL.resource(url) 读。单列表、行为可预测；
//   · 文本/二进制判定按 content-type，带兜底（拍板点③）：octet-stream（部分 CDN 对 .js 误标）
//     与缺失 content-type 时按扩展名猜，扩展名也不认识时兜文本（误存文本比误存二进制好排查）。

/** 依赖清单（_deps/index.json）：url → 内容文件与分类。清单在 files 树里，随项目搭车 */
interface DepEntry {
  /** 内容文件路径：_deps/<sha256(url) 前 16 位>.js（文本）/ .b64（二进制 base64） */
  file: string
  /** 内容形态：text = 原文文本；base64 = 二进制内容转 base64 串 */
  mode: 'text' | 'base64'
  /** 用途：script = 拼接进 bundle 头部；resource = 进 DL.__res 资源表 */
  kind: 'script' | 'resource'
  fetchedAt: number
}

type DepIndex = Record<string, DepEntry>

const DEPS_INDEX = '_deps/index.json'
/** JS 家族扩展名（拼接判定用） */
const JS_EXT = /\.(mjs|cjs|js)$/i
/** 常见文本扩展名（content-type 兜底时猜 mode 用） */
const TEXT_EXT = /\.(mjs|cjs|js|css|json|txt|xml|svg)$/i

/** deps 入参归一：去空白、去重（保序）、仅接受 http/https */
function normalizeDeps(deps?: string[]): string[] {
  const out: string[] = []
  for (const raw of deps ?? []) {
    const url = raw.trim()
    if (!url) continue
    if (!out.includes(url)) out.push(url)
  }
  for (const url of out) {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      throw new BuildError([`依赖 URL 仅支持 http/https：${url}`])
    }
  }
  return out
}

/** content-type / 扩展名 → 依赖分类（兜底序见小节头注释） */
function classifyDep(url: string, contentType: string): Pick<DepEntry, 'mode' | 'kind'> {
  const path = url.split(/[?#]/)[0]
  const jsExt = JS_EXT.test(path)
  const textExt = TEXT_EXT.test(path)
  const ct = contentType.trim().toLowerCase()
  // JS 判定（拼进 bundle）：content-type 指明 JS，或扩展名是 JS 家族
  const isScript =
    ct.includes('javascript') || ct.includes('ecmascript') || (ctTextLike(ct, textExt) && jsExt)
  // 文本判定：明确文本型 ct → 文本；octet-stream 或缺失 → 按扩展名猜，扩展名不认识兜文本
  const isText = ctTextLike(ct, textExt)
  return { mode: isText ? 'text' : 'base64', kind: isScript ? 'script' : 'resource' }
}

/** content-type 是否指明文本体（含 octet-stream / 缺失时的扩展名兜底） */
function ctTextLike(ct: string, textExt: boolean): boolean {
  if (
    ct.startsWith('text/') ||
    ct.includes('javascript') ||
    ct.includes('ecmascript') ||
    ct.includes('json') ||
    ct.includes('xml') ||
    ct.includes('css')
  ) {
    return true
  }
  // octet-stream（部分 CDN 对 .js 误标）与缺失 content-type：按扩展名猜，不认识兜文本
  return !ct || ct === 'application/octet-stream' ? true : textExt
}

/** 确定性文件名：sha256(url) 前 16 位十六进制（同 URL 恒同文件，重复保存不膨胀） */
async function depFileFor(url: string, ext: 'js' | 'b64'): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))
  const hex = Array.from(new Uint8Array(buf).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `_deps/${hex}.${ext}`
}

/** Uint8Array → base64（分块防大数组爆栈；node 测试环境也有全局 btoa） */
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[])
  }
  return btoa(bin)
}

/** 拉取单个依赖并分类：返回清单条目（内容已由调用方从返回值取用写盘） */
async function fetchDep(
  url: string,
): Promise<{ entry: DepEntry; content: string }> {
  let res: Response
  try {
    res = await fetch(url)
  } catch (e) {
    throw new BuildError([`依赖 URL 拉取异常：${url}（${e instanceof Error ? e.message : String(e)}）`])
  }
  if (!res.ok) {
    throw new BuildError([`依赖 URL 拉取失败（HTTP ${res.status}）：${url}`])
  }
  const { mode, kind } = classifyDep(url, res.headers.get('content-type') ?? '')
  if (mode === 'text') {
    return { entry: { file: await depFileFor(url, 'js'), mode, kind, fetchedAt: Date.now() }, content: await res.text() }
  }
  return {
    entry: { file: await depFileFor(url, 'b64'), mode, kind, fetchedAt: Date.now() },
    content: bytesToBase64(new Uint8Array(await res.arrayBuffer())),
  }
}

/** 读清单（损坏 / 缺失按空清单处理：命中的依赖会重新拉取，不会卡死） */
function parseDepIndex(raw: string | undefined): DepIndex {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as DepIndex
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 依赖内联对齐（构建前调用）：缓存优先补齐缺失 → 写入 workFiles → 清孤儿 → 回写清单。
 * 无依赖时也调用：清掉 URL 列表被清空后遗留的 `_deps/`。
 */
async function syncDeps(
  files: Record<string, string>,
  deps: string[],
  remoteFetched: string[],
): Promise<DepIndex> {
  const oldIndex = parseDepIndex(files[DEPS_INDEX])
  const index: DepIndex = {}
  for (const url of deps) {
    const cached = oldIndex[url]
    if (cached && cached.file in files) {
      index[url] = cached // 缓存命中：不发请求（断网友好；改依赖源码可手编 _deps 文件）
      continue
    }
    const { entry, content } = await fetchDep(url)
    files[entry.file] = content
    index[url] = entry
    remoteFetched.push(url)
  }
  // 孤儿清理：旧清单里已不在本次 deps 的条目，内容文件一并删
  for (const [url, entry] of Object.entries(oldIndex)) {
    if (!(url in index) && entry.file in files) delete files[entry.file]
  }
  if (Object.keys(index).length) files[DEPS_INDEX] = JSON.stringify(index, null, 2)
  else delete files[DEPS_INDEX]
  return index
}

/** bundle 头部：script 依赖文本拼接（保序，; 分隔）+ DL.__res 资源表帧。无内容返回空串 */
function buildBundleHead(files: Record<string, string>, index: DepIndex): string {
  const parts: string[] = []
  const scripts: string[] = []
  const resources: Record<string, { text?: string; b64?: string }> = {}
  for (const [url, entry] of Object.entries(index)) {
    const content = files[entry.file]
    if (content == null) continue // syncDeps 后不应发生（清单与文件同步写），防御
    if (entry.kind === 'script') scripts.push(content)
    else resources[url] = entry.mode === 'text' ? { text: content } : { b64: content }
  }
  if (scripts.length) parts.push(scripts.join('\n;\n') + '\n;\n')
  if (Object.keys(resources).length) {
    // DL 由 DL 包装先于 bundle 注入；资源表挂在 DL 自身（不开新全局），DL.resource 读它
    parts.push(`;(function () {\n  if (typeof DL !== 'undefined' && DL) DL.__res = ${JSON.stringify(resources)}\n})()\n;\n`)
  }
  return parts.join('')
}

// —— 对外入口 ——

/**
 * 构建项目为单 IIFE。
 * - 入口经 stdin 喂入（绕开 entryPoints 的磁盘解析），相对导入由 vfs 插件解析
 * - format iife / 不 minify（报错行号可读）/ target es2020
 * - deps（config.deps，选填）：UMD / 资源依赖内联对齐（缓存优先，缺失拉取并写回文件树），
 *   JS 依赖按文本拼接进 bundle 头部，其余进 DL.__res 资源表（见文件头 _deps 小节）
 * - 成功：返回注入代码 + 回写文件树（含远程依赖 / _deps 源码）
 * - 失败：抛 BuildError（issues 含 文件:行:列），调用方不得落盘
 */
export async function buildProject(
  files: Record<string, string>,
  entry: string,
  deps?: string[],
): Promise<BuildOutcome> {
  const entrySrc = files[entry]
  if (entrySrc == null) throw new BuildError([`入口文件不存在：${entry}`])

  const esbuild = await ensureEsbuild()
  // files 复制一份：远程依赖写进副本，失败时不动调用方原对象
  const workFiles: Record<string, string> = { ...files }
  const remoteFetched: string[] = []
  // 依赖内联对齐（含无依赖时的孤儿清理）；拉取失败抛 BuildError → 保存恒成功、产物置空
  const depIndex = await syncDeps(workFiles, normalizeDeps(deps), remoteFetched)

  try {
    const result = await esbuild.build({
      stdin: {
        contents: entrySrc,
        resolveDir: dirOf(entry),
        sourcefile: entry,
        loader: loaderFor(entry),
      },
      bundle: true,
      write: false,
      format: 'iife',
      target: 'es2020',
      plugins: [createVfsPlugin(workFiles, remoteFetched)],
      logLevel: 'silent',
    })
    const bundled = result.outputFiles?.[0]?.text
    if (!bundled) throw new BuildError(['构建无产物输出'])
    // 头部拼接在 esbuild 之后：script 依赖文本 + DL.__res 资源表帧 + 模块产物
    const code = buildBundleHead(workFiles, depIndex) + bundled
    return { code, files: workFiles, remoteFetched }
  } catch (e) {
    // esbuild 失败抛 { errors: [{ text, location: { file, line, column } }] }
    const errs = (e as { errors?: Array<{ text: string; location?: { file?: string; line?: number; column?: number } }> }).errors
    if (Array.isArray(errs) && errs.length) {
      const issues = errs.map((err) => {
        const loc = err.location
        const where = loc?.file ? `${loc.file}${loc.line != null ? `:${loc.line}${loc.column != null ? `:${loc.column}` : ''}` : ''}` : '(未知位置)'
        return `${where}  ${err.text}`
      })
      throw new BuildError(issues)
    }
    throw new BuildError([e instanceof Error ? e.message : String(e)])
  }
}
