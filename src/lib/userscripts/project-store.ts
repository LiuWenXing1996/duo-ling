// 用户脚本项目的**读侧**（SW / offscreen / 扩展页共用）。
//
// 与 store.ts 的分工：
//   store.ts        —— 只碰 chrome.storage（DL.store 值、错误日志、旧 GM 记录），故只许 SW import；
//   project-store.ts —— 只读项目状态库（IndexedDB，见 state-db.ts），不碰任何 chrome API，
//                       所以 SW 与 offscreen 都能直接用，offscreen 不必再经 SW 桥接取项目。
//
// 这里**没有写 API**：写全在 project-write.ts（offscreen 专属），见 state-db.ts 文件头的单写方约定。
import { readAllProjects, readProject } from './state-db'
import type { ScriptConfig, ScriptProject } from './types'

/** 列出全部项目：启用在前、按名称排序（与旧实现一致，保证 UI 顺序稳定） */
export async function listProjects(): Promise<ScriptProject[]> {
  const all = await readAllProjects()
  return all.sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
  )
}

/** 读单个项目（不存在 / 形态不对返回 undefined） */
export function getProject(uuid: string): Promise<ScriptProject | undefined> {
  return readProject(uuid)
}

/** 生成不与现有项目重名的默认名称：「新建的脚本 1」→「新建的脚本 2」→「新建的脚本 3」…（序号从 1 起，跳过已占用号） */
export async function nextScriptName(base = '新建的脚本'): Promise<string> {
  const names = new Set((await listProjects()).map((p) => p.name))
  let n = 1
  while (names.has(`${base} ${n}`)) n += 1
  return `${base} ${n}`
}

/**
 * 文件树校验（写入前调用，非法直接抛错）：
 * 非空、路径相对（禁开头 / 与 .. 段，防越权写）、内容必须是字符串、entry 必须存在。
 */
export function validateFiles(files: Record<string, string>, entry: string): void {
  if (!files || typeof files !== 'object' || !Object.keys(files).length) {
    throw new Error('文件树不能为空')
  }
  for (const p of Object.keys(files)) {
    if (!p || p.startsWith('/') || p.split('/').includes('..')) {
      throw new Error(`非法文件路径（须为相对路径，且不含 .. 段）：${p}`)
    }
    if (p.endsWith('/')) {
      throw new Error(`非法文件路径（不能以 / 结尾）：${p}`)
    }
    if (typeof files[p] !== 'string') {
      throw new Error(`文件内容必须是字符串：${p}`)
    }
  }
  if (!(entry in files)) {
    throw new Error(`入口文件在文件树中不存在：${entry}`)
  }
}

// —— match pattern 校验（docs/userscript-zip-transfer.md §5.4）——
// 导入路径（project-write.importScriptsZip）与启用路径（engine.registerScript）共用：
// 非法值在导入 / 启用当场拦下并指明哪条不合法，不拖到注册时才以 Chrome 的英文异常冒出。

/**
 * Chrome match pattern 语法：<scheme>://<host><path>。
 * scheme：* / http / https / file / ftp / urn；host：* 、*.example.com 或字面量
 * （file/urn 可为空）；path 必须以 / 开头。`<all_urls>` 是等价特例。
 */
const MATCH_PATTERN_RE = /^(?:\*|https?|file|ftp|urn):\/\/(?:\*|(?:\*\.)?[^/*]*)(?:\/.*)$/

/** 单条 match pattern 是否合法（`<all_urls>` 特例恒合法） */
export function isValidMatchPattern(pattern: string): boolean {
  return pattern === '<all_urls>' || MATCH_PATTERN_RE.test(pattern)
}

/** 校验配置中的 match pattern（matches + excludeMatches），非法直接抛错并列出规则 */
export function validateMatchPatterns(config: ScriptConfig): void {
  const invalid = [...(config.matches ?? []), ...(config.excludeMatches ?? [])].filter(
    (p) => !isValidMatchPattern(p),
  )
  if (invalid.length) {
    throw new Error(`匹配规则不合法：${invalid.join('、')}`)
  }
}
