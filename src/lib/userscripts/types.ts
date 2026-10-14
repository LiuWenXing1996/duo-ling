// 用户脚本管理器的类型与存储约定（v3 形态：单文件脚本）。
//
// 一个脚本 = 一个单文件源码 + 一份配置，直接映射 chrome.userScripts 原生字段。
// 无构建流程：保存即注入（源码原文进注册态），对齐油猴单文件形态。

import { EXTENSION_NAME } from '@/lib/extension-identity'

/**
 * 脚本配置：**运行期唯一事实源**。
 *
 * 前 6 个字段直接映射 chrome.userScripts 原生注册字段；`metadata` 组字段是**注入期配置**
 * （@grant / @require / @resource 与 GM_info 合成所需），不映射到注册字段。
 *
 * 来源：源码里的 `// ==UserScript==` 块（由 metadata.ts 解析后写入）**或**用户在 UI 里手改。
 * 写入后**不回写源码**—— metadata 只是输入，config 是唯一运行期事实源。
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
  /** 默认 document_idle（对齐 TM：不写 @run-at 时 TM 也是 idle） */
  /**
   * 注入时机（对应 `@run-at`）。
   *
   * `document_body` 是 TM 的取值（**body 元素存在时**才开始跑，TM 文档："injected if the body element exists"）。
   * Chrome 的 `userScripts.runAt` 只认 start / end / idle，故它注入时仍用 `document_start`，
   * 由包装层加一道「等 body」的闸门把正文推后（见 gm-wrapper 的 `__gmRunAtBody`）。
   */
  runAt: 'document_start' | 'document_body' | 'document_end' | 'document_idle'

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

/** `@resource name url` 一条（资源体已落库） */
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
  /**
   * 源码最后保存时刻（ms）= `ScriptProject.source.savedAt`；列表按它排序并展示为「更新时间」。
   *
   * 只认源码落盘这一件事：启停 / 改名 / 挪分组都不刷新它（那些不改源码，也不产生 git 提交），
   * 与用户理解的「脚本更新了」保持一致。
   */
  savedAt: number
  /** 所属分组 id（空字符串 = 未分组）；与 groups 对象库里的定义对应 */
  group: string
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

/**
 * 脚本错误记录（落 duoling-runtime 的 tab_events store，判别键 kind = ERR_TAB_KIND）。
 *
 * 逐条 + 环形：保留最近 ERROR_LOG_MAX 条，裁剪在写侧（见 runtime-db 的 appendErrorRow）。
 * 合表后它与其它轴行同住 tab_events，故按页读整根轴时一次就能拿到它（见 listTabTimeline）。
 */
export interface UserScriptErrorRecord {
  /** 记录 id：落盘时生成，UI 展示前 8 位、复制完整值给 AI 代查（见 findUserScriptError） */
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
   * 归属口径两层：`register` / `require` / `resource` 发生在任何一次运行之前，恒为 null / 缺省；
   * `runtime` 与 `bridge` 由触发它的那次运行带上 —— 对话界面页面监控只显「本次运行」的错误，
   * 就是按当前 tab 登记的运行集里有没有该 runId 来判的。
   */
  runId?: string | null
  /**
   * 所属标签页的存续 id（见 TabSessionRecord）—— 活动历史按页分档的归属键。
   *
   * **只在「这一页开着活动记录」时才有**：运行期与桥错误从它所属的那次运行继承；注册失败 /
   * 依赖与资源抓取失败与任何一页无关，恒缺省。合表后这类无归属行不进 `by_session_seq` 索引，
   * 故按页查询天然查不到 —— 它们只落盘，不出现在面板里，不需要额外过滤逻辑。
   */
  tabSessionId?: string
}

// —— 存储约定 ——
//
// 全部落 IndexedDB：GM 值存储 / GM tab → duoling-usdata（usdata-db.ts，复合主键）；
// 观测数据 → duoling-runtime（runtime-db.ts），两张 store 装下全部：
//   · tab_sessions —— 标签页存续（被观察到的每一页一行）
//   · tab_events   —— 这一页的活动轴（文档事件 / 记录开关 / 接口采样 / 运行条目 / 动作 / 错误）
// 轴上的行靠 kind 判别，各 kind 的形状见 runtime-db.ts 的文件头。

/**
 * 错误记录的环形上限：超过后只留最近 N 条。
 * 裁剪在写侧（runtime-db.ts，按 kind = ERR_TAB_KIND 取落盘序最旧的那几条删）——
 * 上限只写一处，避免文案与实现漂移。tab_events 里其余 kind 的行不受它影响。
 */
export const ERROR_LOG_MAX = 50
/** 运行条目的环形上限：全局混存（跨脚本按落盘序排），超过后只留最近 N 条 */
export const RUN_LOG_MAX = 500
/**
 * 单次运行的动作上限：达到后不再落盘后续动作，只在运行条目的 eventCount 上继续累计。
 *
 * 动作逐条落在 tab_events store（见 runtime-db.ts），追加是 O(1)，上限不再受写放大绑架——
 * 数值只由「存得下多少」与「读侧一次拉多少」决定。触顶本身是有用信号：
 * 正常脚本一次运行几次到几十次调用，刷到上限说明它在循环里反复发。
 */
export const RUN_EVENT_MAX = 1000

/**
 * 一次运行期间脚本做过的关键动作（网络 / 下载 / 通知 / 写值…）。
 *
 * 时间线若只有「开始」加挂上来的错误，脚本中途干了什么、卡在哪一步就看不见 ——
 * 对不使用 devtools 的用户，工作台是唯一的信息面，这类动作必须落在能显示的地方。
 *
 * **只记摘要、不记值**：detail 是一行可读文本（method + url、键名…），不含 GM 值的本体、
 * 剪贴板内容与请求体 —— 那些是脚本私有数据，时间轴是观察面而不是数据副本。
 *
 * 一条动作一条记录，落 tab_events store（判别键 kind = ACT_TAB_KIND，带 runId 索引）：
 * 不内嵌在运行条目里，故列表读取不带它们 —— 按 runId 拉那一组时才读（见 listRunEvents）。
 * **只在「这一页开着活动记录」时产生**（与运行条目同一判据，见 store.recordRunEvent）。
 */
export interface UserScriptRunEvent {
  /** 动作族（即 GM 命令名，如 fetch / download / store.set） */
  kind: string
  /** 一行摘要（已脱敏，可直接展示） */
  detail: string
  /** 发生时刻（ms） */
  time: number
}

/**
 * 运行结束原因。结束信号来自文档销毁，故只有两种：
 * navigated = 新文档导航顶掉了它；closed = 标签页被关。
 *
 * 它描述的是**文档生命周期的终结**，不等于「脚本跑完了」——同步部分早就跑完的脚本
 * 在页面上会一直挂到导航离开，那时记的也是 navigated。
 */
export type RunEndReason = 'navigated' | 'closed'

/**
 * 运行条目（落 tab_events store，判别键 kind = RUN_TAB_KIND；写侧 store.ts，SW 独占）。
 * 记「一次运行从加载到文档销毁发生了什么」——错误明细与动作明细都按 runId 挂在同表的
 * 其它行上（见 UserScriptErrorRecord / UserScriptRunEvent），两边都不复制进本条目；
 * name 是落盘时的快照（脚本删除后日志条目仍可读）。
 *
 * **只在「这一页开着活动记录」时产生**（见 store.recordRunStart）：它是动作与错误的归属锚。
 *
 * 除 runId / uuid / name / time 外**全部可缺省**：这些字段落地前写入的记录没有它们，
 * 读侧一律按可选处理，不因缺字段判记录无效。
 */
export interface UserScriptRunLogEntry {
  runId: string
  uuid: string
  /** 脚本名快照（落盘时刻） */
  name: string
  /** 运行开始时刻（ms） */
  time: number
  /**
   * 本次运行所在页面。
   * 与「脚本没跑」区分得开：脚本可能在别的页跑了、只是这页不在它的匹配面内；
   * 错误记录里的 url 只说错误出在哪页，答不出「它本该在哪些页跑」。
   */
  url?: string
  /**
   * 本次运行所在标签页的存续 id（见 TabSessionRecord）—— 活动历史按页分档的归属键。
   *
   * 按新口径**恒有**：运行条目只在开着活动记录的那一页上产生（见 store.recordRunStart），
   * 缺省只出现在旧记录里，读侧遇到时归「未知标签页」。
   */
  tabSessionId?: string
  /**
   * 注入时的源码版本（注册态 `source.savedAt`）。
   * 编辑器里的源码与页面上正跑的可能不是同一版（改了没存 / 存了没刷新），
   * 而读源码拿到的是**已提交版本**——靠这个值才能判断错误出自哪一版源码。
   */
  savedAt?: number
  /**
   * 本次运行收到的动作数（超过 RUN_EVENT_MAX 后仍在涨）。
   * 动作本体逐条落在 tab_events（按 runId 索引），本条目只留计数：
   * 时间轴靠它显示「N 个动作」；超过上限时计数大于实存条数，读侧据此说明「还有更多已省略」。
   */
  eventCount?: number
  /**
   * 运行结束时刻（ms）：文档被导航替换或标签页关闭时回写。
   * 缺省 = 还在跑，或结束信号没赶上（SW 已被回收 / 扩展重载，那时登记表已空）——
   * UI 据此不显示时长，而不是当作 0。
   */
  endedAt?: number
  /** 结束原因（见 RunEndReason）；与 endedAt 同来同往，成对出现 */
  endReason?: RunEndReason
}

/**
 * 标签页存续条目（duoling-runtime 库 tab_sessions store，keyPath tabSessionId；写侧 SW 独占）。
 *
 * **这张表是 tabId 的唯一登记处**：别的面要指「哪个标签页」时一律引用 tabSessionId，不自己存 tabId
 * —— tabId 是浏览器本次运行内的流水号（易失、重启重排、会被复用），只配当实时判据。
 *
 * 时刻一律「**记得到就记、记不到就没有**」：不做补造，也不拿「发现它不在的时刻」冒充关闭时刻。
 * 缺省的字段就是未知，UI 如实显示「未知」，不去猜。
 */
export interface TabSessionRecord {
  /** 稳定身份：登记时 randomUUID，此后不变（tabId 被复用也影响不到它） */
  tabSessionId: string
  /** 浏览器本次运行内的标签页编号；只在同一浏览器会话内有意义 */
  tabId: number
  /**
   * 最近一次被观察到的页面地址（登记时取 `pendingUrl ?? url`，之后随 `onUpdated` 的 url 刷新）。
   *
   * 与运行条目上的 url **不是同一事实**：那是「那次运行所在页面」的写死快照，
   * 这条是「这个标签页最近去过哪」——导航之后又没再跑脚本时，两者必然不一致。
   */
  url?: string
  /**
   * 观察到它出生的时刻。**现在恒缺省** —— 取号已改为被动（见 tab-sessions 文件头）：
   * 建行发生在「用户给这一页打开活动记录」或「脚本在这一页跑起来」，两个都不是它出生的时刻，
   * 填进去就是让字段名撒谎。字段保留只为兼容主动建行时代写入的旧行。
   */
  createdAt?: number
  /** 观察到它关闭的时刻；缺省 = 未知（扩展重载期间关的、或浏览器直接退出） */
  closedAt?: number
  /** 已判定结束（收到了关闭事件，或浏览器启动时判定它已不在）；缺省 = 仍开着 */
  ended?: true
  /**
   * 这一页此刻是否在记活动 —— 用户在 popup 里给**这一页**打开的开关。
   *
   * 被动记录的判据：只有它为 true 的行会被运行记账复用（见 tab-sessions 的取号）；
   * 其余的行只是历史痕迹，不再长出新记录。缺省 = 没开（旧行、或用户关掉了）。
   */
  recording?: boolean
}

/**
 * 标签页存续表的环形上限：运行条目（`RUN_LOG_MAX`）的 4 倍。
 *
 * 为何比运行条目宽：一页一行，而一页可以被记很久（只要记录开着），开关反复开合也会留下多行；
 * 运行条目则是一次运行一行、由环形自己压着。留足余量才不至于「记录里还有的这次运行，在表里
 * 已经查不到是哪个标签页」，那样按页看时只剩一堆无名的组。
 *
 * 体积不构成约束：单行只有 uuid + url + 几个数字，几千行仍是百 KB 量级，离存储配额很远。
 * 裁掉的是超限时**最旧登记的已结束行**（还开着的不动，见 runtime-db 的 trimEndedTabSessions）。
 */
export const TAB_SESSION_MAX = 2000

// —— tab_events 的行判别键 ——
//
// 一张表装下这一页的全部活动轴行，靠 kind 值区分（各 kind 的行形状见 runtime-db.ts 文件头）：
//   · 'reload' | 'url' | 'recordOn' | 'recordOff' —— 文档事件与记录开关（见 TabEventRecord）
//   · NET_TAB_KIND（'net'；常量在 tab-record-protocol，与协议同处）—— 接口采样
//   · 下面三个 —— 运行条目 / 动作 / 错误

/** 运行条目（形状见 UserScriptRunLogEntry）：一次页面加载一行，动作与错误的归属锚 */
export const RUN_TAB_KIND = 'run'
/** 运行内动作（形状见 UserScriptRunEvent）：脚本过桥做过的事，一条一行 */
export const ACT_TAB_KIND = 'act'
/** 错误记录（形状见 UserScriptErrorRecord）：逐条 + 环形 */
export const ERR_TAB_KIND = 'error'

/**
 * 标签页活动轴上的一行 —— **只有文档级与记录开关两类**（duoling-runtime 库 tab_events store，
 * 自增主键；写侧 SW 独占）。
 *
 * 这根轴上的行不止这一类：接口采样（NET_TAB_KIND）、运行条目（RUN_TAB_KIND）、动作
 * （ACT_TAB_KIND）、错误（ERR_TAB_KIND）都与它同住一张表 —— 读侧本就把它们按时刻混排成
 * 同一根时间线，归属键（tabSessionId）与清空粒度（按页）又完全一致，分表只会让「删这一页」
 * 变成跨库手术（六类行的形状见 runtime-db 文件头）。
 *
 * 本类型描述其中**没有额外载荷**的两类（只有 kind + time，读侧当纯文本行渲染）：
 *
 * 文档级（SW 从 `tabs.onUpdated` 判出来的，一次文档重新开始至多落一条）：
 *   · reload —— 文档重新开始，且地址没变（用户按刷新 / 前进后退回到本地址）
 *   · url    —— 地址变了：导航到新地址，或 SPA 软导航（只改地址、不换文档）
 *   判据见 tab-sessions 的 noteTabUrlChanged / noteTabReloaded。
 *
 * 记录开关（用户在 popup 里给这一页开 / 关「活动记录」，或记录被动终止）：
 *   · recordOn  —— 开始记这一页
 *   · recordOff —— 不再记：用户关掉开关，或标签页关闭 / 浏览器启动划断时它还在记
 *   与文档支同表的理由：时间线上它们是同一根轴上的连续节点（「这一段在记」由前一条
 *   recordOn 划到后一条 recordOff），拆两张表反而要让读侧自己拼顺序。
 */
export interface TabEventRecord {
  /**
   * 存储层主键：落库时由 IndexedDB 生成并写进记录，故**只有读回来的记录才有**。
   * 写侧不要自己设 —— 设了就不是自增，撞号会直接报约束错。
   *
   * 同表的每一行都有它，于是读回来的每一行都带一个稳定身份（面板拿它当列表 key）。
   */
  id?: number
  /** 所属标签页存续行（见 TabSessionRecord）—— 轴按它归组 */
  tabSessionId: string
  kind: 'reload' | 'url' | 'recordOn' | 'recordOff'
  /**
   * 行时刻（ms）。取 SW 记下它的那一刻，不是事件本身发生的精确时刻。
   *
   * **缺省 = 不知道它何时发生**：目前唯一的来源是浏览器启动划断补的那条 recordOff ——
   * 那时只知道上一次浏览器会话已经结束，不知道它几点结束的。与 closedAt 留空同一口径：
   * 不拿「发现它不在的时刻」顶上。
   */
  time?: number
  /** kind = 'url' 时是新地址；'reload' 时是当时取到的地址（取不到就不带） */
  url?: string
}

/**
 * 运行时间线的一行（listRunTimeline 的产物；消费方是 AI 的 run_log_read）。
 * 运行行 = tab_events 里 kind = RUN_TAB_KIND 的一行，其运行期错误按 runId 挂上去；
 * 错误行 = 与本次读取的运行集对不上的错误（无 runId 的注册 / 依赖抓取失败，
 * 或该 runId 的运行已滑出环形）——单独成行，不丢。
 *
 * 活动历史面板**不走这条**：它按页读整根轴（见 runtime-db 的 listTabTimeline）。
 */
export type UserScriptRunLogRow =
  | {
      kind: 'run'
      runId: string
      uuid: string
      name: string
      time: number
      /** 运行所在页面（见 UserScriptRunLogEntry；老记录缺省） */
      url?: string
      /** 运行所在标签页的存续 id（见 UserScriptRunLogEntry） */
      tabSessionId?: string
      /** 注入时的源码版本（见 UserScriptRunLogEntry；老记录缺省） */
      savedAt?: number
      /** 本次运行收到的动作数（见 UserScriptRunLogEntry.eventCount） */
      eventCount?: number
      /**
       * 运行动作。listRunTimeline **不填**这个字段 —— 动作单独成行，跟随运行数全量读会
       * 线性膨胀（500 次运行 × 上限 1000 条）；要动作时经 store.listRunEvents 按 runId 拉。
       */
      events?: UserScriptRunEvent[]
      /** 结束时刻与原因（见 UserScriptRunLogEntry；未结束或结束信号没赶上时缺省） */
      endedAt?: number
      endReason?: RunEndReason
      errors: UserScriptErrorRecord[]
    }
  | { kind: 'error'; record: UserScriptErrorRecord }

/**
 * zip 内源码文件的后缀：**路径以它结尾的条目即源码**（文件名叫什么都行）。
 * 用 `.user.js` 而不另立名字：从 GreasyFork / GitHub 直下的脚本落进 zip 就能导入，不必先改名。
 */
export const SCRIPT_EXT = '.user.js'

// —— zip 导入报告——
//
// 导入不淘汰脚本：凡以 `.user.js` 结尾的条目都落盘并说明，其余文件列进 ignored 报告。
// 故 ok 条目可带 notes（字段兜底提示）；failed 只留给落盘本身出错（写源码 / 写状态库抛错）。

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

/** 导入失败的条目——落盘本身出错（写源码 / 写状态库抛错） */
export interface ImportItemFailed {
  status: 'failed'
  /** 出错脚本的名字（落盘前已取到的那个） */
  name: string
  reason: string
}

export type ImportItemResult = ImportItemOk | ImportItemFailed

/** 导入时未导入的文件（非 `.user.js` 条目；仅展示） */
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
  /** 未导入的文件（非 `.user.js` 条目），仅展示、不影响成功/失败计数 */
  ignored: ImportItemIgnored[]
}

/** 新建项目的默认配置：allFrames true / runAt document_idle（对齐 TM 的默认值） */
export function defaultConfig(matches: string[]): ScriptConfig {
  return { matches, allFrames: true, runAt: 'document_idle' }
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
    `console.log('[${EXTENSION_NAME}脚本] 已注入', location.href)`,
    '',
  ].join('\n')
}
