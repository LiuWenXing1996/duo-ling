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

// —— 对外入口 ——

/**
 * 构建项目为单 IIFE。
 * - 入口经 stdin 喂入（绕开 entryPoints 的磁盘解析），相对导入由 vfs 插件解析
 * - format iife / 不 minify（报错行号可读）/ target es2020
 * - 成功：返回注入代码 + 回写文件树（含远程依赖源码）
 * - 失败：抛 BuildError（issues 含 文件:行:列），调用方不得落盘
 */
export async function buildProject(
  files: Record<string, string>,
  entry: string,
): Promise<BuildOutcome> {
  const entrySrc = files[entry]
  if (entrySrc == null) throw new BuildError([`入口文件不存在：${entry}`])

  const esbuild = await ensureEsbuild()
  // files 复制一份：远程依赖写进副本，失败时不动调用方原对象
  const workFiles: Record<string, string> = { ...files }
  const remoteFetched: string[] = []

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
    const code = result.outputFiles?.[0]?.text
    if (!code) throw new BuildError(['构建无产物输出'])
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
