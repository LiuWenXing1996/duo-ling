// 用户脚本管理器的类型与存储约定（v3 形态：单文件脚本）。
//
// 一个脚本 = 一个单文件源码 + 一份配置，直接映射 chrome.userScripts 原生字段。
// 无构建流程：保存即注入（源码原文进注册态），对齐油猴单文件形态。

/**
 * 脚本配置：**运行期唯一事实源**。
 *
 * 前 6 个字段直接映射 chrome.userScripts 原生注册字段；`metadata` 组字段是**注入期配置**
 * （@grant / @require / @resource 与 GM_info 合成所需），不映射到注册字段。
 *
 * 来源：源码里的 `// ==UserScript==` 块（由 metadata.ts 解析后写入）**或**用户在 UI 里手改。
 * 写入后**不回写源码**（2026-09-20 拍板）—— metadata 只是输入，config 是唯一运行期事实源。
 */
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

  // —— 以下为 GM 化的注入期配置（metadata 派生，不映射注册字段）——

  /**
   * `@grant` 声明的能力名（保序去重，含 `'none'`）。
   * 缺省 / 空数组 / 仅 `['none']` → **空清单，只给恒注入集**（对齐 TM；`GM_info` 等恒注入项仍可用）。
   */
  grant?: string[]
  /** `@require` 外部依赖 URL（保序；注册时抓取缓存后按序前置注入） */
  requires?: string[]
  /** `@resource` 命名资源（供 GM_getResourceText / GM_getResourceURL） */
  resources?: ScriptResourceDecl[]
  /** metadata 的展示字段（GM_info.script 合成用，不参与匹配） */
  namespace?: string
  version?: string
  description?: string
  author?: string
  icon?: string
  /**
   * 分发来源（`@updateURL` / `@downloadURL` / `@homepageURL`）——油猴生态自带的自声明约定。
   * 脚本自己在 metadata 块里声明它从哪来、去哪取新版，故**不必由本扩展维护任何清单**。
   * 仅记录、不参与注入：供 UI 复述「这脚本从哪来」，以及后续的更新提示。
   */
  updateUrl?: string
  downloadUrl?: string
  homepageUrl?: string
}

/** `@resource name url` 一条（资源体落库由 P2 实现） */
export interface ScriptResourceDecl {
  name: string
  url: string
}

/**
 * 一个脚本 = 一个单文件源码（落盘形状，所有创建路径均按此形状写入）。
 *
 * **源码已迁出到 duoling-fs 库**（offscreen 独占的 lightning-fs 实例，带 git 版本化），
 * 不在此处保存——dl 单写方约束下 SW / 扩展页读不到 lfs，故源码的唯一权威副本在
 * duoling-fs；本记录退化为「注册态库」：注册所需的元数据 + **源码搬运副本**（SW 读不到
 * lfs，注册时的注入代码从这里取——保存时由 offscreen 写侧随落盘一并写入）。
 * 改这份形状时务必同步 offscreen-fs-commands / us-git / project-write / ui-client / 各面板。
 */
export interface ScriptProject {
  /** schema 版本 */
  v: 2
  uuid: string
  name: string
  enabled: boolean
  config: ScriptConfig
  /**
   * 所属分组 id（用户脚本列表的分组功能）。空字符串 = 未分组。
   * 分组定义存于 duoling-state 的 groups 对象库（见 state-db.ts）；本字段只持有引用，
   * 故分组改名不影响脚本、分组删除后脚本自动退回未分组（UI 按 id 查不到定义即按未分组渲染）。
   */
  group?: string
  /**
   * 源码搬运副本（保存时刻的源码原文）：SW 读不到 duoling-fs，chrome.userScripts.register
   * 的注入代码从这里取。与 duoling-fs 的工作区同源（每次保存同批写入），无构建流程。
   */
  source: { code: string; savedAt: number }
  createdAt: number
  updatedAt: number
}

/**
 * 一次源码改动的来源：一套历史里要能分清是谁改的。
 * 存在版本记录的 author 上（见 us-git），**不拼进提交信息** —— 提交信息是给用户读的
 * 「改了什么」，来源是「谁改的」，分开存才不会互相污染。
 */
export type CommitActor = 'user' | 'ai' | 'system'

/** 给 UI 列表用的精简视图（不含源码） */
export interface ScriptSummary {
  uuid: string
  name: string
  enabled: boolean
  matches: string[]
  updatedAt: number
  /** 所属分组 id（空字符串 = 未分组）；与 groups 对象库里的定义对应 */
  group: string
  /** 累计运行次数（一次页面加载 = 一次）；缺省 = 还没有运行统计 */
  runCount?: number
  /** 最近一次运行时刻（ms）；与 runCount 同源，有统计即有值 */
  lastRunAt?: number
  /** 最近一次运行捕获的运行期错误数；缺省 = 0 或无统计（UI 只在 >0 时展示） */
  lastRunErrors?: number
}

/**
 * 脚本列表分组（持久化于 duoling-state 的 groups 对象库，见 state-db.ts）。
 * 纯组织元数据：脚本只持有 group id（ScriptProject.group），改名 / 删除分组不影响脚本引用以外的内容。
 */
export interface ScriptGroup {
  /** 分组唯一 id（脚本侧引用它；uuid 风格，但与脚本 uuid 命名空间隔离） */
  id: string
  /** 分组展示名（可改） */
  name: string
  /** 排序权重：数值越小越靠前；UI 按此升序排列，未分组恒在最后 */
  order: number
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
  /**
   * 错误阶段：runtime=用户脚本运行期报错；register=后台注册失败；bridge=GM 桥调用失败；
   * require=外部依赖抓取失败；resource=@resource 资源抓取失败（后两者都只记错误、不阻断注入）
   */
  phase: 'runtime' | 'register' | 'bridge' | 'require' | 'resource'
  message: string
  stack?: string
  url?: string // 运行期错误所在页面
  time: number // 时间戳
  /**
   * 运行标识：**一次页面加载 = 一个 runId**（GM 包装注入即 mint，见 gm-wrapper 的 buildGmWrapperSource）。
   * 用途：日志是全量环形（历次运行混存），对话界面页面监控只显「本次运行」的错误——
   * 按当前 tab 登记的运行集里有没有该 runId 来判定。
   * `register`（注册失败）与 `bridge`（桥调用失败）没有页面/运行上下文，恒为 null / 缺省。
   */
  runId?: string | null
}

// —— 存储约定 ——
//
// 全部落 IndexedDB：GM 值存储 / GM tab → duoling-usdata（usdata-db.ts，复合主键）；
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

/** zip 内源码文件的固定文件名（每脚本目录只此一个 script.js，单文件形态） */
export const SCRIPT_FILE = 'script.js'

// —— zip 导入报告——
//
// 导入只拦原则项，其余一律导入并说明，留给脚本编辑器修。故 ok 条目可带 notes（字段兜底提示），
// failed 只剩结构性原因（缺 script.js 源码文件 / 非脚本目录）。

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
 * 单文件纯 JS：无依赖、无模块语法（按 classic script 注入，import/export 不可用），保存即注入。
 *
 * 模板只有两样东西：**一个现成的 metadata 块**与**一行能跑起来的示例**。
 * 块是配置的唯一入口（编辑器没有配置表单，匹配规则 `@match` 与能力 `@grant` 都只能写在这里），
 * 摆出来用户就知道该改哪儿；示例证明脚本真的跑起来了。
 *
 * **刻意不写散文注释**：这是给用户直接改的起点，不是说明书 —— 讲「得声明 grant」「配置住在源码里」
 * 归文档与工作台「GM API」页，放在模板里只会挡路。
 *
 * 块里也不写 `@name`：名字归状态库（列表里重命名不回写源码，写在这儿反而两处对不上）。
 * 匹配规则那一行与新建时的兜底配置同值（都是全站），保持一致免得两边打架。
 */
export function defaultSource(): string {
  return [
    '// ==UserScript==',
    '// @match *://*/*',
    '// @grant none',
    '// ==/UserScript==',
    '',
    "console.log('[哆灵脚本] 已注入', location.href)",
    '',
  ].join('\n')
}
