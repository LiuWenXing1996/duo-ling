// background = 桌面版 main 进程的能力运行时。
// 职责：用户脚本的**注册与运行时**（chrome.userScripts）+ 项目状态库写命令的转发方
// + offscreen 容器管理 + 模型配置中转。
// 对话、模型配置不走这里（各自直连 IndexedDB：duoling-chat / duoling-app）。
//
// 存储分工：
//   · 注册态（元数据 + 源码搬运副本 + enabled）—— 权威在独立 IndexedDB 库 duoling-state，
//     **写只归 offscreen**（单写方）：读 —— 本文件直连 project-store，**不经容器**，
//     注册链路不能押在 offscreen 存活上，否则容器一挂所有脚本都不生效；
//     写 —— 经 OffscreenService 的 userscript* 方法落盘，写完从状态库读回再注册。
//   · 源码 —— 唯一来源在 duoling-fs（offscreen 独占的 lightning-fs 库 + git 版本化），
//     SW 读不到 lfs，源码读写一律走 OffscreenService 代理向 offscreen 取
//     （实现落在 @duoling/offscreen-document）。
// GM 值存储 / GM tab 值在 IndexedDB 库 duoling-usdata；观测数据（标签页存续 + 一根活动轴：
// 文档事件 / 记录开关 / 接口采样 / 运行条目 / 动作 / 错误）在 IndexedDB 库 duoling-runtime
// ——两者都 SW 直写、写侧收敛在 store.ts。

import '@/polyfills' // 必须在最前：补全 SW 的 global/Buffer/process 全局，早于 isomorphic-git 引用
import { defineBackground } from '#imports'
import type { ModelProfileState, PageOverviewTab, RuntimeRequest } from '@duoling/shared'
// 注入物的形状取自同一处，本文件不再各写一份（加字段时只改一处才不会漏）
import type { InjectedBuildInfo } from '@duoling/shared'
import { EXTENSION_NAME } from '@duoling/shared'

// 用户脚本管理器（v2 方案）：引擎 + 存储 + GM 桥 + 类型
// 通用引擎件直取包（世界配置 / 单脚本与全量注册 / 可用性检测 / CSP 收集 / 注入码解析）
import {
  configureUserScriptsWorld,
  ensureWorldsConfigured,
  isUserScriptsAvailable,
  registerAllEnabled,
  recoverOnUpdate,
  registerScript,
  unregisterScripts,
  collectCspWarnings,
  resolveInjectCode,
  onAvailabilityChange,
  startAvailabilityWatch,
  createServiceWorkerHost,
  swIpcHandlers,
  SW_IPC_OWNED_KINDS,
  SWService,
  clearGMValues,
} from '@duoling/service-worker'
// 本扩展自己的注入件注册同步（系统脚本 + 中继件并集）与内置件对账
import {
  refreshBuiltinScripts,
  refreshTabRecorder,
  listBuiltinRegistrations,
  builtinsOnPage,
  BUILTIN_SCRIPT_IDS,
  syncAllBuiltins,
} from '@duoling/service-worker'
// BuiltinRegistration 是跨世界契约形状，真相源在 shared（engine 只是产生方）
import type { BuiltinRegistration } from '@duoling/shared'
// metadata 解析（纯函数）：仅用于把「源码声明与界面配置的差异」当提示回给编辑器；
// 真正的归一化在写入口一处（offscreen 写侧的 saveSource），此处不写回任何东西
import {
  resolveConfigFromSource,
  createOffscreenService,
  registerSWService,
  type SaveOutcome,
} from '@duoling/shared'
// 标签页录制：录到的采样与语料压缩都归 SW（采样在 duoling-runtime 的 tab_events，
// offscreen 与扩展页都不直连）。录制的开关跟着活动记录走，判据落在存续表上 —— 见 tab-sessions。
import { describeCaptureDigest, describeCaptureRecords } from '@duoling/shared'
// 引擎可用性监视（检测层）：SW 保活后自行轮询，变化时经 onAvailabilityChange 通知消费层
// 新版本检查：SW 在浏览器启动 / 安装更新时各查一次，结果落 duoling-app 库供 popup 与设置页读
import { runUpdateCheck } from '@duoling/shared'
// GM 运行时接线：SW 侧工厂（配置注入 + 桥与 Port 监听注册同点完成，见 initUserScripts）
// + SW 侧服务实体（代理调用经库 listener 直达，不占总线 matcher 位）
// OffscreenService 消费侧：项目数据的写路径（见下方 offscreenService）
// 标准化总线：本语境命令面唯一的 onMessage 收口（serveIpc）+ 路由 matcher（前缀表 / 包命令面）
import { ipcNotify, ipcRequest } from '@duoling/shared'
import { packMatcher, prefixMatcher, serveIpc } from '@/shared/ipc-bus'
import { duolingTelemetry } from '@duoling/service-worker'
// 产品内置件注入面：内置注册 id 全集（stale 清扫排除）与四件全量同步（挂包侧注册串行链）
// 标签页存续（tabId 的稳定替身）：开关（连同「开始 / 结束记录」两条标记）、事件（刷新、地址变更）、
// 盖章与启动划断（都替当时还在记的行收个尾）都归 SW ——「这一页在不在记活动、经历了什么、
// 什么时候关的」只有常驻 SW 看得见，扩展页与 offscreen 都不该各记一份。
import {
  noteTabClosed,
  noteTabReloaded,
  noteTabUrlChanged,
  reconcileDeadTabSessions,
  setTabRecording,
  splitTabSessionsAtBrowserStart,
} from '@duoling/service-worker'
// 项目数据：读侧（直连 IndexedDB，SW 与扩展页共用）+ 写命令面（转发 offscreen）
import { getProject, listProjects, listSummaries } from '@duoling/shared'
// 握手密钥的持久化（经 secretStore 注入包侧）：duoling-app 库的 kv 读写
import * as appDb from '@duoling/shared'
// 观测数据的写出口：错误日志、运行条目与动作
import {
  clearRunLog,
  clearUserScriptErrors,
  appendUserScriptError,
  findUserScriptError,
  listRunTimeline,
  listRunEvents,
  markRunEnd,
  clearAllTabActivity,
  deleteTabActivity,
} from '@duoling/service-worker'
// GM 值存储（duoling-usdata 库）：脚本删除 / 清库时清各自的值
// 观测数据的底层表（duoling-runtime 库）：存续表全量给「活动历史」按标签页分档用；
// 某一页的整根活动轴（存续轴事件 + 接口采样）一次读回 —— 录制按标签页，读也就按标签页。
import { findOpenTabSession, listTabSessions, listTabTimeline } from '@duoling/service-worker'
// 对话界面页面脚本监控（运行时口径）：按 tab 的运行登记 + 面板端口 —— 工具栏角标的数字就是它
import {
  forgetPageTab,
  initPageMonitorPorts,
  onPageRunsChanged,
  pageRunsByTab,
  resetPageRuns,
  snapshotForTabs,
} from '@duoling/service-worker'
// 会话的标签页归属映射（duoling-app 库）：标签页关闭时在这里清（见 tabs.onRemoved 处说明）；
// page:snapshot 也用它反查「这条会话在哪个标签页上」（会话按 tab 归属）；
// popup 的页面概览靠它回答「这个页面归属哪条会话」
import {
  findTabsUsingConversation,
  getConversationIdForTab,
  getTabConversationMap,
  unbindTab,
} from '@duoling/shared'
// 会话库（duoling-chat，**写只归 offscreen**）：页面概览里显示会话标题，这里只读
import { listConversations } from '@duoling/shared'
// 「这一页是不是普通网页」的判据（页面概览只收普通网页，与 popup 的按钮判据同源）
import { webHostname } from '@duoling/shared'
import type {
  ImportReport,
  RunEndReason,
  ScriptGroup,
  ScriptProject,
} from '@duoling/shared'

// offscreen document 容器（AI 生成链路的执行宿主）
import {
  ensureOffscreen,
  closeOffscreen,
  isOffscreenReady,
  ensureOffscreenReady,
} from '@duoling/service-worker'
// 模型配置：offscreen 既不直连存储、也不 import model-store（SW 专属模块），一律由
// SW 经命令中转；变更推送由 model-store 写出口直发（offscreen 侧见包内 bootstrap.ts）。
import { getActiveProfileState } from '@duoling/shared'
// 数据变更广播：落盘后通知全部前端实例回拉（IDB 没有变更通知，这条线由它补上）
import { broadcastBuildPhase } from '@duoling/shared'
// AI 工具支路：page_snapshot / page_env_read 两条工具经 SW 向页面里的页面检查器下发指令
// （offscreen 不可达该 API）—— 下发封装与配对都在包内 page-inspector-bridge
import {
  capturePageEnvFromTab,
  capturePageSnapshotFromTab,
} from '@duoling/service-worker'
// 目标页可注入判据与「引擎不可用」文案：与对话界面发起侧同一处
import {
  isUserScriptsApiAvailable,
  pageInjectionBlockReason,
  userScriptsUnavailableMessage,
} from '@duoling/shared'
// 拾取指令的下发与配对（常驻件那半在页面里，件源码见包的 inspector/install.ts）
import { cancelPicker, runInspectorCommand } from '@duoling/service-worker'
import {
  collapseFloatPanel,
  openFloatPanel,
  pingFloatHost,
  setFloatPanelBusy,
} from '@duoling/service-worker'
import type { ElementPickContext } from '@duoling/shared'
import { errorText } from '@duoling/shared'

/**
 * SW 管辖的 kind 前缀（路由白名单）。
 *
 * offscreen 与 SW 同时在监听 runtime 消息，而 sendResponse 对一条消息只有一次机会 ——
 * SW 只应响应这里登记的前缀，其余（offscreen 的 fs: / conv: / chat:）必须让路，
 * 否则 SW 会抢答、把 offscreen 的响应挤掉。
 *
 * 新增命令时若忘了登记前缀，该命令会静默无响应（而不是报「未知消息类型」）——
 * 这是刻意的：静默比一个假错误更诚实。
 *
 * export 仅供协议一致性测试（extension-ipc.test.ts）做 kind 归属断言。
 */
export const SW_KIND_PREFIXES = [
  'userscript:',
  'model:',
  'offscreen:',
  'sw:',
  'page:',
  'picker:',
  'float:',
  'tab:',
] as const

/**
 * SW 管辖的请求（由上面的前缀推导，两者必须同源）。
 *
 * handlers 表只登记这些 kind：`fs:*` / `conv:*` / `chat:*`（offscreen 管辖）都归 offscreen
 * 应答——它们不是 SW 的职责，不该为凑齐类型而塞进 handlers 表补死桩。
 *
 * 再减去包自管的 kind（SW_IPC_OWNED_KINDS）：管理面只读四条由 @duoling/service-worker 的
 * handler pack 应答，而 pack matcher 排在总线的问询首位——前缀表里不该出现它们的 handler。
 * 四条虽落在 `userscript:` 前缀内，归属由 matcher 顺序定，不靠前缀互斥；重复登记会被这张
 * 映射类型拒（编译期暴露，不会静默变成永不执行的分支）。
 */
type SwRequest = Exclude<
  Extract<RuntimeRequest, { kind: `${(typeof SW_KIND_PREFIXES)[number]}${string}` }>,
  { kind: (typeof SW_IPC_OWNED_KINDS)[number] }
>

/**
 * 项目数据的写路径：写只归 offscreen（单写方），本处经服务代理调容器里的 OffscreenService。
 *
 * 容器刚被回收 / 扩展重载后首次调用会失败（报文发不到监听方），故按**错误文案**判据重试一次：
 * 命中即把容器拉起来（就绪判据是「能应答 fs:ping」而不是「文档已存在」），起来了才重试。
 * 业务异常（脚本不存在、源码不是字符串…）不重试 —— 重试一次也是同样的错，只让用户白等。
 * 写方法都是读改写，重复执行一次不会产生第二份数据。
 * （UI → SW 那条链路的同款判据见 lib/userscripts/ui-client.ts。）
 */
const OFFSCREEN_GONE = /port closed|Receiving end does not exist|Could not establish connection|无响应/
const offscreenService = createOffscreenService(async (error) => {
  if (!OFFSCREEN_GONE.test(errorText(error))) return false
  return await ensureOffscreenReady()
})

/**
 * 注册失败：记入错误日志（在活动历史的「未知标签页」档里看），并返回错误文案给 UI 展示。
 *
 * **不 throw**——调用方（create / updateFiles / toggle）在注册前已完成数据写
 * （状态库 + git 快照都落了盘），注册只是让脚本「生效」的最后一环。把注册失败判成整个
 * 命令失败，会让用户看到「创建失败」但列表刷新后脚本明明在（违背直觉）。
 * 故降级：命令成功 + registerError 警告字段，UI 决定怎么呈现。
 */
async function registerOrLog(project: ScriptProject): Promise<string | undefined> {
  // 环境 / 权限不可用（Chrome ≥138 未开「Allow User Scripts」等）：注册必然失败，
  // 但这**不是脚本本身的错**——不能写成该脚本的 register 错误（否则误导成「每个脚本都有问题」）。
  // 环境状态由列表页 availability 横幅统一兜底，这里只把原因回传调用方，不落 per-script 记录。
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') {
    return '用户脚本功能不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，Chrome <138 需开启全局「开发者模式」，Firefox 需授权 userScripts 权限'
  }
  try {
    // 先同步内置注册（中继件，启用脚本集合可能变化），再注册脚本——保证中继件与包装密钥同代
    await refreshBuiltinScripts().catch(() => {})
    await registerScript(project)
    return undefined
  } catch (e) {
    const message = errorText(e)
    // 到这里仍是脚本自身缺陷（缺 matches / match 非法 / 构建产物无效 / 世界配置失败等），属该脚本，写记录
    void appendUserScriptError({
      uuid: project.uuid,
      name: project.name,
      phase: 'register',
      message,
    }).catch(() => {})
    return message
  }
}

// —— popup 页面概览的三份查表 ——
// 都是「读侧尽力而为」：库读不出来就交白卷，行内退化成 uuid 前缀 / 只显示状态，不叫整条命令失败。

/** uuid → 脚本展示名（概览的脚本行用） */
async function scriptNameByUuid(): Promise<Map<string, string>> {
  try {
    return new Map(listSummaries(await listProjects()).map((s) => [s.uuid, s.name]))
  } catch {
    return new Map()
  }
}

/** 会话 id → 标题（概览里显示会话用） */
async function conversationTitleById(): Promise<Map<string, string>> {
  try {
    return new Map((await listConversations()).map((c) => [c.id, c.title]))
  } catch {
    return new Map()
  }
}

/** tabId → 会话 id（归属映射读不出来时当作全未绑定，好过让整条概览失败） */
async function conversationBindings(): Promise<Record<string, string>> {
  try {
    return await getTabConversationMap()
  } catch {
    return {}
  }
}

/**
 * 定位「这条会话所属的标签页」并在注入前拦掉不可注入的页。
 *
 * 两条 AI 支路共用（页面快照 / 页面环境读数）：判据必须一致 —— 会话按标签页归属，而这类读取
 * 都是 AI 在生成中途自己决定发起的，那时用户完全可能已经切走；查「当前激活页」会把别人那一页
 * 的数据喂给模型。反查走归属映射，自带 tab 存活校验（tab 已关的残留项会被判掉）。
 *
 * what 只进报错文案，让两条支路各自说清「读不到的是什么」。
 */
async function resolveAiTargetTab(
  conversationId: string | undefined,
  what: string,
): Promise<number> {
  if (!chrome.tabs?.query) throw new Error('无法定位目标标签页')
  const owned = conversationId ? await findTabsUsingConversation(conversationId) : []
  let tabId: number | undefined = owned[0]
  if (tabId == null) {
    // 兜底：会话没绑标签页（那条 tab 已关 / 映射缺项）→ 退回最后聚焦窗口的激活页，
    // 总比直接失败强；SW 无窗口上下文，lastFocusedWindow 语义 = 用户最后聚焦的窗口
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    tabId = tab?.id
  }
  if (tabId == null) throw new Error('未找到目标标签页')
  // 内置页 / 扩展页拦在注入前（判据与页面检查器共用，见 pageInjectionBlockReason——扩展页连自己
  // 的也不行，<all_urls> 不覆盖 chrome-extension scheme）
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  const blocked = pageInjectionBlockReason(tab?.url)
  if (blocked) throw new Error(`${blocked}，无法${what}`)
  return tabId
}

/**
 * 定位「用户此刻看着的标签页」并在下发前拦掉不可注入的页（拾取专用）。
 *
 * 与 resolveAiTargetTab 的口径刻意不同：那条认**会话归属**（AI 在生成中途自己决定要读，
 * 那时用户可能已经切走）；这条认**激活页** —— 拾取由用户在看得见的面板上点按钮发起，
 * 浮层只在自己那个 tab 可见，那一刻它必然在激活页上，不必也不该去查归属。SW 无窗口上下文，
 * lastFocusedWindow 即用户最后聚焦的那个窗口。
 *
 * 名字避开 owning-tab 的 resolveActiveTabId：那个是「扩展页认自己属于哪个标签页」，
 * 这条是「SW 替一次用户动作找目标页」，别混。
 */
async function resolvePickTargetTab(what: string): Promise<number> {
  if (!chrome.tabs?.query) throw new Error('无法定位目标标签页')
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab?.id == null) throw new Error('未找到活动标签页')
  const blocked = pageInjectionBlockReason(tab.url)
  if (blocked) throw new Error(`${blocked}，无法${what}，请切到要操作的网页后重试`)
  return tab.id
}

/**
 * 引擎不可用就不必白跑一趟下发。判据与文案都取发起侧那一份（element-picker-client）——
 * 在这里另写一遍，两处说法迟早分叉。
 */
function ensureInspectorAvailable(): void {
  if (!isUserScriptsApiAvailable()) throw new Error(userScriptsUnavailableMessage())
}

// 第二个参数是 chrome 的消息发送方：只有需要「回 sender 自己的东西」的命令才用得上
// （现仅 tab:identify 取 sender.tab.id）；其余 handler 少写一个参数即可，TS 允许。
const handlers: {
  [K in SwRequest['kind']]: (
    msg: Extract<SwRequest, { kind: K }>,
    sender: chrome.runtime.MessageSender,
  ) => Promise<unknown>
} = {
  // —— offscreen 容器——
  // A 组只做容器与通道：这几个命令供手动 / 调试触发；B 组的生成入口会直接调 ensureOffscreen()。
  // 唤醒容器并**等到它真的能应答**才返回——调用方（offscreenService 等）无须再 sleep 猜监听器是否注册好。
  // 常见路径几乎不等待：容器已在时第一次探测即成功。ready=false 表示超时未就绪，由调用方重试。
  'offscreen:ensure': async (): Promise<{ ready: boolean }> => ({
    ready: await ensureOffscreenReady(),
  }),

  'offscreen:close': async (): Promise<void> => closeOffscreen(),

  'offscreen:status': async (): Promise<{ ready: boolean }> => ({ ready: await isOffscreenReady() }),

  /** offscreen 启动握手（offscreen → SW）：容器自己报告已就绪，便于排查启动问题 */
  'offscreen:ready': async (): Promise<void> => {
    console.log('[duoling:offscreen] 容器已就绪')
  },

  // 模型配置：offscreen 拉取当前生效配置（含 apiKey）。复用现成的 getActiveProfileState()，
  // SW 里本来就能调；offscreen 侧须「取一次、缓存、不写日志」。
  'model:getActiveProfile': async (): Promise<ModelProfileState | undefined> => getActiveProfileState(),

  // —— AI 工具支路 ——
  // 两条都请 SW 代办：chrome.tabs 在 offscreen 不可达，而在 SW 与注册链路同源
  // （受 138+ 逐扩展开关管控）。page_snapshot 取页面 DOM，page_env_read 取页面侧环境读数。
  // 目标页判据见 resolveAiTargetTab —— 两条共用，别在这里另写一份。
  'page:snapshot': async (
    msg,
  ): Promise<Awaited<ReturnType<typeof capturePageSnapshotFromTab>>> => {
    ensureInspectorAvailable()
    return capturePageSnapshotFromTab(await resolveAiTargetTab(msg.conversationId, '采集页面快照'))
  },

  'page:env': async (
    msg,
  ): Promise<Awaited<ReturnType<typeof capturePageEnvFromTab>>> => {
    ensureInspectorAvailable()
    return capturePageEnvFromTab(await resolveAiTargetTab(msg.conversationId, '读取页面环境'))
  },

  // —— 拾取（浮层发起的用户动作）——
  // 目标页判据见 resolvePickTargetTab —— 与上面两条 AI 支路刻意不同，别在这里另写一份。
  // 下发与结果配对都在 page-inspector-bridge：件在页面里常驻待命，指令经 DL Port 事件帧下去，
  // 结果由件经脚本桥 __dlEvent 信封上来（dl-bridge 分流后交 handleInspectorEvent）。
  'picker:pick': async (): Promise<ElementPickContext | null> =>
    runInspectorCommand<ElementPickContext>(await resolvePickTargetTab('点选元素'), 'pick'),

  'picker:cancel': async (): Promise<null> => {
    await cancelPicker()
    return null
  },

  // —— 浮层宿主命令面 ——
  // 件已转 MAIN 世界系统脚本，tabs.sendMessage 到不了它：四条动作都在 SW 经
  // float-bridge 下发（DL Port 事件帧 float.cmd，按系统脚本 uuid + tabId 寻址）。
  // open 报错（推不到 = 该页上没有件的在岗连接），其余单向动作静默。
  'float:open': async (msg): Promise<null> => {
    if (!openFloatPanel(msg.tabId)) {
      throw new Error('浮层没接上：页面可能还没加载完，刷新页面后再试')
    }
    return null
  },

  'float:collapse': async (msg): Promise<null> => {
    collapseFloatPanel(msg.tabId)
    return null
  },

  'float:busy': async (msg): Promise<null> => {
    setFloatPanelBusy(msg.tabId, msg.busy)
    return null
  },

  'float:ping': async (msg): Promise<{ pong: boolean }> => ({
    pong: await pingFloatHost(msg.tabId),
  }),

  // —— popup 的页面概览（「当前页面 / 其他页面」两个区块的数据源）——
  // 为什么在 SW 一处聚齐：运行登记表（pageRunsByTab）、进行中会话（runningConversations）、
  // 会话归属（duoling-app 的 convByTab）分属三方，popup 自己拼会拼出三份时间点不同的快照。
  'page:overview': async (): Promise<PageOverviewTab[]> => {
    const tabs = await chrome.tabs.query({}).catch(() => [])
    // 只收普通网页：内部页 / 扩展页上既跑不了脚本也挂不了浮层（读不到 url 的页正是这两类）
    const web = tabs.filter((t) => t.id != null && webHostname(t.url) !== '')
    const [snapshots, bindings, names, titles, tabSessions, builtins] = await Promise.all([
      snapshotForTabs(web.map((t) => t.id as number)),
      conversationBindings(),
      scriptNameByUuid(),
      conversationTitleById(),
      // 记录开关按 tab 认领（表里只有被打开过记录的页）
      listTabSessions(),
      listBuiltinRegistrations(),
    ])
    // 正在记活动的标签页：未结束 + 开着记录才算 —— 已结束的行只是历史痕迹
    const recordingTabs = new Set(
      tabSessions.filter((s) => s.ended !== true && s.recording === true).map((s) => s.tabId),
    )
    return web.map((t) => {
      const tabId = t.id as number
      const snap = snapshots.get(tabId)
      const runs = [...(snap?.runs ?? [])].sort((a, b) => b.startedAt - a.startedAt)
      const errors = snap?.errors ?? []
      const conversationId = bindings[String(tabId)] ?? null
      const recording = recordingTabs.has(tabId)
      return {
        tabId,
        url: t.url ?? '',
        title: t.title ?? '',
        scripts: runs.map((r) => ({
          uuid: r.uuid,
          name: names.get(r.uuid) ?? r.uuid.slice(0, 8),
          errorCount: errors.filter((e) => e.uuid === r.uuid).length,
        })),
        builtins: builtinsOnPage(builtins, t.url ?? '', recording).map((b) => ({
          id: b.id,
          name: b.name,
        })),
        conversationId,
        conversationTitle: conversationId ? (titles.get(conversationId) ?? null) : null,
        generating: conversationId ? runningConversations.has(conversationId) : false,
        tabRecording: recordingTabs.has(tabId),
      }
    })
  },

  // —— 浮层宿主件自证身份 ——
  // 回 sender 自己的 tab id：宿主件跑在用户脚本世界，那里拿不到 chrome.tabs，而网页浮层（扩展页
  // iframe）必须知道「自己属于哪个 tab」才能认定会话归属（每 tab 一条会话）。
  // 取不到时回 null（扩展页发的消息本就没有 tab），由调用方降级——浮层拿不到 tabId 的
  // 情况下会话归属退化为「不绑定」，而不是错绑到别的 tab。
  'tab:identify': async (_msg, sender): Promise<{ tabId: number | null }> => ({
    tabId: sender.tab?.id ?? null,
  }),

  // —— 用户脚本管理器（IPC 命令名沿用既有，载荷为项目形态）——
  // list / getProject / groups / availability 四条只读命令归运行时包的 handler pack
  // （@duoling/service-worker 的 swIpcHandlers，总线问询面在本监听器之前应答）——
  // 它们只依赖包内能力，宿主不重复实现。

  // 扩展内置注入件此刻的注册状态（只读透出，供工作台脚本列表底部的分区展示）
  'userscript:builtins': async (): Promise<BuiltinRegistration[]> => listBuiltinRegistrations(),

  // 保存源码（唯一保存入口）：转 offscreen 统一保存（写 fs + git 提交 + 落库），
  // 落库后启用中则重注册。**保存恒成功、保存即注入**（无构建流程，注入代码 = 源码原文）。
  'userscript:save': async (
    msg,
  ): Promise<{ warnings?: string[]; registerError?: string }> => {
    // 转发前先广播「保存中」瞬态：列表行立即转圈（链路收尾的落库广播负责切终态
    // ——见 @duoling/shared 的 DataChangedPush.phase 说明）
    broadcastBuildPhase('script', msg.uuid, 'saving')
    const outcome: SaveOutcome = await offscreenService.userscriptSave(msg.uuid, msg.code, {
      name: msg.name,
      config: msg.config,
      note: msg.note,
      actor: msg.actor,
    })
    const next = outcome.project
    await unregisterScripts([next.uuid]).catch(() => {})
    const registerError = next.enabled ? await registerOrLog(next) : undefined
    return {
      // metadata 解析提示（@include 放宽 / 正则被丢弃 / @match 不合法…）与 CSP 警告同一通道到编辑器，
      // 提示由写侧一处产出（SaveOutcome.notes）——避免 SW 再解析一遍、拿不到当时那个 fallback 而误报
      warnings: [...collectCspWarnings(resolveInjectCode(next)), ...outcome.notes],
      registerError,
    }
  },

  // 新建脚本（零输入）：命名 / 初始模板 / 首次快照全在 offscreen 侧完成，SW 只负责注册。
  'userscript:create': async (): Promise<{ uuid: string; name: string; warnings?: string[]; registerError?: string }> => {
    const project = await offscreenService.userscriptCreate()
    const registerError = await registerOrLog(project)
    return {
      uuid: project.uuid,
      name: project.name,
      warnings: collectCspWarnings(resolveInjectCode(project)),
      registerError,
    }
  },

  // AI 生成脚本落盘：转发 offscreen 单写方
  // （写状态库 + git 快照，note = AI summary），enabled 为真才注册——生成与生效解耦，
  // AI 产物默认零影响；启用走现成的 userscript:toggle。
  'userscript:createProject': async (msg): Promise<{ uuid: string; name: string; warnings?: string[]; registerError?: string }> => {
    const project = await offscreenService.userscriptCreateGenerated({
      name: msg.name,
      config: msg.config,
      code: msg.code,
      enabled: msg.enabled,
      note: msg.note,
    })
    const registerError = project.enabled ? await registerOrLog(project) : undefined
    return {
      uuid: project.uuid,
      name: project.name,
      warnings: [
        ...collectCspWarnings(resolveInjectCode(project)),
        // AI 产物可能自带 metadata 块：SW 手上有当时的 fallback（msg.config），可精确算出提示
        ...resolveConfigFromSource(resolveInjectCode(project), msg.config).notes,
      ],
      registerError,
    }
  },

  // 删除：注销 → offscreen 清状态库记录 + git 仓 → 清该脚本的 GM 值 + 报错记录。
  // 仓的删除与状态库同在 offscreen 写侧，一步清干净（不靠启动对账兜滞留）。
  'userscript:remove': async (msg): Promise<void> => {
    // 注销失败不能纯静默：状态库删掉后这条 uuid 不再出现在任何对账清单里，
    // 幽灵注册会一直注入到下次 SW 冷启动（registerAllEnabled 全量对账）才被清
    await unregisterScripts([msg.uuid]).catch((e) =>
      console.warn('[duoling:sw] 删除前注销失败（SW 冷启动对账会清，但期间页面刷新仍会注入）：', msg.uuid, e),
    )
    await offscreenService.userscriptRemove(msg.uuid)
    // 该脚本对内置并集的贡献随状态库删除而消失，中继件可能需要注销。
    // 必须放在清库**之后**：清库前读库还算得进这个脚本，并集「未变」、中继件被已在位检查跳过，
    // 中继件就带着已删脚本的 matches 残留（removeAll 之前整体漏调同属这一族问题）
    await refreshBuiltinScripts().catch(() => {})
    await clearGMValues(msg.uuid)
    // 报错记录同属该脚本的残留：不清就会在错误日志里留下一个已删脚本的孤儿分组
    // （按 uuid 清，不碰「未归属」那种本就没有脚本上下文的记录）
    await clearUserScriptErrors(msg.uuid)
    // 运行条目与动作同理：不清就会在「活动历史」里留下已删脚本的孤儿运行条
    await clearRunLog(msg.uuid)
  },

  // 删除全部用户脚本（「全部删除」按钮）：注销全部 → offscreen 清状态库 + 各仓 → 清各脚本
  // 的 GM 值与报错记录。范围 = 新形态用户脚本；内置件随扩展包分发、不在状态库。
  // uuid 由 SW 直读状态库（不经容器，与 userscript:list 同源），用于注销与清残留。
  'userscript:removeAll': async (): Promise<{ removed: number }> => {
    const uuids = (await listProjects()).map((p) => p.uuid)
    // 注销失败不能纯静默（与单删/关停同语义）：吞掉后这批 uuid 成幽灵注册——
    // 页面刷新照样注入；且 SW 由 offscreen 心跳保活常驻（@duoling/offscreen-document 的 keepalive，无条件），
    // registerAllEnabled 的冷启动对账不会跑，幽灵能一路活到下次浏览器重启
    await unregisterScripts(uuids).catch((e) =>
      console.warn('[duoling:sw] 全部删除前注销失败（SW 冷启动对账会清，但期间页面刷新仍会注入）：', uuids, e),
    )
    try {
      const removed = await offscreenService.userscriptRemoveAll()
      // 状态库清空后再同步内置并集：此时读库必为空 → 中继件与录制转发件整体注销。
      // 漏了这步的话，中继件会带着旧并集残留注册，白占每个页面的注入面
      await refreshBuiltinScripts().catch(() => {})
      for (const uuid of uuids) await clearGMValues(uuid)
      // 报错记录逐 uuid 清（与单删同一条语义：删脚本 = 清该脚本名下的一切）
      for (const uuid of uuids) await clearUserScriptErrors(uuid)
      for (const uuid of uuids) await clearRunLog(uuid)
      return { removed }
    } catch (e) {
      // 注销在前、落盘在后，落盘失败会留下「记录还标 enabled、实际已注销」的偏差
      // （删了一部分时更明显）——按状态库重新对齐注册，再抛出真实错误
      await registerAllEnabled().catch(() => {})
      throw e
    }
  },

  // 返回 registerError：enabled 已落状态库（数据写先于注册完成），注册失败只降级为警告，
  // 不把启停整体判失败（否则 UI 不更新开关，与实际已生效的 enabled 状态背离）。
  'userscript:toggle': async (msg): Promise<{ registerError?: string }> => {
    // 先读一次确认存在（状态库直读，不经容器），否则转发后才知道不存在、白搭一趟
    if (!(await getProject(msg.uuid))) throw new Error('脚本不存在')
    // enabled 不进 git 仓（buildContents 刻意排除），故只改状态库、不产生提交
    const next = await offscreenService.userscriptToggle(msg.uuid, msg.enabled)
    if (msg.enabled) return { registerError: await registerOrLog(next) }
    // 同 userscript:remove：关停注销失败别静默，否则开关显示已关、页面里还在注入
    await unregisterScripts([msg.uuid]).catch((e) =>
      console.warn('[duoling:sw] 关停注销失败（SW 冷启动对账会清，但期间页面刷新仍会注入）：', msg.uuid, e),
    )
    // 关停后内置并集可能缩小，中继件可能需要注销
    await refreshBuiltinScripts().catch(() => {})
    return {}
  },

  // 重命名脚本：只改状态库的 name（不入仓、不产生提交），落库后启用中则重注册——
  // 名字进 GM_info 与错误日志里的脚本名，不重注册的话已注入的脚本仍顶旧名。
  // 同 toggle：注册失败只降级为警告，不把改名判失败（名字已落库）。
  'userscript:rename': async (msg): Promise<{ registerError?: string }> => {
    if (!(await getProject(msg.uuid))) throw new Error('脚本不存在')
    const next = await offscreenService.userscriptRename(msg.uuid, msg.name)
    return next.enabled ? { registerError: await registerOrLog(next) } : {}
  },

  // zip 导入：纯转发 offscreen 单写方（解码 + 落盘同处）。导入恒 enabled:false——「先审后启」
  // 是产品原则，落盘后由用户手动启用（userscript:toggle），故此处**无注册动作**
  // （与 create / toggle 不同：不调 registerOrLog）。
  'userscript:import': async (msg): Promise<ImportReport> =>
    offscreenService.userscriptImportZip(msg.zipBase64),

  // 粘贴导入：一段脚本源码 → 一个脚本。解析与落盘都归 offscreen 单写方，SW 只转发；
  // 语义照抄 zip 导入——恒 enabled:false（先审后启），故此处同样**无注册动作**。
  'userscript:importText': async (msg): Promise<ImportReport> =>
    offscreenService.userscriptImportText(msg.code),

  // 脚本列表分组读侧（userscript:groups）也归运行时包 handler pack（直连 IDB 的纯读）。

  // 把脚本归入某分组 / 退回未分组：走 offscreen 单写方（group 不入 git 仓，不产生提交）
  'userscript:setGroup': async (msg): Promise<ScriptProject> =>
    offscreenService.userscriptSetGroup(msg.uuid, msg.group),

  // 分组管理（新建 / 重命名 / 删除 / 重排）：同走 offscreen 单写方，SW 无副作用
  'userscript:group-create': async (msg): Promise<ScriptGroup> =>
    offscreenService.userscriptGroupCreate(msg.name),
  'userscript:group-rename': async (msg): Promise<ScriptGroup> =>
    offscreenService.userscriptGroupRename(msg.id, msg.name),
  'userscript:group-remove': async (msg): Promise<void> =>
    offscreenService.userscriptGroupRemove(msg.id),
  'userscript:group-reorder': async (msg): Promise<void> =>
    offscreenService.userscriptGroupReorder(msg.orderedIds),

  // 运行时间线：运行条 + 对不上运行集的错误行混排（消费方是 AI 的 run_log_read；
  // 活动历史面板按页读整根轴，不走这条）
  'userscript:runlog': async (): Promise<ReturnType<typeof listRunTimeline>> => listRunTimeline(),

  // 标签页存续表全量：活动历史按标签页分组时取名字与时刻（分组键在运行条目上，表只补名字）
  'userscript:tabSessions': async (): Promise<ReturnType<typeof listTabSessions>> => listTabSessions(),

  // 某一页的整根活动轴：文档事件 / 记录开关 / 接口采样 / 运行条目 / 动作 / 错误（六类都在
  // tab_events 同表）一次查回、分五组返回。「活动历史」右栏用它铺这一页的时间线。
  // **按页而不是全量**：采样单条可达数 KB，全量拉等于把整库搬过来。
  'userscript:tabTimeline': async (msg): Promise<ReturnType<typeof listTabTimeline>> =>
    listTabTimeline(msg.tabSessionId, msg.sinceId),

  // 打开 / 关掉**这一页**的活动记录（popup 的开关）。判据落在标签页上：同一站点的其他页各开
  // 各的。地址由 SW 现取，不由 popup 带过来。
  // 打开时会顺手建行，好让这一页立刻出现在「活动历史」里（此后跑不跑脚本都无所谓）。
  //
  // **这一个开关就是录制开关**：存续行上那一枚 `recording` 布尔同时驱动两条写链 ——
  // 活动记录（事件与运行记账）与页面录制（这一页录到的请求）。录制没有第二本账，
  // 归属就是这一行；故这里只需建行 + 重算注册，没有额外的「开启录制」动作。
  //
  // 录制件是声明式注册、钩子挂在文档开头，故本条影响的是**下次导航**：当前页面要用户刷新才挂得上。
  //
  // **引擎不可用就拒绝**：录制件靠 chrome.userScripts 注册，引擎不可用时 refreshTabRecorder 静默
  // 空转，而库里已写下 recording: true —— 界面亮「正在记录」，实际脚本跑不了、请求也拦不到，是个
  // 纯假状态。拦在这条唯一入口上即可覆盖全部调用方（popup 的开关、浮层同意卡），两处 UI 各自
  // 已有错误展示位，不必另加。只拦开、不拦关：把假状态关掉是合法操作。
  // 存量已开的行不在这里收 —— 引擎恢复时补注册那一遍会顺带重算录制件，它自然变成真的在录。
  'userscript:tabActivityEnable': async (msg): Promise<{ tabId: number; recording: boolean }> => {
    if (!(await isUserScriptsAvailable())) throw new Error('用户脚本功能不可用，无法开始记录')
    const tab = await chrome.tabs.get(msg.tabId).catch(() => null)
    await setTabRecording(msg.tabId, true, tab?.url)
    await refreshTabRecorder().catch(() => {})
    return { tabId: msg.tabId, recording: true }
  },

  // 关掉只撤开关、不删记录：这一页的历史与已录内容都留着，只是不再长新的。
  // 撤销 recording 可能让注册集合变空（关的若是最后一页在录的），故重算一次。
  'userscript:tabActivityDisable': async (msg): Promise<{ tabId: number; recording: boolean }> => {
    await setTabRecording(msg.tabId, false)
    await refreshTabRecorder().catch(() => {})
    return { tabId: msg.tabId, recording: false }
  },

  // 「活动历史」删掉某一页：存续行 + 它在 tab_events 上的整根轴一起删（只删存续行会让这一页以
  // 「表里已查不到」的残影留在列表里）。
  'userscript:tabActivityDelete': async (msg): Promise<void> => {
    await deleteTabActivity(msg.tabSessionId)
  },

  // 「活动历史」清空全部：存续行 + tab_events 整根轴（含归不到标签页的无归属错误行）
  'userscript:tabActivityClear': async (): Promise<void> => {
    await clearAllTabActivity()
  },

  // 某次运行的动作（面板按需拉；AI 的 run_log_read 带 runId 时同路）
  'userscript:runEvents': async (msg): Promise<ReturnType<typeof listRunEvents>> =>
    listRunEvents(msg.runId),

  // 错误 ID 修复闭环：AI 的 error_read 工具经 offscreenBridge 到此代查。
  // 精确 id 或唯一 8 位前缀；多命中 / 不存在由信封里的 reason 区分（调用方给可读文案）
  'userscript:errorRead': async (msg): Promise<ReturnType<typeof findUserScriptError>> =>
    findUserScriptError(msg.id),

  // —— 页面录制（tab-record）——
  // 录到的采样在 duoling-runtime 的 tab_events，offscreen 拿不到那个库，故 AI 工具经此代读。
  //
  // 参数是**会话 id 而不是站点**：录制按标签页，读也就按标签页 —— 先由 SW 反查「这条会话所属的
  // 那一页」（resolveAiTargetTab，与页面快照 / 环境读数同一个判据），再取那一页存续行整根轴里的
  // 采样。AI 在生成中途自己决定要读时用户可能已经切走，按「当前激活页」读会把别人那页喂给模型。
  //
  // enabled 只表示「那一页此刻还开着录制」，**不约束能不能读到记录**：关掉开关只撤 recording、
  // 不清数据，之前录的照样读得到（否则「录完关掉再看」这条最自然的用法就没法走）。
  //
  // 未开录制时也正常返回（enabled:false, count:0）——调用方据此给准确提示，比抛错更好用
  // （「没开录制」和「开了但没刷新」要能分开说）。真正抛错的只有「定位不到那一页」。
  'userscript:tabRecordRead': async (
    msg,
  ): Promise<{ enabled: boolean; count: number; text: string }> => {
    const tabId = await resolveAiTargetTab(msg.conversationId, '读取页面录制')
    const row = await findOpenTabSession(tabId)
    const records = row ? (await listTabTimeline(row.tabSessionId)).captures : []
    const text =
      msg.mode === 'digest'
        ? describeCaptureDigest(records).join('\n')
        : describeCaptureRecords(records)
    return { enabled: row?.recording === true, count: records.length, text }
  },

  // 进行中的会话（工作台「会话历史」的「生成中」标与停止入口）。只回 id：那张表就是 id 集合，
  // 站点名 / 标签页这类展示信息 UI 侧自己按 id 取，不在这里多拼一份会过期的。
  'sw:runningChats': async (): Promise<string[]> => [...runningConversations],

  // SW 自证：把 define 注入的构建信息回给 UI（页面显示用，不依赖 SW DevTools 在场）。
  // 消息本身会唤醒休眠的 SW，唤醒后执行的这段代码持有的就是当前生效的 __BUILD_INFO__。
  'sw:buildInfo': async (): Promise<{ time: string; branch: string }> => __BUILD_INFO__,
}

/** 用户脚本管理器启动：挂载 GM 桥 + 配置 USER_SCRIPT 世界 + 恢复已启用项目 */
async function initUserScripts(): Promise<void> {
  // GM 运行时接线（包工厂）：遥测 / 扩展身份 / offscreen 就绪在此注入，桥与 Port 的全部
  // 监听在本调用内同步段挂上（第一帧纪律）。幂等：重复调用返回首例，不二次注册。
  createServiceWorkerHost({
    extensionName: EXTENSION_NAME,
    notificationIcon: 'icons/128.png',
    offscreen: { ensureReady: ensureOffscreenReady },
    telemetry: duolingTelemetry,
    // 握手密钥落 duoling-app 库（沿用既有键 pageSecret，零迁移）
    secretStore: { get: (k) => appDb.get<string>(k), set: appDb.set },
    // 产品内置件（中继件 / 检查器 / 浮层 / 录制件）挂进包侧全量链：
    // registerAllEnabled 先同步这批件、stale 清扫排除这些 id
    builtins: { ids: BUILTIN_SCRIPT_IDS, syncAll: syncAllBuiltins },
  })
  // chrome.userScripts 仅在已开启「Allow User Scripts」（Chrome ≥138）或全局开发者模式
  // （Chrome <138）/ 已授权 userScripts 权限（Firefox）时存在；否则为 undefined，
  // 直接调用会令 SW 初始化崩溃。先判存在性，不可用则优雅跳过（UI 横幅会引导开启）。
  if (!chrome.userScripts) {
    console.warn(
      '[duoling:userscript] 用户脚本功能不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，' +
        'Chrome <138 需开启全局「开发者模式」；Firefox 需授权 userScripts 权限。用户脚本功能已禁用。',
    )
    setEngineAvailable(false) // 角标该亮出 `!`：两种不可用情形（命名空间不在 / 命名空间在但实探抛错）都要标出来
    return
  }
  await configureUserScriptsWorld()
  const ok = await isUserScriptsAvailable()
  if (!ok) {
    console.warn(
      '[duoling:userscript] 用户脚本功能不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，' +
        'Chrome <138 需开启全局「开发者模式」；Firefox 需授权 userScripts 权限',
    )
    setEngineAvailable(false)
    return
  }
  setEngineAvailable(true)
  // 先对账存续行（把指向已关标签页的行盖章结束），再重注册 —— 否则这一步注册的是过期集合
  await reconcileTabSessions()
  await registerAllEnabled()
}

// 非 HTML 入口的构建信息：由 wxt.config.ts 的 vite.define 在配置加载期（dev = server 启动 /
// build = 构建开始）替换成字面量。SW 启动日志据此自证「跑的是哪次构建」——HTML 页面的
// 时间戳每次刷新都会变，SW 的只在 dev 重启 / 重新构建时才变，两者语义见 wxt.config.ts 注释。
// 这里只做「非 undefined」的收窄（SW 侧该标识符必然存在），形状引自 @duoling/shared 的 app/build-info。
declare const __BUILD_INFO__: InjectedBuildInfo

// —— 工具栏角标：这个标签页在跑几个脚本 ——
//
// 数字 = `pageRunsByTab`（page-monitor 的运行登记表）里**该标签页**的运行集大小 —— 与浮层灵动岛、
// popup 的页面概览是**同一个数**（三处对不上就是在骗人）。归属天然按 tab：登记表本身就是按
// tab 建的。没有脚本在跑的标签页不亮，别的页面上的脚本也不在这儿报数。
//
// **为什么不是「会话在跑几个任务」**：那种数字只会是 0 / 1（一个标签页只归属一条会话，见
// conversation-tab-map）—— 既报不出量，说的也不是「这个页面此刻是什么样」。脚本数才是这个页面
// 自己的状态；会话那边的进度与结果由工作台「会话历史」与浮层负责。
//
// **只报数、不分类**：什么颜色代表什么状态是要用户记的额外约定，具体是哪些脚本去浮层灵动岛 /
// popup 看。悬停文案把同一件事说成一句话（`N 个脚本在运行`），与灵动岛同一句。
//
// **没有授权就没有数可报**：Chrome 的「允许运行用户脚本」开关关着时（Chrome <138 是全局开发者
// 模式、Firefox 是 userScripts 权限），`chrome.userScripts` 整个命名空间都不存在，任何脚本都注册
// 不进去 —— 此时全局亮一个感叹号，悬停写「用户脚本未授权，工作台「引导」有开启步骤」。
// 这条**刻意是全局的、不带 tabId**：它说的不是某一页的状态，而是「这个扩展现在用不了用户脚本」，
// 与具体标签页无关。它同样由 refreshBadge 算出来（可用性翻转驱动它重算），不另开写口。
//
// 数字由 refreshBadge **重算**而来，不是「收到 runstart 时顺手加一」：登记表是唯一的真相源，
// 重算才能保证角标与登记表不各说各话 —— 清空（换文档）、关标签页、重复广播各是一条路，逐条对齐
// 迟早漏一条。

/**
 * 角标数字：超过 9 显示 9+（角标最多 4 字符，两位数在工具栏尺寸下已经看不清）。
 * 一个页面上的脚本数没有上限（命中同一条 matches 的脚本可以有很多个），这条分支是真会走到的。
 */
function badgeCount(n: number): string {
  return n > 9 ? '9+' : String(n)
}

/**
 * 进行中的会话（chat:running 登记进来、chat:finished 撤下）。
 *
 * **刻意不落库**：它没有稳定落点 —— SW 被回收后内存里这份就没了，而库里若留着一条恒为
 * 「进行中」的记录，再不会有事件来收尾它，就成了假状态。故只活在内存，工作台问起时把当前
 * 快照给它（`sw:runningChats`）。
 *
 * **为什么要记而不是每次现算**：它还是「标签页被关 → 中止它的任务」那条路的判据
 * （见 abortConversationOfClosedTab）—— 不在跑就不必惊动 offscreen。
 */
const runningConversations = new Set<string>()

/**
 * 悬停文案。与浮层灵动岛**同一个句式**（`N 个脚本在运行`）—— 两处说的是同一个数，措辞也要一致，
 * 否则用户会以为它们各说各的。**只给主动悬停的人看**（不占角标、不需要用户记任何约定）。
 * 空串 = 恢复默认（扩展名）。
 */
function titleOf(scriptCount: number): string {
  return scriptCount > 0 ? `${scriptCount} 个脚本在运行` : ''
}

/** 运行数量角标的底色（与设置页「开发者」分区那张角标调试栏同值：预览与实设必须是同一个观感） */
const BADGE_BG_COUNT = '#1a73e8'

/**
 * 未授权角标（那枚感叹号）的底色。**留红**：红色是警告语义，与数量角标的蓝色分工 ——
 * 一眼就能分出「这里有事情要处理」和「这页在跑几个脚本」。
 */
const BADGE_BG_UNAUTH = '#d93025'

/**
 * 未授权时角标的文本：一个感叹号。**不写字** —— badge 的可用宽度就几个像素，汉字再少也得缩到
 * 看不清（试过三字，观感不如单字符）；而单字符里它字号最大、最醒目，说「这里有事要处理」也够直白。
 * 具体是什么事由悬停文案说（`UNAUTHORIZED_TITLE`）。
 */
const BADGE_UNAUTH = '!'

/** 未授权的悬停文案：指路即可，不复述开启步骤（分步说明在工作台「引导」标签页） */
const UNAUTHORIZED_TITLE = '用户脚本未授权，工作台「引导」有开启步骤'

/**
 * 用户脚本引擎此刻能不能注册脚本（= `getUserScriptsStatus().available` 的本地快照）：角标感叹号的判据。
 *
 * 初值取**同步**的存在性检查 —— 开关关着时该命名空间整个不存在，所以冷启动那一刻它已经准了，
 * 不会「先亮一下感叹号、探明了再灭掉」。权威值随后由 initUserScripts 的一次实探、以及
 * availability-watch 的翻转事件定下来：命名空间在但 getScripts 抛错这类情形只有实探能抓到。
 */
let engineAvailable = typeof chrome.userScripts !== 'undefined'

/** 更新引擎可用性并按需重算角标。值没变就不动 —— 可用性监视每秒都可能调进来 */
function setEngineAvailable(available: boolean): void {
  if (engineAvailable === available) return
  engineAvailable = available
  refreshBadge()
}

/** 上一轮设过角标 / 文案的标签页：这一轮不再相关时按差集收干净（留着的数字就是假状态） */
const touchedTabs = new Set<number>()

/** 清掉某个标签页的专属角标与悬停文案（没设过时是 no-op） */
function clearTabBadge(tabId: number): void {
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {})
  chrome.action.setTitle({ tabId, title: '' }).catch(() => {})
}

/**
 * 清掉全局兜底值与所有标签页的专属值。
 *
 * 全局那份必须一起清：`setBadgeText({ tabId })` 只对**设过专属值**的标签页生效，没设过的会回落到
 * 全局值 —— 留着一个总数在那里，等于每个新标签页都自动带上了别人的数字。
 */
async function clearAllBadges(): Promise<void> {
  chrome.action.setBadgeText({ text: '' }).catch(() => {})
  chrome.action.setTitle({ title: '' }).catch(() => {})
  const tabs = await chrome.tabs.query({}).catch(() => [])
  for (const tab of tabs) if (tab.id != null) clearTabBadge(tab.id)
  touchedTabs.clear()
}

/**
 * 按此刻**引擎可用性与登记表的真实情况**重算角标与悬停文案 —— **唯一**的角标写入口（数字与感叹号
 * 都走这里，谁都不许另开一处 setBadgeText）。
 *
 * 引擎不可用 → 全局一个感叹号，见上方「没有授权就没有数可报」；可用 → 数字 = 该页运行集大小
 * （与灵动岛 / popup 的页面脚本区同源）。没有脚本在跑的页不亮，并且要把**上一轮设过、这一轮不再
 * 相关**的页收干净（见末尾的差集），否则那个数字会一直挂在那里 —— 页面早已换过文档，角标还说着
 * 旧话。同理，恢复可用时要把全局那个感叹号收掉：没设过专属值的标签页会回落到全局值。
 *
 * 为什么是「重算」而不是「在 noteRunStart 里加一」：登记表是唯一真相源，而它的变化有好几条路
 * （注入登记 / 换文档清零 / 关标签页清除 / 同 uuid 重复广播覆盖），逐条对齐迟早漏一条；整体重算
 * 的逻辑只有一个地方要维护，也天然容得下「一轮里表被改了两次」。可用性翻转也接在这条重算上，
 * 而不是在翻转回调里直接改角标。
 */
function refreshBadge(): void {
  // 引擎不可用：压根没有「哪个页面在跑几个脚本」这回事。先把 per-tab 那批收干净 —— 引擎是在
  // 脚本运行途中被撤权的（用户改了开关），登记表里可能还留着旧账。
  if (!engineAvailable) {
    for (const tabId of touchedTabs) clearTabBadge(tabId)
    touchedTabs.clear()
    chrome.action.setTitle({ title: UNAUTHORIZED_TITLE }).catch(() => {})
    chrome.action.setBadgeBackgroundColor({ color: BADGE_BG_UNAUTH }).catch(() => {})
    chrome.action.setBadgeText({ text: BADGE_UNAUTH }).catch(() => {})
    return
  }

  /** 这一轮该亮 / 该有文案的标签页 → 脚本数 */
  const countsByTab = new Map<number, number>()
  for (const [tabId, runs] of pageRunsByTab) if (runs.size > 0) countsByTab.set(tabId, runs.size)

  for (const [tabId, count] of countsByTab) {
    chrome.action.setTitle({ tabId, title: titleOf(count) }).catch(() => {})
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_BG_COUNT }).catch(() => {})
    chrome.action.setBadgeText({ tabId, text: badgeCount(count) }).catch(() => {})
  }

  for (const tabId of touchedTabs) if (!countsByTab.has(tabId)) clearTabBadge(tabId)
  touchedTabs.clear()
  for (const tabId of countsByTab.keys()) touchedTabs.add(tabId)

  // 收掉未授权那枚全局感叹号（每轮都写：与上面 per-tab 的做法一致，重算不做变化检测）
  chrome.action.setTitle({ title: '' }).catch(() => {})
  chrome.action.setBadgeText({ text: '' }).catch(() => {})
}

/**
 * 标签页被关掉时的收尾：**中止它那条会话正在跑的任务**。
 *
 * 为什么必须中止：会话按标签页归属，标签页没了就没人会去看结果、也没处按停止；而任务跑在
 * offscreen、与页面无关（这是刻意的，见 chat-host），不显式喊停它就会一路跑完、静默消耗 token。
 * 用户侧还有第二个停止入口（工作台「会话历史」的生成中标记），但那要他主动去翻。
 *
 * 读归属必须在解绑之前 —— 解绑完就不知道这个标签页归哪条会话了。
 */
async function abortConversationOfClosedTab(tabId: number): Promise<void> {
  const conversationId = await getConversationIdForTab(tabId).catch(() => null)
  await unbindTab(tabId).catch(() => {})
  if (!conversationId) return
  if (!runningConversations.has(conversationId)) return // 没在跑就不必惊动 offscreen
  // 命令面归 offscreen（chat: 前缀）：由 SW 发出去，offscreen 收到后中止任务。
  // 送不到就没法中止（offscreen 同时不可用），登记留着也不误导谁 —— 它下次收尾时照样会被撤下。
  try {
    await ipcRequest<void>({ kind: 'chat:abort', conversationId })
  } catch {
    // 忽略：这里没有可做的补救
  }
}

/**
 * 标签页被关掉时的记录收尾：盖上关闭时刻（`noteTabClosed`，没登记过的页不补行），
 * 随后重算录制件注册。
 *
 * 顺序不能反：注册判据读的就是这一行（未结束 + recording），先算注册会读到还没盖章的旧状态 ——
 * 关掉的若是最后一页在录的，注册集合就该清空，否则录制件会一直全匹配挂在所有站点上。
 * 已录的采样**一条不动** —— 用户还要在「活动历史」里看、让 AI 读。
 *
 * 与 abortConversationOfClosedTab 同一个理由必须挂在常驻的 SW 上：面板没开的时候标签页照样会被关。
 */
async function settleRecordingOfClosedTab(tabId: number): Promise<void> {
  await noteTabClosed(tabId)
  await refreshTabRecorder().catch(() => {})
}

/**
 * SW 启动对账：把「还开着、但标签页已经不在」的存续行盖章结束。
 *
 * 为什么需要：标签页可能趁 SW 睡着时被关掉，`tabs.onRemoved` 的收尾要等 SW 下次醒来才补上；
 * 若它再没醒（用户就此收工），库里就留着一行 `recording: true` 且未结束 —— 而录制件的注册
 * 判据正是「有没有这样的行」，于是它会一直全匹配地挂在每个站点上，明明没人在录。
 *
 * 在 registerAllEnabled 之前调用：让它按对账后的行重新算注册集合。
 */
async function reconcileTabSessions(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({})
    const alive = new Set(tabs.map((t) => t.id).filter((id): id is number => id != null))
    await reconcileDeadTabSessions(alive)
  } catch {
    // 对账失败不阻断启动：脏一行不影响其余链路
  }
}

/**
 * chat:running 观察（offscreen 推送，chat: 前缀按约定不进命令路由，这里只旁听）：任务开始。
 * **不碰角标** —— 角标只报脚本运行数，会话与它无关。
 */
function handleChatRunningPush(conversationId: string): void {
  runningConversations.add(conversationId)
}

/** chat:finished 观察：任务收尾（正常 / 异常同处理）：从进行中撤下，无其它副作用 */
function handleChatFinishedPush(conversationId: string): void {
  runningConversations.delete(conversationId)
}

// —— 对话界面监控 + 任务状态的事件挂载 ——
// ⚠️ 全部 addListener 必须留在 defineBackground 回调内（与既有监听器同惯例）：
// 本文件会被协议一致性测试 import（取 SW_KIND_PREFIXES），模块顶层挂监听会在
// Node/fakeBrowser 下炸（runtime.onConnect 未实现）——之前踩过。
function mountProposal2Listeners(): void {
  // SW 冷启动（浏览器启动 / 扩展重载）：登记表是内存表，此刻必然为空，而 per-tab 的角标与悬停文案
  // 由浏览器保留着 —— 留着一批「哪个标签页该亮」已无从对证的专属值，只会把假状态显示给用户。
  // 一律先清干净（全局兜底值也要清，否则没设过专属值的标签页会回落到它），再按空表重算一遍
  // —— 这轮重算不是 no-op：引擎不可用时那枚全局感叹号正是由它设上的（全局值刚被上面清掉），该显示
  // 什么一律由同一个出口决定，冷启动这条路上也不例外。
  // 之后浏览器启动会重载页面、runstart 自己回来；扩展重载后的既有页面要等下一次导航。
  // 至于「SW 空闲被回收」这条不必担心：它由 offscreen 心跳保活（@duoling/offscreen-document
  // 的 keepalive，见 page-monitor 头注释）。
  void clearAllBadges()
    .then(() => refreshBadge())
    .catch(() => {})

  // 角标的重算时机：登记表一变就重算（注入登记 / 换文档清零 / 关标签页清除）。
  // 角标不做持久化，也不自己维护计数 —— 数字永远是登记表现算出来的。
  onPageRunsChanged(() => refreshBadge())

  /**
   * 给某标签页此刻跑着的运行盖上结束戳（导航替换 / 标签页关闭）。
   * 必须在 resetPageRuns / forgetPageTab **之前**调用 —— 那两步一执行，登记表里就查不到 runId 了。
   * 落盘失败静默：这是观察数据，不该反过来影响标签页的正常收尾。
   */
  function endRunsOfTab(tabId: number, reason: RunEndReason): void {
    const runs = [...(pageRunsByTab.get(tabId)?.values() ?? [])]
    if (!runs.length) return
    void markRunEnd(
      runs.map((r) => r.runId),
      reason,
    ).catch(() => {})
  }

  // 对话界面监控：新文档导航开始 = 旧文档销毁，该 tab 的运行集清零。
  // 刻意用 status=loading（文档替换的准确时点），SPA 软导航只改 url、不换文档，不清。
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      endRunsOfTab(tabId, 'navigated')
      resetPageRuns(tabId)
      // 存续轴：文档重开了，记一条「刷新」—— 但若这其实是一次导航（url 回调还没到），
      // 由 tab-sessions 拿此刻的真实地址比出来、改记「地址变更」。地址只有 SW 现取得到。
      void chrome.tabs
        .get(tabId)
        .then((t) => t.url)
        .catch(() => undefined)
        .then((url) => noteTabReloaded(tabId, url))
        .catch(() => {})
    }
    // 存续轴：地址变了就记一条「地址变更」，并顺手刷新「这个标签页最近去哪了」。
    // 这条不能并进上面的分支：SPA 软导航只带 url、不带 status，并进去就被漏掉了。
    // 空值 = 拿不到地址（chrome:// 等无 host 权限的页），不写。
    if (typeof changeInfo.url === 'string') {
      void noteTabUrlChanged(tabId, changeInfo.url).catch(() => {})
    }
  })

  // 标签页存续的维护：给 tabId 一个稳定替身（见表头注释与 tab-sessions）。
  // **不监听 onCreated**：建行只发生在「用户给这一页打开活动记录」那一刻（见 tabActivityEnable），
  // 否则每开一页都留一行，绝大多数与脚本毫无关系。这里与上面一样，只维护已存在的行。
  chrome.tabs.onRemoved.addListener((tabId) => {
    endRunsOfTab(tabId, 'closed')
    forgetPageTab(tabId)
    // 归属收尾：按映射找到那条会话并**中止它的任务**，再解绑。
    // 面板没开的时候标签页照样会被关，只有常驻的 SW 不漏，所以这一步必须在这里做
    // （漏了它会留在 offscreen 里跑完 —— 没人看结果、也没处按停止，纯粹烧 token）。
    void abortConversationOfClosedTab(tabId)
    // 记录收尾：盖上关闭时刻（没登记过的页不补行）并按新状态重算录制件注册。
    // 录制按标签页划分，页面没了就不该再有「这一页在录」；漏了会让录制件一直全匹配挂着。
    void settleRecordingOfClosedTab(tabId).catch(() => {})
  })

  // 页面脚本监控端口（另一条连接 'duoling:panel'：上行快照请求 + 推送寻址）
  initPageMonitorPorts()
}

// —— 浮层的右键菜单入口 ——
//
// 对话框的入口全在页面之外：工具栏 popup 里的「对话浮层」按钮，以及这个右键菜单。菜单这条由
// 浏览器渲染，页面里的东西遮不住它，也不依赖浮层宿主件已经挂上 UI。
//
// id 带 `duoling:` 前缀：与用户脚本的 GM_registerMenuCommand 共用 contextMenus 命名空间，
// 脚本侧是 `us:<uuid>:<menuId>`（见 dl-port.ts 的 parseMenuitemId —— 它只认那个前缀，本条会被放行）。
const FLOAT_MENU_ID = 'duoling:open-float'

/** 通知图标（复用 auto-icons 构建生成的 icons/128.png，与工具栏图标同源；与用户脚本通知的兜底图标同一个文件） */
const NOTIFY_ICON = 'icons/128.png'

/**
 * 注册本扩展自己的菜单项（幂等）。
 *
 * 先摘再建，而不是 create 撞上 duplicate id 就吞掉：那样虽不影响既有项，但菜单文案 / 作用域
 * 改过之后旧项会一直留着 —— 卸载重建才能让改动生效，而本函数在每次 SW 冷启动时都会跑一遍。
 * 首次安装时该 id 不存在，remove 报的 lastError 属正常路径，读一下就消掉。
 */
function ensureFloatMenuItem(): void {
  chrome.contextMenus.remove(FLOAT_MENU_ID, () => {
    void chrome.runtime.lastError
    chrome.contextMenus.create({
      id: FLOAT_MENU_ID,
      title: `打开${EXTENSION_NAME}对话`,
      contexts: ['page'],
      // 与 popup 的判据一致：只对普通网页出现（内部页 / 扩展页 / file:// 上浮层挂不了）
      documentUrlPatterns: ['*://*/*'],
    })
  })
}

/**
 * 在当前标签页把对话浮层调出来（右键菜单用；动作与 popup 那颗按钮同一套）。
 *
 * 与 popup 的差别只有失败反馈的渠道：那里能留在面板里写字，这里没有面板，只能弹一条系统通知
 * —— 菜单点了毫无动静是最糟的结果，用户会以为功能坏了。
 */
async function openFloatPanelInTab(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id
  if (tabId == null) return
  if (openFloatPanel(tabId)) return
  await chrome.notifications.create('duoling:float-open-failed', {
    type: 'basic',
    iconUrl: NOTIFY_ICON,
    title: EXTENSION_NAME,
    message: `这个页面还没接上${EXTENSION_NAME}，刷新页面后再试。`,
  })
}

function mountFloatMenu(): void {
  ensureFloatMenuItem()
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== FLOAT_MENU_ID || !tab) return
    void openFloatPanelInTab(tab)
  })
}

export default defineBackground(() => {
  // 启动自证：console 第一条就是构建信息，「SW 是不是新包」不用再靠猜
  console.log(`[duoling:sw] SW 启动 · 构建 ${__BUILD_INFO__.time} · 分支 ${__BUILD_INFO__.branch}`)

  // 点击工具栏图标打开 popup（action.default_popup 由 popup.html 入口自动写入 manifest）——
  // 这是 action 的唯一用途；对话入口是网页浮层（由浮层宿主件挂出），不占 action。

  // 用户脚本管理器：启动配置世界并恢复已启用脚本
  void initUserScripts().catch((e) => console.error('[duoling:userscript] init failed', e))

  // 引擎可用性监视（检测层）：SW 被保活的前提下自行轮询「运行用户脚本」开关（Chrome 对
  // 开关变化无事件），状态变化时经订阅回调通知。这里挂三个消费方（事件消费层）：
  //   ① 角标：翻转时重算（不可用 → 全局感叹号，可用 → 收回感叹号并正常报数）。放在最前，让角标
  //      先跟上，后面那步补注册跑多久都不影响它；
  //   ② 进程内自愈：不可用 → 可用（用户在扩展管理页开完开关）时补注册全部启用脚本——
  //      开关关闭期间启用的脚本只落库未注册，无人补注册就永远不生效；
  //   ③ 广播给扩展页：横幅 / 引导页订阅 availabilityChanged 更新显示（不再各自打补丁）。
  startAvailabilityWatch()
  onAvailabilityChange(({ previous, current }) => {
    setEngineAvailable(current.available)
    if (!previous && current.available) {
      void ensureWorldsConfigured()
        .then(() => registerAllEnabled())
        .catch((e) => console.error('[duoling:userscript] 可用性翻转补注册失败', e))
    }
    // SW 收不到自己发的消息，广播只到扩展页；无接收方（没开任何页面）属常态，静默
    const push = { kind: 'userscript:availabilityChanged' as const, availability: current, changedAt: Date.now() }
    ipcNotify(push)
  })

  // 对话界面监控 / 面板端口 / 任务状态 / 深链跳转的监听器
  mountProposal2Listeners()

  // 浮层的右键菜单入口（与 popup 的按钮同一条路：对话框平时不在页面里）
  mountFloatMenu()

  // offscreen 需「随时可用」：安装 / 更新 / 浏览器启动都立即确保容器在场。
  // Chrome 不会自动启动 offscreen，且 idle 自关未实现，故改为常驻策略（退出条件见 offscreen.ts）。
  chrome.runtime.onInstalled.addListener((details) => {
    void ensureOffscreen().catch((e) => console.error('[duoling:offscreen] ensure failed', e))
    if (details.reason === 'update') {
      void recoverOnUpdate().catch((e) => console.error('[duoling:userscript] recover failed', e))
    }
    // 装完 / 更新完顺带查一次新版本
    void runUpdateCheck().catch((e) => console.warn('[duoling:update] 检查失败', e))
  })

  chrome.runtime.onStartup.addListener(() => {
    void ensureOffscreen().catch((e) => console.error('[duoling:offscreen] ensure failed', e))
    // 每次开浏览器查一次。注意 onStartup **只在浏览器启动时**触发，SW 被挂起后唤醒不触发它
    // —— 本次启动若正好离线就会错过一轮，靠设置页「关于」里的手动检查补。
    void runUpdateCheck().catch((e) => console.warn('[duoling:update] 检查失败', e))
    // 划断标签页存续：tabId 是本次浏览器运行内的流水号，重启后重排、会被复用 ——
    // 上个会话残留的未结束行必须在此收口，否则新会话同号的标签页会被挂到旧行上。
    // 只在这里做（浏览器启动），不能在 SW 冷启动做：那时「未结束」的行正是本会话还开着的标签页。
    void splitTabSessionsAtBrowserStart().catch(() => {})
  })

  // SW 冷启动即确保 offscreen 在场（与上面监听器互补：SW 被终止后重启时，首条事件会触发本回调）
  void ensureOffscreen().catch((e) => console.error('[duoling:offscreen] ensure failed', e))

  // 模型配置变更通知已随存储迁移（chrome.storage → duoling-app 库）挪到 model-store 写出口：
  // 它落盘成功后自己广播 `model` 域（扩展页回拉）并推送 offscreen:configChanged（offscreen
  // 的 profile-cache 回拉）。SW 这里不再需要 storage.onChanged 兜底。

  // SWService 注册：库自带 listener，首次注册即同步挂上，认的是无 kind 报文，
  // 总线对其静默让路；offscreen 保活轮询就靠这条调用到达 SW。
  registerSWService(new SWService())

  // 本语境命令面唯一的 onMessage 监听器（标准化信道）：问询顺序 =
  //   ① 运行时包命令面（swIpcHandlers：管理面只读四条）—— 包自管 kind 归包，
  //      宿主前缀路由不得抢答（sendResponse 一条消息只有一次机会）；
  //   ② 宿主前缀表（SW_KIND_PREFIXES + handlers）—— 其余归 SW 的 kind。
  // 旁听 offscreen 推送（chat:running / chat:finished：任务起止）：chat: 前缀对命令面是
  // offscreen 保留前缀，SW 静默让路，这里只观察不响应（推送方对响应本就尽力而为）。
  serveIpc({
    matchers: [packMatcher(swIpcHandlers()), prefixMatcher(SW_KIND_PREFIXES, handlers)],
    observe: (msg) => {
      const push = msg as { kind: string; conversationId?: string }
      if (push.kind === 'chat:running' && push.conversationId) handleChatRunningPush(push.conversationId)
      if (push.kind === 'chat:finished' && push.conversationId) handleChatFinishedPush(push.conversationId)
    },
  })
})
