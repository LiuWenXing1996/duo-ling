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
import type { ModelProfileState, RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'
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
// 网页浮层开关：右键菜单那条入口要在发「调出浮层」请求前把开关补齐（与 popup 的按钮同策略）
import { ensureFloatEnabled } from '@/lib/float-panel-store'
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
// 对话界面页面脚本监控（运行时口径）：按 tab 的运行登记 + 面板端口
import {
  forgetPageTab,
  initPageMonitorPorts,
  resetPageRuns,
} from '@/lib/userscripts/page-monitor'
// 会话的标签页归属映射（duoling-app 库）：标签页关闭时在这里清（见 tabs.onRemoved 处说明）；
// page:snapshot 也用它反查「这条会话在哪个标签页上」（会话按 tab 归属）
import { findTabsUsingConversation, unbindTab } from '@/lib/conversation-tab-map'
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
export const SW_KIND_PREFIXES = ['userscript:', 'model:', 'offscreen:', 'sw:', 'page:', 'tab:'] as const

/**
 * SW 管辖的请求（由上面的前缀推导，两者必须同源）。
 *
 * handlers 表只登记这些 kind：`ai:*`（git 历史）与 `state:*`（项目状态库写侧）都由 offscreen
 * 应答——它们不是 SW 的职责，不该为凑齐类型而塞进 handlers 表补死桩。
 */
type SwRequest = Extract<RuntimeRequest, { kind: `${(typeof SW_KIND_PREFIXES)[number]}${string}` }>

/** SW → offscreen 的请求封装：转发 ai:*（git 历史）与 state:*（项目状态库写侧）命令面。统一信封解包。 */
function sendToOffscreen<T>(request: RuntimeRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response: RuntimeResponse<T> | undefined) => {
      const lastError = chrome.runtime.lastError
      if (lastError) {
        reject(new Error(lastError.message))
        return
      }
      if (!response) {
        reject(new Error('扩展服务未响应，请重试'))
        return
      }
      if (!response.ok) {
        reject(new Error(response.error))
        return
      }
      resolve(response.data as T)
    })
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
    // 先同步内置注册（MAIN 桩，启用脚本集合可能变化），再注册脚本——保证桩与包装密钥同代
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
  // 仓的删除原先只能靠 offscreen 启动对账兜（删完会滞留一阵），现在写侧同在 offscreen，一步清干净。
  'userscript:remove': async (msg): Promise<void> => {
    // 注销失败不能纯静默：状态库删掉后这条 uuid 不再出现在任何对账清单里，
    // 幽灵注册会一直注入到下次 SW 冷启动（registerAllEnabled 全量对账）才被清
    await unregisterScripts([msg.uuid]).catch((e) =>
      console.warn('[duoling:sw] 删除前注销失败（SW 冷启动对账会清，但期间页面刷新仍会注入）：', msg.uuid, e),
    )
    await writeViaOffscreen<void>({ kind: 'state:remove', uuid: msg.uuid })
    // 该脚本对内置并集的贡献随状态库删除而消失，MAIN 桩可能需要注销。
    // 必须放在清库**之后**：清库前读库还算得进这个脚本，并集「未变」、桩被已在位检查跳过，
    // 桩就带着已删脚本的 matches 残留（removeAll 之前整体漏调同属这一族问题）
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
      // 此前整体漏调，中继件带着旧并集（如 ["*://*/*"]）残留注册，白占每个页面的注入面
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
    // 关停后内置并集可能缩小，MAIN 桩可能需要注销
    await refreshBuiltinScripts().catch(() => {})
    return {}
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
    return
  }
  await configureUserScriptsWorld()
  const ok = await isUserScriptsAvailable()
  if (!ok) {
    console.warn(
      '[duoling:userscript] 用户脚本功能不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，' +
        'Chrome <138 需开启全局「开发者模式」；Firefox 需授权 userScripts 权限',
    )
    return
  }
  await registerAllEnabled()
}

// 非 HTML 入口的构建信息：由 wxt.config.ts 的 vite.define 在配置加载期（dev = server 启动 /
// build = 构建开始）替换成字面量。SW 启动日志据此自证「跑的是哪次构建」——HTML 页面的
// 时间戳每次刷新都会变，SW 的只在 dev 重启 / 重新构建时才变，两者语义见 wxt.config.ts 注释。
// 这里只做「非 undefined」的收窄（SW 侧该标识符必然存在），形状引自 src/lib/build-info.ts。
declare const __BUILD_INFO__: InjectedBuildInfo

// —— 生成完成徽章 ——
// 「用户此刻在看对话界面吗」的判据 = **浮层是否展开**：content script 展开时连上
// FLOAT_PANEL_OPEN_PORT、收起时断开（页面卸载 / 导航则端口自然断）。**不能拿「面板文档存活」
// 判**：收起草稿浮层只是 `display:none`，iframe 与面板文档都还在，端口永不断开 → 角标永不亮
// （2026-09-21 无头实测：收起后推 chat:finished，角标纹丝不动；把 iframe 真摘掉才亮）。
// 任务收尾推送 chat:finished 到达时：浮层展开着 → 不做任何事；没展开 → 图标角标亮 '1'。
// 角标是「你不在时有事发生了」的信号：不计数、失败同亮同色，浮层一展开即清零。
const openFloatPorts = new Set<chrome.runtime.Port>()

function setFinishedBadge(): void {
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' }).catch(() => {})
  chrome.action.setBadgeText({ text: '1' }).catch(() => {})
}

function clearFinishedBadge(): void {
  chrome.action.setBadgeText({ text: '' }).catch(() => {})
}

/** chat:finished 观察（offscreen 推送，chat: 前缀按约定不进命令路由，这里只旁听） */
function handleChatFinishedPush(ok: boolean): void {
  if (openFloatPorts.size === 0) setFinishedBadge()
  void ok
}

// —— 对话界面监控 + 完成徽章的事件挂载 ——
// ⚠️ 全部 addListener 必须留在 defineBackground 回调内（与既有监听器同惯例）：
// 本文件会被协议一致性测试 import（取 SW_KIND_PREFIXES），模块顶层挂监听会在
// Node/fakeBrowser 下炸（runtime.onConnect 未实现）——之前踩过。
function mountProposal2Listeners(): void {
  // 对话界面监控：新文档导航开始 = 旧文档销毁，该 tab 的运行集清零。
  // 刻意用 status=loading（文档替换的准确时点），SPA 软导航只改 url、不换文档，不清。
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') resetPageRuns(tabId)
  })

  chrome.tabs.onRemoved.addListener((tabId) => {
    forgetPageTab(tabId)
    // 会话归属映射一并清掉：面板没开的时候标签页照样会被关，只有常驻的 SW 不漏。
    // 漏清也不致错 —— 会话历史的删除门自己会验「标签页是否还开着」，残留项判不出「在用」
    // （见 conversation-tab-map 的 getActiveTabBindings）；这里清是为了不留垃圾。
    void unbindTab(tabId).catch(() => {})
  })

  // 浮层展开态端口：连上 = 有浮层正展开（顺手清角标 ——「用户回来了」），断开 = 收起 / 页面走了。
  // 判据用**展开态**而不是「面板文档还活着」：收起只给面板加 display:none，iframe 与文档都还在
  // （草稿 / 滚动位置刻意留着），那条端口永不断开，角标就永不亮（2026-09-21 无头实测确认）。
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== FLOAT_PANEL_OPEN_PORT) return
    openFloatPorts.add(port)
    clearFinishedBadge()
    port.onDisconnect.addListener(() => openFloatPorts.delete(port))
  })

  // 页面脚本监控端口（另一条连接 'duoling:panel'：上行快照请求 + 推送寻址）
  initPageMonitorPorts()
}

// —— 浮层的右键菜单入口 ——
//
// 网页浮层一共有三个入口：页面里那颗悬浮按钮（主入口，但可能被页面元素压住 —— 含无视 z-index
// 的 top layer，也可能因站点开关关着而整块不挂）、工具栏 popup 里的「对话浮层」按钮，以及这个
// 右键菜单。菜单这条由浏览器渲染，页面里的东西遮不住它，也不依赖内容脚本已经挂上 UI。
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

/** 取 URL 的 hostname；解析不了（空 URL / 非标准 scheme）一律空串，调用方按「认不出站点」对待 */
function hostnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').hostname
  } catch {
    return ''
  }
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
  const host = hostnameOf(tab.url)
  // 认不出是哪个站点时不动开关：改总开关可能是用户没要求的动作
  if (host) await ensureFloatEnabled(host)
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
      void ensureWorldsConfigured()
        .then(() => registerAllEnabled())
        .catch((e) => console.error('[duoling:userscript] 可用性翻转补注册失败', e))
    }
    // SW 收不到自己发的消息，广播只到扩展页；无接收方（没开任何页面）属常态，静默
    const push = { kind: 'userscript:availabilityChanged' as const, availability: current, changedAt: Date.now() }
    void chrome.runtime.sendMessage(push).catch(() => {})
  })

  // 对话界面监控 / 面板端口 / 完成徽章 / 深链跳转的监听器
  mountProposal2Listeners()

  // 浮层的右键菜单入口（页面内那颗悬浮按钮点不到时的第二条路）
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

    // 旁听 offscreen 推送（chat:finished：任务收尾）。chat: 前缀对命令面是 offscreen 保留
    // 前缀，SW 静默让路；这里只观察不响应（推送方对响应本就尽力而为）。
    if ((msg as { kind: string }).kind === 'chat:finished') {
      handleChatFinishedPush((msg as { ok?: boolean }).ok === true)
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
