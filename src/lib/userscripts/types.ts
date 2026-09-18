// 用户脚本管理器的类型与存储键约定（v2 方案）。
//
// 全量复用 chrome.storage.local（单存储，含项目源码 + DL 值 + 设置），不另起 IndexedDB。
// v2 新形态：一个脚本 = 一个项目（ScriptProject），配置直接映射 chrome.userScripts 原生字段。

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

/** 一个脚本 = 一个项目（v2 落盘形状，所有创建路径均按此形状写入） */
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
  /**
   * 最近一次构建产物，正常路径必有（先构建后落盘）。
   * **可缺省**：zip 导入构建失败时仍落盘（老大拍板「尽量导入」）——
   * 此时注册会被 resolveInjectCode 拦下并记 register 警告，用户去编辑器改到能构建即可。
   */
  bundle?: { code: string; builtAt: number }
  createdAt: number
  updatedAt: number
}

/** 给 UI 列表用的精简视图（不含源码与构建产物） */
export interface ScriptSummary {
  uuid: string
  name: string
  enabled: boolean
  matches: string[]
  fileCount: number
  updatedAt: number
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
  /**
   * 运行标识：**一次页面加载 = 一个 runId**（DL 包装注入即 mint，见 engine.buildDlWrapper）。
   * 用途：日志是全量环形（历次运行混存），浮窗只认「本次运行」的错误——
   * 它自持 `uuid → 当前 runId 集合`（runId 由脚本经 SW 转达），按 runId 成员判定过滤，**不看 SW**。
   * `register`（注册失败）与 `bridge`（桥调用失败）没有页面/运行上下文，恒为 null / 缺省；
   * register 阶段错误在浮窗里恒显（不被 run 轴误杀）。
   */
  runId?: string | null
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

// —— zip 导入报告——
//
// 2026-09-17 语义修订（老大拍板「不是原则项的阻断，尽量导入脚本」）：导入只拦原则项，
// 其余一律导入并说明，留给脚本编辑器修。故 ok 条目可带 notes（构建失败 / 字段兜底提示），
// failed 只剩结构性原因（无 project.json / 非合法 JSON）。

/** 导入成功的条目（uuid 为导入方新生成；enabled 恒 false） */
export interface ImportItemOk {
  status: 'ok'
  uuid: string
  name: string
  /** 内容指纹与现有脚本一致时的原脚本名（仅提示，仍已导入） */
  duplicateOf?: string
  /** 导入期需要告知用户的提示：构建失败（可在编辑器修）/ 字段缺失已补默认 等 */
  notes?: string[]
}

/** 导入失败的条目——**只剩原则项**（没有可解析的 manifest，构造不出记录） */
export interface ImportItemFailed {
  status: 'failed'
  /** 解析期跳过时为 zip 顶层目录名 */
  name: string
  reason: string
}

export type ImportItemResult = ImportItemOk | ImportItemFailed

/** 导入时未导入的文件（顶层散文件 / 非 files/ 条目 / 路径不安全被过滤；仅展示） */
export interface ImportItemIgnored {
  status: 'ignored'
  /** zip 内原始路径 */
  path: string
  reason: string
}

/** 一次 zip 导入的汇总报告 */
export interface ImportReport {
  succeeded: number
  failed: number
  results: ImportItemResult[]
  /** 未导入的文件（非脚本项 / 路径不安全被过滤），仅展示、不影响成功/失败计数 */
  ignored: ImportItemIgnored[]
}

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

/**
 * 新建脚本的初始源码模板（零输入创建用）。
 *
 * 新建即构建（project-write.createProject 内先 buildProject 再落盘，产物是注册的必要条件），
 * 但模板保持极简纯 JS：无依赖、无模块语法，构建产物与源码几乎等价，首保存即被用户内容覆盖。
 */
export function defaultSource(name: string): string {
  return [
    `// 哆灵用户脚本 · ${name}`,
    '// 保存后按匹配规则注入页面；可用 DL.* 能力，例如 DL.log()。',
    '// 注意：此处直接执行，暂不支持 import / export（需要多文件时在编辑器里构建）。',
    '',
    "console.log('[哆灵脚本] 已注入', location.href)",
    '',
  ].join('\n')
}
