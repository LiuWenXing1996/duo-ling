// 用户脚本管理器的类型与存储键约定（v2 方案 docs/userscript-v2-plan.md §Phase 1）。
//
// 全量复用 chrome.storage.local（单存储，含项目源码 + DL 值 + 设置），不另起 IndexedDB。
// v2 新形态：一个脚本 = 一个项目（ScriptProject），配置直接映射 chrome.userScripts 原生字段。
// 旧 GM 形态记录（UserScriptMeta）保留类型仅用于识别「已弃用」记录（按 GM 特征字段判定，
// 见 docs/userscript-v2-plan.md Phase 1 —— 不按「无 v 字段」判定，避免误杀 Phase 0 产物）。

/** 脚本配置：全部直接映射 chrome.userScripts 原生注册字段，无 metadata 中间层 */
export interface ScriptConfig {
  /** 必填，match pattern */
  matches: string[]
  /** match pattern 排除 */
  excludeMatches?: string[]
  /** glob，对 matches 结果做 AND 收窄 */
  includeGlobs?: string[]
  excludeGlobs?: string[]
  /** 默认 true（对齐主流：靠排除关 iframe） */
  allFrames: boolean
  /** 默认 document_end（对齐主流） */
  runAt: 'document_start' | 'document_end' | 'document_idle'
}

/** 一个脚本 = 一个项目（v2 落盘形状，Phase 0 起 install 即按此形状写入） */
export interface ScriptProject {
  /** schema 版本 */
  v: 1
  uuid: string
  name: string
  enabled: boolean
  config: ScriptConfig
  /** 虚拟文件树：路径（相对项目根）→ 源码 */
  files: Record<string, string>
  /** 入口文件路径，默认 'main.js' */
  entry: string
  /** 最近一次构建产物（Phase 2 esbuild 管线写入；Phase 0 无构建则缺省） */
  bundle?: { code: string; builtAt: number }
  createdAt: number
  updatedAt: number
}

/** 给 UI 列表用的精简视图（不含源码与构建产物） */
export interface ScriptSummary {
  uuid: string
  name: string
  enabled: boolean
  /** matches（deprecated 记录来自旧 meta） */
  matches: string[]
  /** true = 旧 GM 形态记录：不注册、不可编辑，仅展示 + 一键清理 */
  deprecated: boolean
  /** 文件数（deprecated 记录为 0） */
  fileCount: number
  updatedAt: number
}

// —— 旧 GM 形态（v1 遗留，仅用于 deprecated 识别与摘要展示，不再新建） ——

/** 单个用户脚本记录（storage.local 键 `us:script:<uuid>`，含源码） */
export interface UserScriptMeta {
  uuid: string
  name: string
  namespace?: string
  version?: string
  enabled: boolean
  matches: string[]
  excludeMatches?: string[]
  runAt: 'document_start' | 'document_end' | 'document_idle'
  injectInto: 'page' | 'content' | 'auto'
  grants: string[]
  requires?: string[]
  requireCodes?: string[]
  resources?: Record<string, string>
  source: string
  updateURL?: string
  homepage?: string
  rawMeta?: string
}

/**
 * 判定 storage 里的旧记录是否为「旧 GM 形态」：含 GM metadata 特征字段（rawMeta / grants /
 * requires / source）即视为 legacy。ScriptProject(v:1) 不含这些字段，不会误判。
 */
export function isLegacyScriptRecord(value: unknown): value is UserScriptMeta {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v.v === 1 && typeof v.files === 'object') return false // 新形态
  return (
    typeof v.source === 'string' ||
    Array.isArray(v.grants) ||
    Array.isArray(v.requires) ||
    typeof v.rawMeta === 'string'
  )
}

/** 用户脚本引擎可用性状态（供管理页状态横幅） */
export interface UserScriptsAvailability {
  /** userScripts API 当前是否可用（getScripts 不抛错） */
  available: boolean
  /** 是否 Firefox（引导文案不同：Firefox 走 optional_permissions 授权） */
  isFirefox: boolean
  /** Chrome 大版本号（0 表示非 Chrome / 解析失败） */
  chromeMajor: number
  /** 不可用时的引导文案（按浏览器 / 版本分支） */
  guideText: string
  /** USER_SCRIPT 世界是否放开了宽松 CSP；false 时依赖 eval/内联的脚本可能失败 */
  cspPermissive: boolean
}

/** 脚本错误记录（storage.local 键 us:errors；环形保留最近 N 条，供错误日志面板） */
export interface UserScriptErrorRecord {
  id: string
  uuid: string | null // 运行期/注册错误有；部分桥错误可能无
  name: string // 脚本名（便于展示，未知时占位）
  /** 错误阶段：runtime=用户脚本运行期报错；register=后台注册失败；bridge=DL 桥调用失败 */
  phase: 'runtime' | 'register' | 'bridge'
  message: string
  stack?: string
  url?: string // 运行期错误所在页面
  time: number // 时间戳
}

// —— 存储键约定 ——
//
// 键空间沿用（v2 决策不改名）：GM/DL 值键 us:gm:<uuid>:<key>。

/** 脚本记录：us:script:<uuid> */
export const SCRIPT_KEY_PREFIX = 'us:script:'
/** DL.store 值：us:gm:<uuid>:<key>（键名沿用旧 GM 键空间，不改名） */
export const GM_KEY_PREFIX = 'us:gm:'
/** 设置 / 黑名单：us:settings */
export const SETTINGS_KEY = 'us:settings'
/** 错误日志：us:errors（环形保留最近 N 条） */
export const ERRORS_KEY = 'us:errors'

/** 默认入口文件名 */
export const ENTRY_DEFAULT = 'main.js'

export function scriptKey(uuid: string): string {
  return SCRIPT_KEY_PREFIX + uuid
}

export function gmKey(uuid: string, key: string): string {
  return `${GM_KEY_PREFIX}${uuid}:${key}`
}

/** 新建项目的默认配置：allFrames true / runAt document_end（v2 决策表） */
export function defaultConfig(matches: string[]): ScriptConfig {
  return { matches, allFrames: true, runAt: 'document_end' }
}
