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
} from '@/shared/extension-ipc'
import { runtimeSend } from '@/shared/runtime-send'
// 注入物的形状取自同一处，本文件不再各写一份（加字段时只改一处才不会漏）
import type { InjectedBuildInfo } from '@/lib/build-info'

// 用户脚本管理器（v2 方案）：引擎 + 存储 + GM 桥 + 类型
import {
  configureUserScriptsWorld,
  ensureWorldsConfigured,
  isUserScriptsAvailable,
  getUserScriptsStatus,
  registerAllEnabled,
  recoverOnUpdate,
  registerScript,
  unregisterScripts,
  refreshBuiltinScripts,
  refreshNetRecorder,
  collectCspWarnings,
  resolveInjectCode,
} from '@/lib/userscripts/engine'
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
import { initDlBridge } from '@/lib/userscripts/dl-bridge'
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
// 对话界面页面脚本监控（运行时口径）：按 tab 的运行登记 + 面板端口 —— 工具栏角标的数字就是它
import {
  forgetPageTab,
  initPageMonitorPorts,
  onPageRunsChanged,
  pageRunsByTab,
  resetPageRuns,
} from '@/lib/userscripts/page-monitor'
// 会话的标签页归属映射（duoling-app 库）：标签页关闭时在这里清（见 tabs.onRemoved 处说明）；
// page:snapshot 也用它反查「这条会话在哪个标签页上」（会话按 tab 归属）
import {
  findTabsUsingConversation,
  getConversationIdForTab,
  unbindTab,
} from '@/lib/conversation-tab-map'
// 通知中心（duoling-app 库）：任务收尾记一条未读通知（无人查看时），popup 给明细。
// 与角标无关 —— 角标只报脚本运行数，通知不再进角标
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

/** SW → offscreen 的请求封装：转发 ai:*（git 历史）与 state:*（项目状态库写侧）命令面。统一信封解包。 */
function sendToOffscreen<T>(request: RuntimeRequest): Promise<T> {
  return runtimeSend<T>(request)
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
    // 先同步内置注册（中继件，启用脚本集合可能变化），再注册脚本——保证中继件与包装密钥同代
    await refreshBuiltinScripts().catch(() => {})
    await registerScript(project)
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
  // 唤醒容器并**等到它真的能应答**才返回——调用方（fsClient 等）无须再 sleep 猜监听器是否注册好。
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
    const project = await writeViaOffscreen<ScriptProject>({ kind: 'state:create' })
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
    await writeViaOffscreen<void>({ kind: 'state:remove', uuid: msg.uuid })
    // 该脚本对内置并集的贡献随状态库删除而消失，中继件可能需要注销。
    // 必须放在清库**之后**：清库前读库还算得进这个脚本，并集「未变」、中继件被已在位检查跳过，
    // 中继件就带着已删脚本的 matches 残留（removeAll 之前整体漏调同属这一族问题）
    await refreshBuiltinScripts().catch(() => {})
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
    // 注销失败不能纯静默（与单删/关停同语义）：吞掉后这批 uuid 成幽灵注册——
    // 页面刷新照样注入；且刚删完没有启用脚本、offscreen 心跳停止保活前 SW 一直活着，
    // registerAllEnabled 的冷启动对账不会跑，幽灵能一路活到下次浏览器重启
    await unregisterScripts(uuids).catch((e) =>
      console.warn('[duoling:sw] 全部删除前注销失败（SW 冷启动对账会清，但期间页面刷新仍会注入）：', uuids, e),
    )
    try {
      const removed = await writeViaOffscreen<number>({ kind: 'state:removeAll' })
      // 状态库清空后再同步内置并集：此时读库必为空 → 中继件与录制转发件整体注销。
      // 漏了这步的话，中继件会带着旧并集残留注册，白占每个页面的注入面
      await refreshBuiltinScripts().catch(() => {})
      for (const uuid of uuids) await clearGMValues(uuid)
      // 报错记录逐 uuid 清（与单删同一条语义：删脚本 = 清该脚本名下的一切）
      for (const uuid of uuids) await clearUserScriptErrors(uuid)
      for (const uuid of uuids) await clearRunStats(uuid)
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
    const next = await writeViaOffscreen<ScriptProject>({
      kind: 'state:toggle',
      uuid: msg.uuid,
      enabled: msg.enabled,
    })
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

  // 标一条已读：只影响 popup 的明细（角标与悬停文案都不看未读，无需重算）
  'notify:read': async (msg): Promise<{ unread: number }> => {
    await markRead(msg.id)
    return { unread: await countUnread() }
  },

  'notify:readAll': async (): Promise<{ unread: number }> => {
    await markAllRead()
    return { unread: 0 }
  },

  // 会话被删 → 它的通知一并清掉（留着只会指向一个不存在的对话）。
  // **走 SW 是为了单一写口**：通知由 SW 记、也由 SW 清（popup 的已读同样走命令面），工作台自己动库
  // 就多出一个彼此不知情的写方。
  'notify:drop': async (msg): Promise<{ unread: number }> => {
    if (msg.all) await removeAll()
    else if (msg.conversationId) await removeByConversation(msg.conversationId)
    return { unread: await countUnread() }
  },

  // SW 自证：把 define 注入的构建信息回给 UI（页面显示用，不依赖 SW DevTools 在场）。
  // 消息本身会唤醒休眠的 SW，唤醒后执行的这段代码持有的就是当前生效的 __BUILD_INFO__。
  'sw:buildInfo': async (): Promise<{ time: string; branch: string }> => __BUILD_INFO__,
}

/** 用户脚本管理器启动：挂载 GM 桥 + 配置 USER_SCRIPT 世界 + 恢复已启用项目 */
async function initUserScripts(): Promise<void> {
  initDlBridge() // DL 后台桥（独立于 world 配置，只需注册一次）
  initDlPort() // DL Port 事件底座（菜单点击 / 存储变更 / 通知点击的下行回推，同上只挂一次）
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
  await registerAllEnabled()
}

// 非 HTML 入口的构建信息：由 wxt.config.ts 的 vite.define 在配置加载期（dev = server 启动 /
// build = 构建开始）替换成字面量。SW 启动日志据此自证「跑的是哪次构建」——HTML 页面的
// 时间戳每次刷新都会变，SW 的只在 dev 重启 / 重新构建时才变，两者语义见 wxt.config.ts 注释。
// 这里只做「非 undefined」的收窄（SW 侧该标识符必然存在），形状引自 src/lib/build-info.ts。
declare const __BUILD_INFO__: InjectedBuildInfo

// —— 工具栏角标：这个标签页在跑几个脚本 ——
//
// 数字 = `pageRunsByTab`（page-monitor 的运行登记表）里**该标签页**的运行集大小 —— 与浮层灵动岛、
// popup 的「页面脚本」区是**同一个数**（三处对不上就是在骗人）。归属天然按 tab：登记表本身就是按
// tab 建的。没有脚本在跑的标签页不亮，别的页面上的脚本也不在这儿报数。
//
// **为什么不是「会话在跑几个任务」**：那种数字只会是 0 / 1（一个标签页只归属一条会话，见
// conversation-tab-map）—— 既报不出量，说的也不是「这个页面此刻是什么样」。脚本数才是这个页面
// 自己的状态；会话那边的进度与结果由 popup 明细与浮层负责。
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
//
// —— 通知中心：任务收尾（会话口径）——
//
// offscreen 的 chat:running / chat:finished 旁听：任务收尾且**没人看着**时记一条未读通知，popup
// 给明细（几条在进行中、哪几条跑完没看，点条目跳过去并标已读）。**与角标已无关系**：角标不报会话。
//
// 「用户此刻在看对话界面吗」的判据 = **对话框展开 且 页面可见**：两条都成立时 content script 连上
// FLOAT_PANEL_OPEN_PORT，否则断开（页面卸载 / 导航则端口自然断）。**不能拿「面板文档存活」判**：
// 收起对话框只是 `display:none`，iframe 与面板文档都还在、端口永不断开 → `isFloatOpenIn` 恒为真 →
// 跑完那条通知永远记不上。页面卸载 / 导航才断得开，故收起走的是「只藏不销毁」那条路。
// 「页面可见」那条同样不能省：对话框还开着、人却切去别的标签页，那时他什么都看不见，照旧要记。
//
// 这条端口连通 = 那个标签页上「对话界面开着且页面可见」，故它只管**自己这个标签页**那条会话的
// 通知归属（见 handleChatFinishedPush），别的标签页照记。
/** 展开态连接 → 所属标签页（「**这个** tab 的对话框开着吗」：决定收尾要不要记未读通知） */
const openFloatPortTab = new Map<chrome.runtime.Port, number>()

/** 该标签页的对话界面此刻是否展开（= 进度与结果都在用户眼前） */
function isFloatOpenIn(tabId: number): boolean {
  for (const tab of openFloatPortTab.values()) if (tab === tabId) return true
  return false
}

/**
 * 角标数字：超过 9 显示 9+（角标最多 4 字符，两位数在工具栏尺寸下已经看不清）。
 * 一个页面上的脚本数没有上限（命中同一条 matches 的脚本可以有很多个），这条分支是真会走到的。
 */
function badgeCount(n: number): string {
  return n > 9 ? '9+' : String(n)
}

/**
 * 进行中的对话（chat:running 进来、chat:finished 出去）：会话 id → 开始时间。
 *
 * **刻意不落库**：它没有稳定落点 —— SW 被回收后内存里这份就没了，而库里若留着一条恒为
 * 「进行中」的记录，再不会有事件来收尾它，就成了假状态。所以进行中只活在内存，popup 问起时
 * 把当前快照给它。
 *
 * **为什么要记而不是每次现算**：`runningConversations` 还是「标签页被关 → 中止它的任务」那条路
 * 的判据（见 abortConversationOfClosedTab）—— 不在跑就不必惊动 offscreen。
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

/** 会话 → 还在用它的标签页（收尾时据此判「有没有人在看」并取站点名）；反查失败就当没人用 */
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
    // 命令面归 offscreen（chat: 前缀）：由 SW 发出去，offscreen 收到后中止任务
    await chrome.runtime.sendMessage({ kind: 'chat:abort', conversationId } satisfies RuntimeRequest)
  } catch {
    abortedByTabClose.delete(conversationId) // 没送到就别留着这个标记
  }
}

/**
 * chat:running 观察（offscreen 推送，chat: 前缀按约定不进命令路由，这里只旁听）：任务开始。
 * **不碰角标** —— 角标只报脚本运行数，会话与它无关。
 */
function handleChatRunningPush(conversationId: string): void {
  runningConversations.set(conversationId, Date.now())
  // 新任务开跑 → 上一次的「因关标签页而中止」标记作废，免得它误伤这次的收尾通知
  abortedByTabClose.delete(conversationId)
}

/** chat:finished 观察：任务收尾（正常 / 异常同处理，通知不区分成败） */
function handleChatFinishedPush(conversationId: string): void {
  runningConversations.delete(conversationId)
  void tabsOfConversation(conversationId).then(async (tabIds) => {
    // 没人在看就记一条未读通知。**反查不到标签页时也要记**（tab 已关 / 还没绑定）——
    // 那时 popup 是用户唯一的知情途径（通知按会话记，「哪条对话」这一栏取自标签页的站点名）。
    // 唯一的例外：这次收尾是「标签页被关」引发的中止（见 abortConversationOfClosedTab），
    // 那是用户自己停的，不必再告诉他「已完成」。
    if (abortedByTabClose.delete(conversationId) || tabIds.some((tabId) => isFloatOpenIn(tabId))) return
    await addChatDone({
      conversationId,
      tabId: tabIds[0] ?? null,
      host: await hostOfTab(tabIds[0] ?? null),
    }).catch(() => {})
  })
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
  // 至于「SW 空闲被回收」这条不必担心：有启用脚本时它由 offscreen 心跳保活（见 page-monitor 头注释）。
  void clearAllBadges()
    .then(() => refreshBadge())
    .catch(() => {})

  // 角标的重算时机：登记表一变就重算（注入登记 / 换文档清零 / 关标签页清除）。
  // 角标不做持久化，也不自己维护计数 —— 数字永远是登记表现算出来的。
  onPageRunsChanged(() => refreshBadge())

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
  // 留着），那条端口永不断开 → isFloatOpenIn 恒为真 → 跑完那条通知永远记不上。
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== FLOAT_PANEL_OPEN_PORT) return
    const tabId = port.sender?.tab?.id
    if (tabId != null) openFloatPortTab.set(port, tabId)
    // 「用户回来了（并且看着它）」：**这个标签页那条会话**的通知就地标已读。按会话标、不搞全局
    // 清空 —— 看过没看过是各标签页各自的，不该替用户读掉别人的未读。
    if (tabId != null) {
      void getConversationIdForTab(tabId)
        .then((cid) => (cid ? markConversationRead(cid) : 0))
        .catch(() => {})
    }
    port.onDisconnect.addListener(() => {
      openFloatPortTab.delete(port)
      // 收起 = 又没人看着了：之后再收尾的任务照旧要记一条未读通知。
      // 角标不用动 —— 它与「在看没看」无关，只数这个页面在跑几个脚本。
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
    void chrome.runtime.sendMessage(push).catch(() => {})
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
  })

  // SW 冷启动即确保 offscreen 在场（与上面监听器互补：SW 被终止后重启时，首条事件会触发本回调）
  void ensureOffscreen().catch((e) => console.error('[duoling:offscreen] ensure failed', e))

  // 模型配置变更通知已随存储迁移（chrome.storage → duoling-app 库）挪到 model-store 写出口：
  // 它落盘成功后自己广播 `model` 域（扩展页回拉）并推送 offscreen:configChanged（offscreen
  // 的 profile-cache 回拉）。SW 这里不再需要 storage.onChanged 兜底。

  chrome.runtime.onMessage.addListener((raw, sender, sendResponse) => {
    const msg = raw as RuntimeRequest | undefined
    if (!msg?.kind) return

    // 旁听 offscreen 推送（chat:running / chat:finished：任务起止）。chat: 前缀对命令面是
    // offscreen 保留前缀，SW 静默让路；这里只观察不响应（推送方对响应本就尽力而为）。
    const offscreenPush = msg as { kind: string; conversationId?: string }
    if (offscreenPush.kind === 'chat:running' && offscreenPush.conversationId) {
      handleChatRunningPush(offscreenPush.conversationId)
      return false
    }
    if (offscreenPush.kind === 'chat:finished' && offscreenPush.conversationId) {
      handleChatFinishedPush(offscreenPush.conversationId)
      return false
    }

    // 路由：只响应归 SW 管辖的 kind，其余静默让路给 offscreen（见 SW_KIND_PREFIXES）
    if (!SW_KIND_PREFIXES.some((p) => msg.kind.startsWith(p))) return false

    // 走到这里 msg.kind 必属 SW 管辖（上面按 SW_KIND_PREFIXES 过滤过），故可安全收窄
    const handler = handlers[msg.kind as SwRequest['kind']] as
      | ((m: RuntimeRequest, sender: chrome.runtime.MessageSender) => Promise<unknown>)
      | undefined
    if (!handler) {
      sendResponse({ ok: false, error: `未知消息类型：${msg.kind}` })
      return false
    }

    handler(msg, sender)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
    return true // 保留消息通道用于异步回传
  })
})
