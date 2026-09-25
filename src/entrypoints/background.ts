// background = 桌面版 main 进程的能力运行时。
// 职责：用户脚本的**注册与运行时**（chrome.userScripts）+ 项目状态库写命令的转发方
// + offscreen 容器管理 + 模型配置中转。
// 对话、模型配置不走这里（各自直连 IndexedDB：duoling-chat / duoling-app）。
//
// 存储分工：
//   · 注册态（bundle + 元数据 + enabled）—— 权威在独立 IndexedDB 库 duoling-state，
//     **写只归 offscreen**（单写方）：读 —— 本文件直连 project-store，**不经容器**，
//     注册链路不能押在 offscreen 存活上，否则容器一挂所有脚本都不生效；
//     写 —— 经 writeViaOffscreen 转 offscreen，写完从状态库读回再注册。
//   · 源码 —— 唯一来源在 duoling-fs（offscreen 独占的 lightning-fs 库 + git 版本化），
//     SW 读不到 lfs，源码读写一律走 fs:* 命令向 offscreen 取（见 offscreen-fs-commands.ts）。
// GM 值存储 / GM tab 值在 IndexedDB 库 duoling-usdata；错误日志 / 运行统计 / 运行日志
// （观测数据）在 IndexedDB 库 duoling-runtime——两者都 SW 直写、写侧收敛在 store.ts。

import '@/polyfills' // 必须在最前：补全 SW 的 global/Buffer/process 全局，早于 isomorphic-git 引用
import { defineBackground } from '#imports'
import { FLOAT_OPEN_REQUEST, FLOAT_PANEL_OPEN_PORT } from '@/shared/extension-ipc'
import type {
  ModelProfileState,
  NotificationSnapshot,
  RunningNotice,
  RuntimeRequest,
  RuntimeResponse,
} from '@/shared/extension-ipc'
// 注入物的形状取自同一处，本文件不再各写一份（加字段时只改一处才不会漏）
import type { InjectedBuildInfo } from '@/lib/build-info'

// 用户脚本管理器：可用性检测 + 引擎类型（仅保留与 VM 无关的可用性查询；安装/卸载/对账见下方 vm-script-manager）
import {
  vmReady,
  addRuntimeMessageListener,
  sendRuntimeMessage,
} from '@/lib/userscripts/vm-runtime-host'
// 可用性检测（与注入引擎无关，VM / 自研引擎共用 chrome.userScripts API）
import {
  isUserScriptsAvailable,
  getUserScriptsStatus,
} from '@/lib/userscripts/availability'
// 网络录制件同步（dl-recorder：MAIN 捕获 + USER_SCRIPT 转发，独立于脚本引擎）
import { refreshNetRecorder } from '@/lib/userscripts/net-recorder-sync'
// P4：脚本安装 / 卸载 / 对账改走 VM 运行时
import {
  vmInstallScript,
  vmUninstallScript,
  vmSetEnabled,
  vmReconcile,
} from '@/lib/userscripts/vm-script-manager'
import { collectCspWarnings } from '@/lib/userscripts/csp-check'
// metadata 解析（纯函数）：仅用于把「源码声明与界面配置的差异」当提示回给编辑器；
// 真正的归一化在写入口一处（project-write.saveSource），此处不写回任何东西
import { resolveConfigFromSource } from '@/lib/userscripts/metadata'
// 网络录制（dl-recorder）：per-host 门禁 + 录到的记录 + 语料压缩。
// 三者都归 SW：门禁在 duoling-app、记录在 duoling-netlog，offscreen 与扩展页都不直连。
import {
  disableNetCapture,
  enableNetCapture,
  getNetCaptureHosts,
} from '@/lib/userscripts/net-capture-gate'
import { normalizeHost } from '@/lib/userscripts/net-record-protocol'
import { listCapturesByHost } from '@/lib/userscripts/netlog-db'
import { describeCaptureDigest, describeCaptureRecords } from '@/lib/userscripts/net-record-digest'
// 引擎可用性监视（检测层）：SW 保活后自行轮询，变化时经 onAvailabilityChange 通知消费层
import { onAvailabilityChange, startAvailabilityWatch } from '@/lib/userscripts/availability-watch'
// 新版本检查：SW 在浏览器启动 / 安装更新时各查一次，结果落 duoling-app 库供 popup 与设置页读
import { runUpdateCheck } from '@/lib/update-check'
// 网页浮层开关的补齐动作已随站点开关一并移除：右键菜单只负责发「调出浮层」请求
import { initNetCaptureReceiver } from '@/lib/userscripts/net-capture-receiver'
// DL Port 事件底座：脚本世界 ↔ SW 长连接下行通道 + 三事件源接入
import { initDlPort } from '@/lib/userscripts/dl-port'
// 项目数据：读侧（直连 IndexedDB，SW 与扩展页共用）+ 写命令面（转发 offscreen）
import { getProject, listGroups, listProjects } from '@/lib/userscripts/project-store'
// chrome.storage 侧：GM 值、错误日志、运行统计
import {
  listSummaries,
  withRunStats,
  clearGMValues,
  clearRunStats,
  clearUserScriptErrors,
  appendUserScriptError,
  findUserScriptError,
  listRunTimeline,
  clearRunLog,
} from '@/lib/userscripts/store'
// 对话界面页面脚本监控（运行时口径）：按 tab 的运行登记 + 面板端口
import {
  forgetPageTab,
  initPageMonitorPorts,
  resetPageRuns,
} from '@/lib/userscripts/page-monitor'
// 会话的标签页归属映射（duoling-app 库）：标签页关闭时在这里清（见 tabs.onRemoved 处说明）；
// page:snapshot 也用它反查「这条会话在哪个标签页上」（会话按 tab 归属）
import {
  findTabsUsingConversation,
  getConversationIdForTab,
  unbindTab,
} from '@/lib/conversation-tab-map'
// 通知中心（duoling-app 库）：任务收尾记一条未读通知，角标按「进行中 + 未读」报数、popup 给明细
import {
  addChatDone,
  countUnread,
  listNotifications,
  markAllRead,
  markConversationRead,
  markRead,
  removeAll,
  removeByConversation,
} from '@/lib/notifications'
import type { ImportReport, ScriptProject, ScriptSummary, UserScriptsAvailability } from '@/lib/userscripts/types'

// offscreen document 容器（AI 生成链路的执行宿主）
import { ensureOffscreen, closeOffscreen, isOffscreenReady, ensureOffscreenReady } from '@/lib/offscreen'
// 模型配置：offscreen 既不直连存储、也不 import model-store（SW 专属模块），一律由
// SW 经命令中转；变更推送由 model-store 写出口直发（见 offscreen-main.ts）。
import { getActiveProfileState } from '@/lib/model-store'
// 数据变更广播：落盘后通知全部前端实例回拉（IDB 没有变更通知，这条线由它补上）
import { broadcastBuildPhase } from '@/lib/data-broadcast'
// AI 工具支路：page_snapshot 工具经 SW 调 userScripts.execute（offscreen 不可达该 API）
import { capturePageSnapshotFromTab, pageInjectionBlockReason } from '@/lib/element-picker-client'

/**
 * SW 管辖的 kind 前缀（路由白名单）。
 *
 * offscreen 与 SW 同时在监听 runtime 消息，而 sendResponse 对一条消息只有一次机会 ——
 * SW 只应响应这里登记的前缀，其余（如将来 offscreen 的 ai: / chat: 指令）必须让路，
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
  'tab:',
  'notify:',
] as const

/**
 * SW 管辖的请求（由上面的前缀推导，两者必须同源）。
 *
 * handlers 表只登记这些 kind：`ai:*`（git 历史）与 `state:*`（项目状态库写侧）都由 offscreen
 * 应答——它们不是 SW 的职责，不该为凑齐类型而塞进 handlers 表补死桩。
 */
type SwRequest = Extract<RuntimeRequest, { kind: `${(typeof SW_KIND_PREFIXES)[number]}${string}` }>

/**
 * SW → offscreen 的请求封装：转发 ai:*（git 历史）与 state:*（项目状态库写侧）命令面。统一信封解包。
 *
 * 必须用「改写前捕获」的原始 sendMessage（sendRuntimeMessage）—— VM 库（common/browser.js）
 * 在 importScripts 时重写 runtime.sendMessage：2 参回调形式被追加第三 cb 导致 Chrome 报
 * No matching signature；且会把 {ok,data} 信封当 VM 元组 [result,error] 只取 response[0]=true 破坏信封。
 * 原始版本恢复原生 promise 形态（见 vm-runtime-host.ts ①-0）。
 */
function sendToOffscreen<T>(request: RuntimeRequest): Promise<T> {
  return sendRuntimeMessage<RuntimeResponse<T> | undefined>(request).then((response) => {
    if (!response) {
      throw new Error('扩展服务未响应，请重试')
    }
    if (!response.ok) {
      throw new Error(response.error)
    }
    return response.data as T
  })
}

/**
 * 写路径：项目数据的写只归 offscreen（单写方），SW 一律转发。
 *
 * 先 `ensureOffscreenReady` 再发命令：容器刚被回收 / 扩展重载时会重建，
 * 就绪判据是「能应答 fs:ping」而不是「文档已存在」。
 *
 * 重试只对「容器没接上」类错误：业务异常（脚本不存在、文件树非法…）重试一次也是同样的错，
 * 只会让用户多等一轮。写命令都是读改写，重复执行一次不会产生第二份数据。
 */
async function writeViaOffscreen<T>(request: RuntimeRequest): Promise<T> {
  await ensureOffscreenReady()
  try {
    return await sendToOffscreen<T>(request)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/port closed|Receiving end does not exist|无响应/.test(msg)) throw e
    await ensureOffscreenReady()
    return await sendToOffscreen<T>(request)
  }
}

/**
 * 注册失败：记入错误日志面板，并返回错误文案给 UI 展示。
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
    // P4：VM 接管注入，不再需要自研「内置桩」注册（refreshBuiltinScripts）；直接安装脚本到 VM
    await vmInstallScript(project)
    return undefined
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
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
  // 唤醒容器并**等到它真的能应答**才返回——调用方（fsClient 等）据此省掉了原先
  // 「ensure 完 sleep 80ms 猜监听器注册好了没有」的兜底。
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
  // page_snapshot 工具（offscreen 经此命令请 SW 代办）：定位目标标签后执行拾取器快照模式。
  // chrome.userScripts 在 SW 可用（与注册链路同源，138+ 逐扩展开关门控），offscreen 不可达。
  // 快照 = AI 判断需要时才采集。
  //
  // **目标页 = 本会话所属的标签页**，不是「当前激活标签页」：会话按 tab 归属（一个 tab 一条
  // 会话），而快照是 AI 在生成中途决定采的，那时用户完全可能已经切到别的页 —— 查「激活」会把
  // 别人那一页的 DOM 喂给模型。反查走归属映射，自带存活校验（tab 已关的残留项会被判掉）。
  'page:snapshot': async (msg): Promise<Awaited<ReturnType<typeof capturePageSnapshotFromTab>>> => {
    if (!chrome.tabs?.query) throw new Error('无法定位目标标签页')
    const owned = msg.conversationId ? await findTabsUsingConversation(msg.conversationId) : []
    let tabId: number | undefined = owned[0]
    if (tabId == null) {
      // 兜底：会话没绑标签页（那条 tab 已关 / 映射缺项）→ 退回最后聚焦窗口的激活页，
      // 总比直接失败强；SW 无窗口上下文，lastFocusedWindow 语义 = 用户最后聚焦的窗口
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      tabId = tab?.id
    }
    if (tabId == null) throw new Error('未找到目标标签页')
    // 内置页 / 扩展页拦在注入前（判据与拾取器共用，见 pageInjectionBlockReason——扩展页连自己
    // 的也不行，<all_urls> 不覆盖 chrome-extension scheme）
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    const blocked = pageInjectionBlockReason(tab?.url)
    if (blocked) throw new Error(`${blocked}，无法采集页面快照`)
    return capturePageSnapshotFromTab(tabId)
  },

  // —— 内容脚本自证身份 ——
  // 回 sender 自己的 tab id：content script 拿不到 chrome.tabs，而网页浮层（扩展页 iframe）
  // 必须知道「自己属于哪个 tab」才能认定会话归属（每 tab 一条会话）。
  // 取不到时回 null（扩展页发的消息本就没有 tab），由调用方降级——浮层拿不到 tabId 的
  // 情况下会话归属退化为「不绑定」，而不是错绑到别的 tab。
  'tab:identify': async (_msg, sender): Promise<{ tabId: number | null }> => ({
    tabId: sender.tab?.id ?? null,
  }),

  // —— 用户脚本管理器（IPC 命令名沿用既有，载荷为项目形态）——
  // 列表视图：项目读自状态库（直连 IDB）；运行统计（runtime 库 stats store）同样 SW 直读，这里挂上
  'userscript:list': async (): Promise<ScriptSummary[]> =>
    withRunStats(await listSummaries(await listProjects())),

  // 读注册态记录（元数据 + 源码搬运副本；duoling-fs 里另有带 git 历史的权威源码，编辑器经 fs:read 取）
  'userscript:getProject': async (msg): Promise<ScriptProject | undefined> => getProject(msg.uuid),

  // 保存源码（唯一保存入口）：转 offscreen 统一保存（写 fs + git 提交 + 落库），
  // 落库后启用中则重注册。**保存恒成功、保存即注入**（无构建流程，注入代码 = 源码原文）。
  'userscript:save': async (
    msg,
  ): Promise<{ warnings?: string[]; registerError?: string }> => {
    // 转发前先广播「保存中」瞬态：列表行立即转圈（链路收尾的落库广播负责切终态
    // ——见 extension-ipc.ts DataChangedPush.phase 说明）
    broadcastBuildPhase('script', msg.uuid, 'saving')
    const outcome = await writeViaOffscreen<import('@/lib/userscripts/project-write').SaveOutcome>({
      kind: 'state:save',
      uuid: msg.uuid,
      code: msg.code,
      name: msg.name,
      config: msg.config,
      note: msg.note,
      actor: msg.actor,
    })
    const next = outcome.project
    // P4：VM 接管注入。保存即重新安装到 VM（parseScript 按 uri upsert，enabled 跟随 project.enabled）；
    // 关停态（enabled=false）装进去也是 enabled=0，getScriptsByURL 不会注入——无需先 uninstall。
    const registerError = await registerOrLog(next)
    return {
      // metadata 解析提示（@include 放宽 / 正则被丢弃 / @match 不合法…）与 CSP 警告同一通道到编辑器，
      // 提示由写侧一处产出（SaveOutcome.notes）——避免 SW 再解析一遍、拿不到当时那个 fallback 而误报
      warnings: [...collectCspWarnings(next.source.code), ...outcome.notes],
      registerError,
    }
  },

  // 新建脚本（零输入）：命名 / 初始模板 / 首次快照全在 offscreen 侧完成，SW 只负责注册。
  'userscript:create': async (): Promise<{ uuid: string; name: string; warnings?: string[]; registerError?: string }> => {
    const project = await writeViaOffscreen<ScriptProject>({ kind: 'state:create' })
    const registerError = await registerOrLog(project)
    return {
      uuid: project.uuid,
      name: project.name,
      warnings: collectCspWarnings(project.source.code),
      registerError,
    }
  },

  // AI 生成脚本落盘：转发 offscreen 单写方
  // （写状态库 + git 快照，note = AI summary），enabled 为真才注册——生成与生效解耦，
  // AI 产物默认零影响；启用走现成的 userscript:toggle。
  'userscript:createProject': async (msg): Promise<{ uuid: string; name: string; warnings?: string[]; registerError?: string }> => {
    const project = await writeViaOffscreen<ScriptProject>({
      kind: 'state:createProject',
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
        ...collectCspWarnings(project.source.code),
        // AI 产物可能自带 metadata 块：SW 手上有当时的 fallback（msg.config），可精确算出提示
        ...resolveConfigFromSource(project.source.code, msg.config).notes,
      ],
      registerError,
    }
  },

  // 删除：注销 → offscreen 清状态库记录 + git 仓 → 清该脚本的 GM 值 + 报错记录。
  // 仓的删除原先只能靠 offscreen 启动对账兜（删完会滞留一阵），现在写侧同在 offscreen，一步清干净。
  'userscript:remove': async (msg): Promise<void> => {
    // P4：VM 接管注入，删除 = 标记 removed 让 VM 停止注入（storage 惰性残留无害，无需自研注销）
    await vmUninstallScript(msg.uuid).catch((e) =>
      console.warn('[duoling:sw] 删除前 VM 卸载失败（下次启动对账会清，但期间页面刷新仍会注入）：', msg.uuid, e),
    )
    await writeViaOffscreen<void>({ kind: 'state:remove', uuid: msg.uuid })
    // VM 按 uuid 对账：状态库删除后该 uuid 不再出现在清单内，下次启动 vmReconcile 会标记其 removed
    await clearGMValues(msg.uuid)
    // 报错记录同属该脚本的残留：不清就会在错误日志里留下一个已删脚本的孤儿分组
    // （按 uuid 清，不碰「未归属」那种本就没有脚本上下文的记录）
    await clearUserScriptErrors(msg.uuid)
    // 运行统计同理：不清就会在重建同名脚本时继承旧计数
    await clearRunStats(msg.uuid)
  },

  // 删除全部用户脚本（「全部删除」按钮）：注销全部 → offscreen 清状态库 + 各仓 → 清各脚本
  // 的 GM 值与报错记录。范围 = 新形态用户脚本；内置件随扩展包分发、不在状态库。
  // uuid 由 SW 直读状态库（不经容器，与 userscript:list 同源），用于注销与清残留。
  'userscript:removeAll': async (): Promise<{ removed: number }> => {
    const uuids = (await listProjects()).map((p) => p.uuid)
    // P4：VM 接管注入，全部删除 = 先把 VM 库全部标记 removed（对账到空清单），避免删除期间页面仍注入
    await vmReconcile([]).catch((e) =>
      console.warn('[duoling:sw] 全部删除前 VM 对账失败（下次启动对账会清，但期间页面刷新仍会注入）：', uuids, e),
    )
    try {
      const removed = await writeViaOffscreen<number>({ kind: 'state:removeAll' })
      // VM 已按空清单标记全部 removed，无需自研「内置并集」刷新（relay/录制桩随 VM 接管而废）
      for (const uuid of uuids) await clearGMValues(uuid)
      // 报错记录逐 uuid 清（与单删同一条语义：删脚本 = 清该脚本名下的一切）
      for (const uuid of uuids) await clearUserScriptErrors(uuid)
      for (const uuid of uuids) await clearRunStats(uuid)
      return { removed }
    } catch (e) {
      // 落盘失败会留下「记录还在、VM 已标记 removed」的偏差——重新按空清单对齐，再抛出真实错误
      await vmReconcile([]).catch(() => {})
      throw e
    }
  },

  // 返回 registerError：enabled 已落状态库（数据写先于注册完成），注册失败只降级为警告，
  // 不把启停整体判失败（否则 UI 不更新开关，与实际已生效的 enabled 状态背离）。
  'userscript:toggle': async (msg): Promise<{ registerError?: string }> => {
    // 先读一次确认存在（状态库直读，不经容器），否则转发后才知道不存在、白搭一趟
    if (!(await getProject(msg.uuid))) throw new Error('脚本不存在')
    // enabled 不进 git 仓（buildContents 刻意排除），故只改状态库、不产生提交
    const next = await writeViaOffscreen<ScriptProject>({
      kind: 'state:toggle',
      uuid: msg.uuid,
      enabled: msg.enabled,
    })
    if (msg.enabled) return { registerError: await registerOrLog(next) }
    // P4：VM 接管注入。关停 = 改 VM 脚本的 enabled 标志（getScriptsByURL 以 !enabled 拦截注入），
    // 脚本留在库里、可随时再启；removed 是「删库」语义（见 userscript:remove），不能用于关停。
    await vmSetEnabled(msg.uuid, false).catch((e) =>
      console.warn('[duoling:sw] 关停 VM 脚本失败（下次启动对账会清，但期间页面刷新仍会注入）：', msg.uuid, e),
    )
    return {}
  },

  // 重命名脚本：只改状态库的 name（不入仓、不产生提交），落库后启用中则重注册——
  // 名字进 GM_info 与错误日志分组名，不重注册的话已注入的脚本仍顶旧名。
  // 同 toggle：注册失败只降级为警告，不把改名判失败（名字已落库）。
  'userscript:rename': async (msg): Promise<{ registerError?: string }> => {
    if (!(await getProject(msg.uuid))) throw new Error('脚本不存在')
    const next = await writeViaOffscreen<ScriptProject>({
      kind: 'state:rename',
      uuid: msg.uuid,
      name: msg.name,
    })
    return next.enabled ? { registerError: await registerOrLog(next) } : {}
  },

  // zip 导入：纯转发 offscreen 单写方（解码 + 落盘同处）。导入恒 enabled:false——「先审后启」
  // 是产品原则，落盘后由用户手动启用（userscript:toggle），故此处**无注册动作**（与 create / toggle 不同：不调 registerOrLog）。
  'userscript:import': async (msg): Promise<ImportReport> =>
    writeViaOffscreen<ImportReport>({ kind: 'state:import', zipBase64: msg.zipBase64 }),

  // 粘贴导入：一段脚本源码 → 一个脚本。解析与落盘都归 offscreen 单写方，SW 只转发；
  // 语义照抄 zip 导入——恒 enabled:false（先审后启），故此处同样**无注册动作**。
  'userscript:importText': async (msg): Promise<ImportReport> =>
    writeViaOffscreen<ImportReport>({ kind: 'state:import-text', code: msg.code }),

  // 脚本列表分组：读分组定义（直连 IDB，与 userscript:list 同源）
  'userscript:groups': async (): Promise<import('@/lib/userscripts/types').ScriptGroup[]> => listGroups(),

  // 把脚本归入某分组 / 退回未分组：转发 offscreen 单写方（group 不入 git 仓，不产生提交）
  'userscript:setGroup': async (msg): Promise<import('@/lib/userscripts/types').ScriptProject> =>
    writeViaOffscreen<import('@/lib/userscripts/types').ScriptProject>({
      kind: 'state:set-group',
      uuid: msg.uuid,
      group: msg.group,
    }),

  // 分组管理（新建 / 重命名 / 删除 / 重排）：纯转发 offscreen 单写方，SW 无副作用
  'userscript:group-create': async (msg): Promise<import('@/lib/userscripts/types').ScriptGroup> =>
    writeViaOffscreen<import('@/lib/userscripts/types').ScriptGroup>({ kind: 'state:group-create', name: msg.name }),
  'userscript:group-rename': async (msg): Promise<import('@/lib/userscripts/types').ScriptGroup> =>
    writeViaOffscreen<import('@/lib/userscripts/types').ScriptGroup>({ kind: 'state:group-rename', id: msg.id, name: msg.name }),
  'userscript:group-remove': async (msg): Promise<void> =>
    writeViaOffscreen<void>({ kind: 'state:group-remove', id: msg.id }),
  'userscript:group-reorder': async (msg): Promise<void> =>
    writeViaOffscreen<void>({ kind: 'state:group-reorder', orderedIds: msg.orderedIds }),

  'userscript:availability': async (): Promise<UserScriptsAvailability> => getUserScriptsStatus(),

  // 引擎保活应答（offscreen 心跳 5s 一次）：只证明「SW 活着」并重置空闲计时，
  // **不做任何检测**——检测在 SW 自身的轮询（startAvailabilityWatch），职责分离见 availability-watch.ts
  'userscript:healthCheck': async (): Promise<{ alive: true }> => ({ alive: true }),

  // 运行日志时间线：运行行 + 孤儿错误行混排（运行日志标签页）
  'userscript:runlog': async (): Promise<ReturnType<typeof listRunTimeline>> => listRunTimeline(),

  // 错误 ID 修复闭环：AI 的 error_read 工具经 offscreenBridge 到此代查。
  // 精确 id 或唯一 8 位前缀；多命中 / 不存在由信封里的 reason 区分（调用方给可读文案）
  'userscript:errorRead': async (msg): Promise<ReturnType<typeof findUserScriptError>> =>
    findUserScriptError(msg.id),

  // —— 网络录制（dl-recorder）——
  // 授权态（已同意录制的 host 集合）：UI 卡片的初始状态与 AI 工具判「是否已开」都读它
  'userscript:netCaptureState': async (): Promise<{ hosts: string[] }> => ({
    hosts: await getNetCaptureHosts(),
  }),

  // 开启录制：**唯一入口是用户点同意卡上的按钮**（AI 工具只负责出卡，不调这条）。
  // 门禁落盘后同步注册——注册影响的是**下次导航**，当前页面必须由用户刷新才挂得上钩子。
  'userscript:netCaptureEnable': async (msg): Promise<{ host: string; hosts: string[] }> => {
    const host = normalizeHost(msg.host)
    if (!host) throw new Error(`无效的站点：${msg.host}`)
    const hosts = await enableNetCapture(host)
    await refreshNetRecorder().catch(() => {})
    return { host, hosts }
  },

  // 关闭录制：撤门禁 + 注销两件。**已录记录保留**（用户可能还要让 AI 读），清理另走后续入口。
  'userscript:netCaptureDisable': async (msg): Promise<{ host: string; hosts: string[] }> => {
    const host = normalizeHost(msg.host)
    if (!host) throw new Error(`无效的站点：${msg.host}`)
    const hosts = await disableNetCapture(host)
    await refreshNetRecorder().catch(() => {})
    return { host, hosts }
  },

  // 读回录制语料：AI 的 net_capture_read 工具与常驻 prompt 摘要档共用同一条命令，
  // 只按 mode 换压缩档位。未授权时也返回（enabled:false）——调用方据此给准确提示，
  // 比抛错更好用（「没开录制」和「开了但没数据」要能分开说）。
  'userscript:netCaptureRead': async (
    msg,
  ): Promise<{ enabled: boolean; host: string; count: number; text: string }> => {
    const host = normalizeHost(msg.host)
    if (!host) throw new Error(`无效的站点：${msg.host}`)
    const enabled = (await getNetCaptureHosts()).includes(host)
    const records = enabled ? await listCapturesByHost(host) : []
    const text =
      msg.mode === 'digest'
        ? describeCaptureDigest(records).join('\n')
        : describeCaptureRecords(records)
    return { enabled, host, count: records.length, text }
  },

  // 清错误日志（runtime 库 errors store；「全部/该脚本」范围连带清运行日志 runlog store 的对应条目——
  // 时间线上「清空」应一条语义清两个存储，否则运行行清不掉）。三态必须靠「字段在不在」区分
  // （`!msg.uuid` 会把「未归属」误判成「全部」）：
  //   字段缺失 = 清全部；string = 只清该脚本；null = 只清「未归属」错误记录（run-log 无此形态，不动）
  'userscript:clearErrors': async (msg): Promise<void> => {
    const target = 'uuid' in msg ? (msg.uuid ?? null) : undefined
    await clearUserScriptErrors(target)
    await clearRunLog(target)
  },

  // —— 通知中心（popup 是唯一消费方）——
  // 进行中那份不落库（见 runningConversations），所以这里把内存快照与库里的列表合成一个答复。
  'notify:list': async (): Promise<NotificationSnapshot> => ({
    running: await runningNotices(),
    items: await listNotifications(),
  }),

  // 标已读后顺手重算角标：角标数字就是这个列表的未读数，两处必须一起变
  'notify:read': async (msg): Promise<{ unread: number }> => {
    await markRead(msg.id)
    await refreshBadge()
    return { unread: await countUnread() }
  },

  'notify:readAll': async (): Promise<{ unread: number }> => {
    await markAllRead()
    await refreshBadge()
    return { unread: 0 }
  },

  // 会话被删 → 它的通知一并清掉（留着只会指向一个不存在的对话）。
  // **这步必须走 SW**：角标数字归 SW 维护，清库这种事若由工作台直接做，它不知道、也没人喊它重算，
  // 角标会挂着一个已经不对的数字。
  'notify:drop': async (msg): Promise<{ unread: number }> => {
    if (msg.all) await removeAll()
    else if (msg.conversationId) await removeByConversation(msg.conversationId)
    await refreshBadge()
    return { unread: await countUnread() }
  },

  // SW 自证：把 define 注入的构建信息回给 UI（页面显示用，不依赖 SW DevTools 在场）。
  // 消息本身会唤醒休眠的 SW，唤醒后执行的这段代码持有的就是当前生效的 __BUILD_INFO__。
  'sw:buildInfo': async (): Promise<{ time: string; branch: string }> => __BUILD_INFO__,
}

/** 用户脚本管理器启动：挂载 GM 桥 + 配置 USER_SCRIPT 世界 + 恢复已启用项目 */
async function initUserScripts(): Promise<void> {
  initNetCaptureReceiver() // 网络录制接收（duo-ling 原生抓包，独立于 VM/GM 桥，只挂一次）
  initDlPort() // DL Port 事件底座（菜单点击 / 存储变更 / 通知点击的下行回推，同上只挂一次）
  // chrome.userScripts 仅在已开启「Allow User Scripts」（Chrome ≥138）或全局开发者模式
  // （Chrome <138）/ 已授权 userScripts 权限（Firefox）时存在；否则为 undefined，
  // 直接调用会令 SW 初始化崩溃。先判存在性，不可用则优雅跳过（UI 横幅会引导开启）。
  if (!chrome.userScripts) {
    console.warn(
      '[duoling:userscript] 用户脚本功能不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，' +
        'Chrome <138 需开启全局「开发者模式」；Firefox 需授权 userScripts 权限。用户脚本功能已禁用。',
    )
    return
  }
  // P4：VM 接管注入，默认 USER_SCRIPT 世界的 messaging 配置已废（VM 用独立 worldId:'vm'）；
  // 先等 VM 装配就绪，再对账脚本库
  await vmReady
  const ok = await isUserScriptsAvailable()
  if (!ok) {
    console.warn(
      '[duoling:userscript] 用户脚本功能不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，' +
        'Chrome <138 需开启全局「开发者模式」；Firefox 需授权 userScripts 权限',
    )
    return
  }
  // 启动对账：把 VM 脚本库对齐到当前项目清单（启用脚本经 VM 注入，禁用/删除标记 removed）
  await vmReconcile(await listProjects())
}

// 非 HTML 入口的构建信息：由 wxt.config.ts 的 vite.define 在配置加载期（dev = server 启动 /
// build = 构建开始）替换成字面量。SW 启动日志据此自证「跑的是哪次构建」——HTML 页面的
// 时间戳每次刷新都会变，SW 的只在 dev 重启 / 重新构建时才变，两者语义见 wxt.config.ts 注释。
// 这里只做「非 undefined」的收窄（SW 侧该标识符必然存在），形状引自 src/lib/build-info.ts。
declare const __BUILD_INFO__: InjectedBuildInfo

// —— 任务状态：通知中心（角标报数）+ popup 明细 ——
//
// 一份信号源 = offscreen 的 chat:running / chat:finished，两个出口各司其职：
//
//   · 工具栏角标 = **全局那一份**：红底白字，数字 = 「进行中 + 跑完没看」的条数。
//     它是唯一不受页面影响的提示位 —— 对话框收起后页面上没有任何状态位，只剩它。
//     **只报数、不分类**：什么颜色代表什么状态是额外的记忆负担，具体是什么事去 popup 看。
//   · popup = **明细**：几条在进行中、哪几条跑完没看，点条目跳过去并标已读。
//
// 「用户此刻在看对话界面吗」的判据 = **对话框展开 且 页面可见**：两条都成立时 content script 连上
// FLOAT_PANEL_OPEN_PORT，否则断开（页面卸载 / 导航则端口自然断）。**不能拿「面板文档存活」判**：
// 收起对话框只是 `display:none`，iframe 与面板文档都还在，端口永不断开 → 角标永不变
// （2026-09-21 无头实测：收起后推 chat:finished，角标纹丝不动；把 iframe 真摘掉才亮）。
// 「页面可见」那条同样不能省：对话框还开着、人却切去别的标签页，那时他什么都看不见，照旧要提示。
const openFloatPorts = new Set<chrome.runtime.Port>()
/** 展开态连接 → 所属标签页（判「**这个** tab 的对话框开着吗」，决定要不要记未读通知） */
const openFloatPortTab = new Map<chrome.runtime.Port, number>()

/** 该标签页的对话界面此刻是否展开（= 进度与结果都在用户眼前） */
function isFloatOpenIn(tabId: number): boolean {
  for (const tab of openFloatPortTab.values()) if (tab === tabId) return true
  return false
}

/** 角标数字：超过 9 显示 9+（角标最多 4 字符，两位数在工具栏尺寸下已经看不清） */
function badgeCount(n: number): string {
  return n > 9 ? '9+' : String(n)
}

/**
 * 进行中的对话（chat:running 进来、chat:finished 出去）：会话 id → 开始时间。
 *
 * **刻意不落库**：它没有稳定落点 —— SW 被回收后内存里这份就没了，而库里若留着一条恒为
 * 「进行中」的记录，再不会有事件来收尾它，就成了假状态。所以进行中只活在内存：角标数它一份，
 * popup 问起时把当前快照给它。
 *
 * **为什么要记而不是每次现算**：状态变化是事件驱动的，而「事件到达时用户在不在看」与之后可能
 * 不同 —— 任务开始时浮层还开着（当场判「不打扰」），用户随后收起就再没人喊一声，角标会一直不亮。
 * 收起那一刻得能按当前情况重算（见 refreshBadge）。
 */
const runningConversations = new Map<string, number>()

/** 标签页 → 站点名（通知里用它区分「是哪条对话」；取不到就空串） */
async function hostOfTab(tabId: number | null): Promise<string> {
  if (tabId == null || !chrome.tabs?.get) return ''
  try {
    const url = (await chrome.tabs.get(tabId)).url
    if (!url) return ''
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : ''
  } catch {
    return ''
  }
}

/** 进行中的快照（popup 的「进行中」那一组）：站点名与标签页现查，不缓一份会过期的 */
async function runningNotices(): Promise<RunningNotice[]> {
  return Promise.all(
    [...runningConversations].map(async ([conversationId, startedAt]) => {
      const tabId = (await findTabsUsingConversation(conversationId))[0] ?? null
      return { conversationId, startedAt, tabId, host: await hostOfTab(tabId) }
    }),
  )
}

/**
 * 图标悬停文案。
 *
 * 角标只有一个符号、一个颜色，说不出「是还在跑，还是跑完没看」—— 这里补一句明细，且**只给主动
 * 悬停的人看**（不占角标、不需要用户记任何约定）。空串 = 恢复默认（扩展名）。
 */
function setActionTitle(runningCount: number, unreadCount: number): void {
  const parts: string[] = []
  if (runningCount > 0) parts.push(`进行中 ${runningCount}`)
  if (unreadCount > 0) parts.push(`已完成 ${unreadCount}`)
  chrome.action.setTitle({ title: parts.join(' · ') }).catch(() => {})
}

/**
 * 按此刻的真实情况重算角标与悬停文案 —— **唯一**的角标写入口。
 *
 * 之所以是「重算」而不是「收到事件时顺手设一下」：事件到达的时刻与「用户此刻看得见吗」未必
 * 同时成立 —— 任务在浮层开着时开始、用户之后才收起，就是一个没有事件来过的时点
 * （见 runningConversations 处的说明），只有重算接得住。
 *
 * - 有浮层开着 → 角标清掉（进度与结果都在用户眼前）；悬停文案照报真实数量（它是状态镜像）。
 * - 否则 → 数字 = 进行中 + 跑完没看；一条都没有才清空。
 */
async function refreshBadge(): Promise<void> {
  const running = runningConversations.size
  const unread = await countUnread().catch(() => 0)
  setActionTitle(running, unread)
  const total = running + unread
  if (openFloatPorts.size > 0 || total === 0) {
    chrome.action.setBadgeText({ text: '' }).catch(() => {})
    return
  }
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' }).catch(() => {})
  chrome.action.setBadgeText({ text: badgeCount(total) }).catch(() => {})
}

/** 会话 → 还在用它的标签页；反查失败（tab 已关 / 无绑定）就当没人需要页面内的提示 */
function tabsOfConversation(conversationId: string): Promise<number[]> {
  return findTabsUsingConversation(conversationId).catch(() => [])
}

/**
 * 被「标签页关闭」中止掉的会话：收尾时据此**不记**未读通知。
 *
 * 为什么：通知的语义是「有事发生而你不在场」；这次是用户自己把页面关掉、任务随之停下，
 * 他知道会停 —— 再记一条「对话已完成」反而误导（点开只有半截结果）。
 *
 * 只在内存里，且会被这次收尾或下一条 chat:running 消费掉，所以不会长期误伤同一会话。
 */
const abortedByTabClose = new Set<string>()

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
  abortedByTabClose.add(conversationId)
    try {
      // 命令面归 offscreen（chat: 前缀）：由 SW 发出去，offscreen 收到后中止任务。
      // 用原始 sendMessage 绕过 VM 对 runtime.sendMessage 的包装（见 sendToOffscreen 说明）
      await sendRuntimeMessage({ kind: 'chat:abort', conversationId } satisfies RuntimeRequest)
    } catch {
    abortedByTabClose.delete(conversationId) // 没送到就别留着这个标记
  }
}

/**
 * chat:running 观察（offscreen 推送，chat: 前缀按约定不进命令路由，这里只旁听）：任务开始。
 * 进行中角标只在「用户没在看对话界面」时亮 —— 展开的浮层里进度自明。
 */
function handleChatRunningPush(conversationId: string): void {
  runningConversations.set(conversationId, Date.now())
  // 新任务开跑 → 上一次的「因关标签页而中止」标记作废，免得它误伤这次的收尾通知
  abortedByTabClose.delete(conversationId)
  void refreshBadge()
}

/** chat:finished 观察：任务收尾（正常 / 异常同处理，通知不区分成败） */
function handleChatFinishedPush(conversationId: string): void {
  runningConversations.delete(conversationId)
  void tabsOfConversation(conversationId).then(async (tabIds) => {
    // 没人在看就记一条未读通知。**反查不到标签页时也要记**（tab 已关 / 还没绑定）——
    // 那时角标与 popup 是用户唯一的知情途径。
    // 唯一的例外：这次收尾是「标签页被关」引发的中止（见 abortConversationOfClosedTab），
    // 那是用户自己停的，不必再告诉他「已完成」。
    if (!abortedByTabClose.delete(conversationId) && !tabIds.some((tabId) => isFloatOpenIn(tabId))) {
      await addChatDone({
        conversationId,
        tabId: tabIds[0] ?? null,
        host: await hostOfTab(tabIds[0] ?? null),
      }).catch(() => {})
    }
    await refreshBadge()
  })
}

// —— 对话界面监控 + 任务状态的事件挂载 ——
// ⚠️ 全部 addListener 必须留在 defineBackground 回调内（与既有监听器同惯例）：
// 本文件会被协议一致性测试 import（取 SW_KIND_PREFIXES），模块顶层挂监听会在
// Node/fakeBrowser 下炸（runtime.onConnect 未实现）——之前踩过。
function mountProposal2Listeners(): void {
  // SW 冷启动：内存里的计数已丢（角标是浏览器保留的，刻意不去动它 —— 那可能是用户还没看的结果），
  // 但悬停文案会是上次那句、已无从对证 —— 清成默认比留一句不知道对不对的话好。
  chrome.action.setTitle({ title: '' }).catch(() => {})

  // 对话界面监控：新文档导航开始 = 旧文档销毁，该 tab 的运行集清零。
  // 刻意用 status=loading（文档替换的准确时点），SPA 软导航只改 url、不换文档，不清。
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') resetPageRuns(tabId)
  })

  chrome.tabs.onRemoved.addListener((tabId) => {
    forgetPageTab(tabId)
    // 归属收尾：按映射找到那条会话并**中止它的任务**，再解绑。
    // 面板没开的时候标签页照样会被关，只有常驻的 SW 不漏，所以这一步必须在这里做
    // （漏了它会留在 offscreen 里跑完 —— 没人看结果、也没处按停止，纯粹烧 token）。
    void abortConversationOfClosedTab(tabId)
  })

  // 「在看」端口在这里接（短寿命：对话框展开且页面可见时才连，其余时候断开）。判据不能是
  // 「面板文档还活着」：收起只给面板加 display:none，iframe 与文档都还在（草稿 / 滚动位置刻意
  // 留着），那条端口永不断开，角标就永不亮（2026-09-21 无头实测确认）。
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== FLOAT_PANEL_OPEN_PORT) return
    const tabId = port.sender?.tab?.id
    openFloatPorts.add(port)
    if (tabId != null) openFloatPortTab.set(port, tabId)
    // 「用户回来了（并且看着它）」：**这个标签页那条会话**的通知就地标已读。按会话标、不搞全局
    // 清空 —— 角标是全局的，但「看过没看过」是各标签页各自的，不该替用户读掉别人的未读。
    if (tabId != null) {
      void getConversationIdForTab(tabId)
        .then((cid) => (cid ? markConversationRead(cid) : 0))
        .then(() => refreshBadge())
        .catch(() => {})
    }
    void refreshBadge()
    port.onDisconnect.addListener(() => {
      openFloatPorts.delete(port)
      openFloatPortTab.delete(port)
      // 收起瞬间按当前情况重算：还在跑、或还有未读，就重新亮起来
      void refreshBadge()
    })
  })

  // 页面脚本监控端口（另一条连接 'duoling:panel'：上行快照请求 + 推送寻址）
  initPageMonitorPorts()
}

// —— 浮层的右键菜单入口 ——
//
// 对话框的入口全在页面之外：工具栏 popup 里的「对话浮层」按钮，以及这个右键菜单。菜单这条由
// 浏览器渲染，页面里的东西遮不住它，也不依赖内容脚本已经挂上 UI。
//
// id 带 `duoling:` 前缀：与用户脚本的 GM_registerMenuCommand 共用 contextMenus 命名空间，
// 脚本侧是 `us:<uuid>:<menuId>`（见 dl-port.ts 的 parseMenuitemId —— 它只认那个前缀，本条会被放行）。
const FLOAT_MENU_ID = 'duoling:open-float'

/** 通知图标（打包资源，即 src/public/notify-icon.png；与用户脚本通知的兜底图标同一个文件） */
const NOTIFY_ICON = 'notify-icon.png'

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
      title: '打开哆灵对话',
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
  try {
    await chrome.tabs.sendMessage(tabId, FLOAT_OPEN_REQUEST)
  } catch {
    await chrome.notifications.create('duoling:float-open-failed', {
      type: 'basic',
      iconUrl: NOTIFY_ICON,
      title: '哆灵',
      message: '这个页面还没接上哆灵，刷新页面后再试。',
    })
  }
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
  // 这是 action 的唯一用途；对话入口是网页浮层（content script 注入），不占 action。

  // 用户脚本管理器：启动配置世界并恢复已启用脚本
  void initUserScripts().catch((e) => console.error('[duoling:userscript] init failed', e))

  // 引擎可用性监视（检测层）：SW 被保活的前提下自行轮询「运行用户脚本」开关（Chrome 对
  // 开关变化无事件），状态变化时经订阅回调通知。这里挂两个消费方（事件消费层）：
  //   ① 进程内自愈：不可用 → 可用（用户在扩展管理页开完开关）时补注册全部启用脚本——
  //      开关关闭期间启用的脚本只落库未注册，无人补注册就永远不生效；
  //   ② 广播给扩展页：横幅 / 引导页订阅 availabilityChanged 更新显示（不再各自打补丁）。
  startAvailabilityWatch()
  onAvailabilityChange(({ previous, current }) => {
    if (!previous && current.available) {
      void vmReady
        .then(async () => {
          await vmReconcile(await listProjects())
        })
        .catch((e) => console.error('[duoling:userscript] 可用性翻转对账失败', e))
    }
    // SW 收不到自己发的消息，广播只到扩展页；无接收方（没开任何页面）属常态，静默。
    // 用原始 sendMessage 绕过 VM 对 runtime.sendMessage 的包装（见 sendToOffscreen 说明）
    const push = { kind: 'userscript:availabilityChanged' as const, availability: current, changedAt: Date.now() }
    void sendRuntimeMessage(push).catch(() => {})
  })

  // 对话界面监控 / 面板端口 / 任务状态 / 深链跳转的监听器
  mountProposal2Listeners()

  // VM 运行时（Violentmonkey 库）的宿主装配：模块导入即触发（vmReady 在 vm-runtime-host.ts 顶层
  // 求值），垫片 + importScripts 库加载 + 世界配置 + 监听已在模块加载期完成；VM 空库并存形态下零注入。

  // 浮层的右键菜单入口（与 popup 的按钮同一条路：对话框平时不在页面里）
  mountFloatMenu()

  // offscreen 需「随时可用」：安装 / 更新 / 浏览器启动都立即确保容器在场。
  // Chrome 不会自动启动 offscreen，且 idle 自关未实现，故改为常驻策略（退出条件见 offscreen.ts）。
  chrome.runtime.onInstalled.addListener((details) => {
    void ensureOffscreen().catch((e) => console.error('[duoling:offscreen] ensure failed', e))
    if (details.reason === 'update') {
      // P4：VM 脚本库存于 chrome.storage，更新后仍在；重新对账一遍确保注入面与当前项目清单一致
      void listProjects()
        .then((projects) => vmReconcile(projects))
        .catch((e) => console.error('[duoling:userscript] recover failed', e))
    }
    // 装完 / 更新完顺带查一次新版本
    void runUpdateCheck().catch((e) => console.warn('[duoling:update] 检查失败', e))
  })

  chrome.runtime.onStartup.addListener(() => {
    void ensureOffscreen().catch((e) => console.error('[duoling:offscreen] ensure failed', e))
    // 每次开浏览器查一次。注意 onStartup **只在浏览器启动时**触发，SW 被挂起后唤醒不触发它
    // —— 本次启动若正好离线就会错过一轮，靠设置页「关于」里的手动检查补。
    void runUpdateCheck().catch((e) => console.warn('[duoling:update] 检查失败', e))
  })

  // SW 冷启动即确保 offscreen 在场（与上面监听器互补：SW 被终止后重启时，首条事件会触发本回调）
  void ensureOffscreen().catch((e) => console.error('[duoling:offscreen] ensure failed', e))

  // 模型配置变更通知已随存储迁移（chrome.storage → duoling-app 库）挪到 model-store 写出口：
  // 它落盘成功后自己广播 `model` 域（扩展页回拉）并推送 offscreen:configChanged（offscreen
  // 的 profile-cache 回拉）。SW 这里不再需要 storage.onChanged 兜底。

  // 用 VM 改写前的原始 addListener 注册：VM 库（common/browser.js）会包装 onMessage.addListener，
  // 把应答强制包成元组信封 [result, error]，劫持我们的 userscript:* 应答；用原始版本恢复原生
  // return true + 异步 sendResponse 的 {ok,data} 契约（见 vm-runtime-host.ts ①-0）。
  addRuntimeMessageListener((raw, sender, sendResponse) => {
    const msg = raw as RuntimeRequest | undefined
    if (!msg?.kind) return

    // 旁听 offscreen 推送（chat:running / chat:finished：任务起止）。chat: 前缀对命令面是
    // offscreen 保留前缀，SW 静默让路；这里只观察不响应（推送方对响应本就尽力而为）。
    const offscreenPush = msg as { kind: string; conversationId?: string }
    if (offscreenPush.kind === 'chat:running' && offscreenPush.conversationId) {
      handleChatRunningPush(offscreenPush.conversationId)
      return
    }
    if (offscreenPush.kind === 'chat:finished' && offscreenPush.conversationId) {
      handleChatFinishedPush(offscreenPush.conversationId)
      return
    }

    // 路由：只响应归 SW 管辖的 kind，其余静默让路给 offscreen（见 SW_KIND_PREFIXES）
    if (!SW_KIND_PREFIXES.some((p) => msg.kind.startsWith(p))) return

    // 走到这里 msg.kind 必属 SW 管辖（上面按 SW_KIND_PREFIXES 过滤过），故可安全收窄
    const handler = handlers[msg.kind as SwRequest['kind']] as
      | ((m: RuntimeRequest, sender: chrome.runtime.MessageSender) => Promise<unknown>)
      | undefined
    if (!handler) {
      sendResponse({ ok: false, error: `未知消息类型：${msg.kind}` })
      return
    }

    handler(msg, sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
    return true // 保留消息通道用于异步回传
  })
})
