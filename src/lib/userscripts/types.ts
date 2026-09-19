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
  /**
   * 依赖 URL 列表（http/https，选填，一行一个）。
   * 保存时经 offscreen 拉取内联进项目 files 的 `_deps/`（缓存优先，断网可重构建）：
   * JS 文本依赖按文本拼接进 bundle 头部；其余进资源表供 DL.resource(url) 读取。
   * config 整体随 project.json（us-git meta）与 zip 导入导出序列化，本字段自动搭车。
   */
  deps?: string[]
}

/**
 * 一个脚本 = 一个项目（落盘形状，所有创建路径均按此形状写入）。
 *
 * **源码已迁出到 duoling-fs 库**（offscreen 独占的 lightning-fs 实例，带 git 版本化），
 * 不在此处保存——dl 单写方约束下 SW / 扩展页读不到 lfs，故源码的唯一权威副本在
 * duoling-fs；本记录退化为「注册态库」：只保留注册脚本所需的元数据与产物。
 * 改这份形状时务必同步 offscreen-fs-commands / us-git / project-write / ui-client / 各面板。
 */
export interface ScriptProject {
  /** schema 版本 */
  v: 1
  uuid: string
  name: string
  enabled: boolean
  config: ScriptConfig
  /** 入口文件路径，默认 'main.js' */
  entry: string
  /**
   * 最近一次构建产物，正常路径必有（先构建后落盘）。
   * **可缺省**：zip 导入构建失败时仍落盘（老大拍板「尽量导入」）——
   * 此时注册会被 resolveInjectCode 拦下并记 register 警告，用户去编辑器改到能构建即可。
   */
  bundle?: { code: string; builtAt: number }
  /**
   * 最近一次构建的终态（统一保存每次都构建，故保存路径恒写入）。
   * 与 bundle 有无同义但显式：失败时 bundle 已置空，没有这个字段就连「失败于何时」都丢了。
   * 旧记录（加字段前落盘）缺省，读侧按 bundle 有无兜底推导。
   */
  buildOk?: boolean
  /** 最近一次构建的完成时刻（ms）；成败都记 */
  lastBuildAt?: number
  /** 文件数缓存：列表展示用，避免 SW 为拿数量回源读 duoling-fs（SW 读不到它）。落盘时算好写入。
   *  口径 = 项目文件树全量文件数，**含 `_deps/` 内联依赖文件**（deps 拉取后文件树真实增长，如实计数） */
  fileCount?: number
  createdAt: number
  updatedAt: number
}

/** 源码的元数据（并行写入 duoling-fs 的 project.json，与状态库记录同源保存） */
export interface ScriptMeta {
  name: string
  config: ScriptConfig
  entry: string
  createdAt: number
}

/** 给 UI 列表用的精简视图（不含源码与构建产物） */
export interface ScriptSummary {
  uuid: string
  name: string
  enabled: boolean
  matches: string[]
  fileCount: number
  updatedAt: number
  /** 最近一次构建终态（旧记录缺省时按 bundle 有无推导，见 ScriptProject.buildOk） */
  buildOk: boolean
  /** 最近一次构建完成时刻（ms）；缺省 = 旧记录没记过 */
  lastBuildAt?: number
  /** 累计运行次数（一次页面加载 = 一次）；缺省 = 还没有运行统计 */
  runCount?: number
  /** 最近一次运行时刻（ms）；与 runCount 同源，有统计即有值 */
  lastRunAt?: number
  /** 最近一次运行捕获的运行期错误数；缺省 = 0 或无统计（UI 只在 >0 时展示） */
  lastRunErrors?: number
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
}

/** 脚本错误记录（runtime 库 errors store，单记录环形；环形保留最近 N 条，供错误日志面板） */
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
   * 用途：日志是全量环形（历次运行混存），侧边栏页面监控只显「本次运行」的错误——
   * 按当前 tab 登记的运行集里有没有该 runId 来判定。
   * `register`（注册失败）与 `bridge`（桥调用失败）没有页面/运行上下文，恒为 null / 缺省。
   */
  runId?: string | null
}

// —— 存储约定 ——
//
// 全部落 IndexedDB：DL.store / DL.tab → duoling-usdata（usdata-db.ts，复合主键）；
// 观测数据（错误日志 / 运行统计 / 运行日志）→ duoling-runtime（runtime-db.ts）。

/** 设置 / 黑名单：us:settings */
export const SETTINGS_KEY = 'us:settings'
/** 错误日志环形上限：超过后只留最近 N 条。
 *  写侧（store.ts）裁剪、UI 文案（错误日志标签页）都读这里 —— 上限只写一处，避免文案与实现漂移。 */
export const ERROR_LOG_MAX = 50
/** 运行日志环形上限：全局混存（跨脚本按时间排），超过后只留最近 N 条 */
export const RUN_LOG_MAX = 500

/**
 * 脚本运行统计（duoling-runtime 库 stats store，keyPath uuid；写侧 store.ts，SW 独占）。
 *
 * 聚合计数器（总次数 / 最后运行时间 / 最近一次运行的错误数），与运行日志（runlog store）
 * **并进同一事务写入**（store.recordRunStart 经 runtime-db.mutateStatsAndLog）——每次页面
 * 加载仍只付一次存储事务，写放大不因逐条日志翻倍。
 * 「最近错误数」口径 = 最近一次运行（runId 相同）捕获的运行期错误数：新运行开始时清零，
 * 旧运行的迟到错误（runId 对不上）不计入（运行日志里按 runId 关联展示）。
 */
export interface UserScriptRunStats {
  /** 累计运行次数（一次页面加载 = 一次；runstart 的 load 补播按 runId 去重） */
  totalRuns: number
  /** 最近一次运行时刻（ms） */
  lastRunAt: number
  /** 最近一次运行的 runId：既用于补播去重，也用于把 runtime 错误归属到「最近一次运行」 */
  lastRunId?: string
  /** 最近一次运行捕获的运行期错误数（新运行开始即清零） */
  lastRunErrors?: number
}

/**
 * 运行日志条目（runtime 库 runlog store，全局环形按时间排；写侧 store.ts，SW 独占）。
 * 只记「一次运行发生了」——错误明细不复制进这里，仍在 errors store 按 runId 关联；
 * name 是落盘时的快照（脚本删除后日志条目仍可读）。
 */
export interface UserScriptRunLogEntry {
  runId: string
  uuid: string
  /** 脚本名快照（落盘时刻） */
  name: string
  /** 运行开始时刻（ms） */
  time: number
}

/**
 * 运行日志时间线的一行（listRunTimeline 的产物，UI 直接渲染）。
 * 运行行 = runlog store 的一次运行，其运行期错误按 runId 挂在 errors 上（可展开看明细）；
 * 错误行 = 无法归属到时间线内任何一次运行的错误（无 runId 的注册/桥错误，
 * 或该 runId 的运行已滑出环形）——单独成行，不丢。
 */
export type UserScriptRunLogRow =
  | {
      kind: 'run'
      runId: string
      uuid: string
      name: string
      time: number
      errors: UserScriptErrorRecord[]
    }
  | { kind: 'error'; record: UserScriptErrorRecord }

/** 默认入口文件名 */
export const ENTRY_DEFAULT = 'main.js'

// —— zip 导入报告——
//
// 导入只拦原则项，其余一律导入并说明，留给脚本编辑器修。故 ok 条目可带 notes（构建失败 / 字段兜底提示），
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
