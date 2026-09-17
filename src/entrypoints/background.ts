// background = 桌面版 main 进程的能力运行时（对应 docs/plugin-migration-plan.md §4.3）。
// 职责：用户脚本的**注册与运行时**（chrome.userScripts）+ 项目状态库写命令的转发方
// + offscreen 容器管理 + 模型配置中转。
// 对话、模型配置不走这里（分别直连 IndexedDB 与 chrome.storage.local）。
//
// 项目数据（源码 / 配置 / 构建产物 / enabled）的权威在独立 IndexedDB 库 duoling-state，
// **写只归 offscreen**（单写方，docs/userscript-single-writer.md）：
//   · 读 —— 本文件直连 project-store，**不经容器**。注册链路不能押在 offscreen 存活上，
//     否则容器一挂所有脚本都不生效。
//   · 写 —— 经 writeViaOffscreen 转 offscreen，写完从状态库读回再注册。
// 仍在 chrome.storage 的只有两类：DL.store 值（us:gm:*）与错误日志（us:errors）——
// 写入方是用户脚本本身、不受控，且不参与「脚本是什么」的判定，故留在 SW 直写（文档 §4 边界）。
//
// 2026-09-14：工具链路移除（docs/tool-chain-removal-plan.md）后，原「工具文件与 git 操作的
// 唯一写入方 + 原子能力执行」职责整体摘除（fs-store / tool-page-template / capabilities 三个
// 依赖随之删除），此处只剩用户脚本、offscreen 与模型配置三类命令。
import '@/polyfills' // 必须在最前：补全 SW 的 global/Buffer/process 全局，早于 isomorphic-git 引用
import { defineBackground } from '#imports'
import type { ModelProfileState, OffscreenPush, RuntimeRequest, RuntimeResponse } from '@/shared/extension-ipc'

// 用户脚本管理器（v2 方案 docs/userscript-v2-plan.md Phase 0）：引擎 + 存储 + DL 桥 + 类型
import {
  configureUserScriptsWorld,
  isUserScriptsAvailable,
  getUserScriptsStatus,
  registerAllEnabled,
  recoverOnUpdate,
  registerScript,
  unregisterScripts,
  refreshPageStub,
  getEffectiveCspPermissive,
  collectCspWarnings,
  resolveInjectCode,
} from '@/lib/userscripts/engine'
import { initDlBridge } from '@/lib/userscripts/dl-bridge'
// 项目数据：读侧（直连 IndexedDB，SW 与扩展页共用）+ 写命令面（转发 offscreen）
import { getProject, listProjects } from '@/lib/userscripts/project-store'
// chrome.storage 侧：只剩 DL.store 值、错误日志与旧 GM 记录的扫描清理
import {
  listSummaries,
  clearGMValues,
  clearDeprecatedScripts,
  listUserScriptErrors,
  clearUserScriptErrors,
  appendUserScriptError,
  findUserScriptError,
} from '@/lib/userscripts/store'
// 页面脚本状态浮窗（提案②）：注入 / 更新 / 跳工作台深链（SW 侧逻辑）
import {
  forgetStatusBubbleTab,
  initStatusBubbleNav,
  refreshStatusBubbleAfterError,
  refreshStatusBubbleForTab,
} from '@/lib/userscripts/status-bubble'
import type { ScriptProject, ScriptSummary, UserScriptsAvailability } from '@/lib/userscripts/types'

// offscreen document 容器（AI 生成链路的执行宿主，docs/userscript-ai-generation.md「三容器职责与数据流」）
import { ensureOffscreen, closeOffscreen, isOffscreenReady, ensureOffscreenReady } from '@/lib/offscreen'
// 模型配置：offscreen 既收不到 storage.onChanged、也不该直连存储，一律由 SW 经命令 / 推送中转
import { getActiveProfileState } from '@/lib/model-store'
// AI 工具支路：page_snapshot 工具经 SW 调 userScripts.execute（offscreen 不可达该 API）
import { capturePageSnapshotFromTab } from '@/lib/element-picker-client'

/**
 * 模型配置在 chrome.storage.local 的键。
 * 与 src/lib/model-store.ts 的 `KEY` 是同一个值（键名是持久化契约，改名要迁数据，
 * 故两处并行硬编码、不互相 import）。
 */
const MODEL_PROFILES_KEY = 'modelProfiles'

/**
 * SW 管辖的 kind 前缀（路由白名单，docs/userscript-ai-generation.md「消息路由」）。
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
export const SW_KIND_PREFIXES = ['userscript:', 'model:', 'offscreen:', 'sw:', 'page:'] as const

/**
 * SW 管辖的请求（由上面的前缀推导，两者必须同源）。
 *
 * handlers 表只登记这些 kind：`ai:*`（git 历史）与 `state:*`（项目状态库写侧）都由 offscreen
 * 应答——它们不是 SW 的职责，不该为凑齐类型而塞进 handlers 表补死桩。
 * （`userscript:history*` 是被 `ai:*` 取代的死命令，2026-09-15 已从协议移除。）
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
        reject(new Error('offscreen 无响应'))
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
 * 就绪判据是「能应答 ai:ping」而不是「文档已存在」（前置项 1，文档 §5.3）。
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
 * 命令失败，会让用户看到「创建失败」但列表刷新后脚本明明在（2026-09-15 实测，违背直觉）。
 * 故降级：命令成功 + registerError 警告字段，UI 决定怎么呈现。
 */
async function registerOrLog(project: ScriptProject): Promise<string | undefined> {
  try {
    // 先同步 MAIN 桩（启用脚本集合可能变化），再注册脚本——保证桩与包装密钥同代
    await refreshPageStub().catch(() => {})
    await registerScript(project)
    return undefined
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    void appendUserScriptError({
      uuid: project.uuid,
      name: project.name,
      phase: 'register',
      message,
    }).catch(() => {})
    return message
  }
}

const handlers: {
  [K in SwRequest['kind']]: (msg: Extract<SwRequest, { kind: K }>) => Promise<unknown>
} = {
  // —— offscreen 容器（docs/userscript-ai-generation.md「三容器职责与数据流」）——
  // A 组只做容器与通道：这几个命令供手动 / 调试触发；B 组的生成入口会直接调 ensureOffscreen()。
  // 唤醒容器并**等到它真的能应答**才返回——调用方（aiFsClient）据此省掉了原先
  // 「ensure 完 sleep 80ms 猜监听器注册好了没有」的兜底（docs/userscript-single-writer.md §5 前置项 1）。
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
  // SW 里本来就能调；offscreen 侧须「取一次、缓存、不写日志」（docs/userscript-ai-generation.md「机制·配置通道」）。
  'model:getActiveProfile': async (): Promise<ModelProfileState | undefined> => getActiveProfileState(),

  // —— AI 工具支路 ——
  // page_snapshot 工具（offscreen 经此命令请 SW 代办）：定位当前活动标签后执行拾取器快照模式。
  // chrome.userScripts 在 SW 可用（与注册链路同源，138+ 逐扩展开关门控），offscreen 不可达。
  // 快照 = AI 判断需要时才采集（提案 2026-09-17 改判：从用户显式按钮改为 AI 工具）。
  'page:snapshot': async (): Promise<Awaited<ReturnType<typeof capturePageSnapshotFromTab>>> => {
    if (!chrome.tabs?.query) throw new Error('tabs API 不可用，无法定位目标标签页')
    // SW 无窗口上下文：lastFocusedWindow 语义 = 用户最后聚焦的窗口（与侧边栏所在窗口一致的场景）
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    if (!tab?.id) throw new Error('未找到活动标签页')
    if (tab.url && /^(chrome|edge|about|devtools|view-source):/i.test(tab.url)) {
      throw new Error('浏览器内置页面（chrome:// 等）无法注入拾取器，无法采集页面快照')
    }
    return capturePageSnapshotFromTab(tab.id)
  },

  // —— 用户脚本管理器（v2 方案 Phase 0：命令面沿用，载荷换成项目形态）——
  // 列表视图：项目读自状态库（直连 IDB），已弃用旧记录仍在 chrome.storage，两边拼接后排序
  'userscript:list': async (): Promise<ScriptSummary[]> =>
    listSummaries(await listProjects()),

  // 读完整项目（编辑器多文件用；管理页是可信扩展页，源码不过滤）
  'userscript:getProject': async (msg): Promise<ScriptProject | undefined> => getProject(msg.uuid),

  // 更新文件树 + 入口 + 构建产物（bundle 必填：UI 页构建成功后才调用），启用中则重注册。
  // 产物不变量：注入代码只来自 bundle（resolveInjectCode 无源码回退）。
  // 写转 offscreen：状态落盘与 git 快照在同一处完成，不再有「已保存但没 commit」的缝隙。
  'userscript:updateFiles': async (msg): Promise<{ warnings?: string[]; registerError?: string }> => {
    const next = await writeViaOffscreen<ScriptProject>({
      kind: 'state:updateFiles',
      uuid: msg.uuid,
      files: msg.files,
      entry: msg.entry,
      bundle: msg.bundle,
      name: msg.name,
      config: msg.config,
      note: msg.note,
    })
    await unregisterScripts([next.uuid]).catch(() => {})
    const registerError = next.enabled ? await registerOrLog(next) : undefined
    return {
      warnings: collectCspWarnings(resolveInjectCode(next), await getEffectiveCspPermissive()),
      registerError,
    }
  },

  // 一键清理全部旧 GM 形态记录（含各自 DL.store 值）
  'userscript:clearDeprecated': async (): Promise<{ removed: number }> => {
    const removed = await clearDeprecatedScripts()
    return { removed }
  },

  // 新建脚本（零输入）：命名 / 初始模板 / **构建产物** / 首次快照全在 offscreen 侧完成，SW 只负责注册。
  'userscript:create': async (): Promise<{ uuid: string; name: string; warnings?: string[]; registerError?: string }> => {
    const project = await writeViaOffscreen<ScriptProject>({ kind: 'state:create' })
    const registerError = await registerOrLog(project)
    return {
      uuid: project.uuid,
      name: project.name,
      warnings: collectCspWarnings(resolveInjectCode(project), await getEffectiveCspPermissive()),
      registerError,
    }
  },

  // AI 生成脚本落盘（docs/userscript-ai-generation.md「生成结果行为」）：转发 offscreen 单写方
  // （写状态库 + git 快照，note = AI summary），enabled 为真才注册——生成与生效解耦，
  // AI 产物默认零影响；启用走现成的 userscript:toggle。
  'userscript:createProject': async (msg): Promise<{ uuid: string; name: string; warnings?: string[]; registerError?: string }> => {
    const project = await writeViaOffscreen<ScriptProject>({
      kind: 'state:createProject',
      name: msg.name,
      config: msg.config,
      files: msg.files,
      entry: msg.entry,
      bundle: msg.bundle,
      enabled: msg.enabled,
      note: msg.note,
    })
    const registerError = project.enabled ? await registerOrLog(project) : undefined
    return {
      uuid: project.uuid,
      name: project.name,
      warnings: collectCspWarnings(resolveInjectCode(project), await getEffectiveCspPermissive()),
      registerError,
    }
  },

  // 删除：注销 → offscreen 清状态库记录 + git 仓 → 清该脚本的 DL.store 值。
  // 仓的删除原先只能靠 offscreen 启动对账兜（删完会滞留一阵），现在写侧同在 offscreen，一步清干净。
  'userscript:remove': async (msg): Promise<void> => {
    await unregisterScripts([msg.uuid]).catch(() => {})
    // 该脚本对桩并集的贡献随之消失，桩可能需要注销
    await refreshPageStub().catch(() => {})
    await writeViaOffscreen<void>({ kind: 'state:remove', uuid: msg.uuid })
    await clearGMValues(msg.uuid)
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
    await unregisterScripts([msg.uuid]).catch(() => {})
    // 关停后桩并集可能缩小，桩可能需要注销
    await refreshPageStub().catch(() => {})
    return {}
  },

  'userscript:availability': async (): Promise<UserScriptsAvailability> => getUserScriptsStatus(),

  'userscript:errors': async (): Promise<ReturnType<typeof listUserScriptErrors>> => listUserScriptErrors(),

  // 错误 ID 修复闭环（提案②）：AI 的 error_read 工具经 offscreenBridge 到此代查。
  // 精确 id 或唯一 8 位前缀；多命中 / 不存在由信封里的 reason 区分（调用方给可读文案）
  'userscript:errorRead': async (msg): Promise<ReturnType<typeof findUserScriptError>> =>
    findUserScriptError(msg.id),

  'userscript:clearErrors': async (): Promise<void> => {
    await clearUserScriptErrors()
  },

  // SW 自证：把 define 注入的构建信息回给 UI（页面显示用，不依赖 SW DevTools 在场）。
  // 消息本身会唤醒休眠的 SW，唤醒后执行的这段代码持有的就是当前生效的 __BUILD_INFO__。
  'sw:buildInfo': async (): Promise<{ time: string; branch: string }> => __BUILD_INFO__,
}

/** 用户脚本管理器启动：挂载 DL 桥 + 配置 USER_SCRIPT 世界 + 恢复已启用项目 */
async function initUserScripts(): Promise<void> {
  initDlBridge() // DL 后台桥（独立于 world 配置，只需注册一次）
  // chrome.userScripts 仅在已开启「Allow User Scripts」（Chrome ≥138）或全局开发者模式
  // （Chrome <138）/ 已授权 userScripts 权限（Firefox）时存在；否则为 undefined，
  // 直接调用会令 SW 初始化崩溃。先判存在性，不可用则优雅跳过（UI 横幅会引导开启）。
  if (!chrome.userScripts) {
    console.warn(
      '[duoling:userscript] chrome.userScripts 不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，' +
        'Chrome <138 需开启全局「开发者模式」；Firefox 需授权 userScripts 权限。用户脚本功能已禁用。',
    )
    return
  }
  await configureUserScriptsWorld()
  const ok = await isUserScriptsAvailable()
  if (!ok) {
    console.warn(
      '[duoling:userscript] userScripts 不可用：Chrome ≥138 需在扩展详情页开启「Allow User Scripts」，' +
        'Chrome <138 需开启全局「开发者模式」；Firefox 需授权 userScripts 权限',
    )
    return
  }
  await registerAllEnabled()
}

// 非 HTML 入口的构建信息：由 wxt.config.ts 的 vite.define 在配置加载期（dev = server 启动 /
// build = 构建开始）替换成字面量。SW 启动日志据此自证「跑的是哪次构建」——HTML 页面的
// 时间戳每次刷新都会变，SW 的只在 dev 重启 / 重新构建时才变，两者语义见 wxt.config.ts 注释。
declare const __BUILD_INFO__: { time: string; branch: string }

// —— 生成完成徽章（提案② #2）——
// 面板存活感知：侧边栏打开时连一条端口长连接（ChatApp 挂载时 connect），断开 = 面板关了。
// 任务收尾推送 chat:finished 到达时：面板开着 → 不做任何事；面板关着 → 图标角标亮 '1'。
// 角标是「你不在时有事发生了」的信号：不计数、失败同亮同色、面板一开即清零。
const panelPorts = new Set<chrome.runtime.Port>()

function setFinishedBadge(): void {
  chrome.action.setBadgeBackgroundColor({ color: '#d93025' }).catch(() => {})
  chrome.action.setBadgeText({ text: '1' }).catch(() => {})
}

function clearFinishedBadge(): void {
  chrome.action.setBadgeText({ text: '' }).catch(() => {})
}

/** chat:finished 观察（offscreen 推送，chat: 前缀按约定不进命令路由，这里只旁听） */
function handleChatFinishedPush(ok: boolean): void {
  if (panelPorts.size === 0) setFinishedBadge()
  void ok
}

// —— 页面脚本状态浮窗 + 完成徽章的事件挂载（提案②）——
// ⚠️ 全部 addListener 必须留在 defineBackground 回调内（与既有监听器同惯例）：
// 本文件会被协议一致性测试 import（取 SW_KIND_PREFIXES），模块顶层挂监听会在
// Node/fakeBrowser 下炸（runtime.onConnect 未实现）——之前踩过。
function mountProposal2Listeners(): void {
  // 浮窗：导航刷新（complete 覆盖普通导航；url 变化兜住 SPA 软导航）
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' && !changeInfo.url) return
    const url = changeInfo.url ?? tab.url
    if (!url) return
    void refreshStatusBubbleForTab(tabId, url)
  })

  chrome.tabs.onRemoved.addListener((tabId) => {
    forgetStatusBubbleTab(tabId)
  })

  // 面板存活端口 + 徽章清零
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'duoling:panel') return
    panelPorts.add(port)
    clearFinishedBadge() // 用户回来了：信号完成使命
    port.onDisconnect.addListener(() => panelPorts.delete(port))
  })

  chrome.sidePanel.onOpened.addListener(() => {
    clearFinishedBadge()
  })

  // 浮窗上行监听（点击脚本行 → 工作台错误日志深链）
  initStatusBubbleNav()
}

export default defineBackground(() => {
  // 启动自证：console 第一条就是构建信息，「SW 是不是新包」不用再靠猜
  console.log(`[duoling:sw] SW 启动 · 构建 ${__BUILD_INFO__.time} · 分支 ${__BUILD_INFO__.branch}`)

  // 点击工具栏图标即打开 side panel。
  // 需 manifest 同时声明 sidePanel 权限 + action 键，否则 chrome.sidePanel 不存在、此调用静默失败。
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('[duoling] setPanelBehavior failed', e))

  // 用户脚本管理器：启动配置世界并恢复已启用脚本（设计文档 §4）
  void initUserScripts().catch((e) => console.error('[duoling:userscript] init failed', e))

  // 提案②监听器：浮窗注入 / 面板端口 / 完成徽章 / 深链跳转
  mountProposal2Listeners()

  // offscreen 需「随时可用」：安装 / 更新 / 浏览器启动都立即确保容器在场。
  // Chrome 不会自动启动 offscreen，且 idle 自关未实现，故改为常驻策略（与 docs/proposals/done/ai-userscript-phase1-archive.md「决策记录」的退出条件已冲突，见 offscreen.ts）。
  chrome.runtime.onInstalled.addListener((details) => {
    void ensureOffscreen().catch((e) => console.error('[duoling:offscreen] ensure failed', e))
    if (details.reason === 'update') {
      void recoverOnUpdate().catch((e) => console.error('[duoling:userscript] recover failed', e))
    }
  })

  chrome.runtime.onStartup.addListener(() => {
    void ensureOffscreen().catch((e) => console.error('[duoling:offscreen] ensure failed', e))
  })

  // SW 冷启动即确保 offscreen 在场（与上面监听器互补：SW 被终止后重启时，首条事件会触发本回调）
  void ensureOffscreen().catch((e) => console.error('[duoling:offscreen] ensure failed', e))

  // 模型配置变更 → 通知 offscreen 重新拉取（它只有 chrome.runtime，收不到 storage.onChanged）。
  // 只发「变了」这个信号、**不推配置内容**：由 offscreen 主动回拉，apiKey 只在它取用时过界，
  // 而不是被 SW 广播（docs/userscript-ai-generation.md「机制·配置通道」）。容器不存在就直接跳过，不为一条通知唤醒上下文。
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !Object.prototype.hasOwnProperty.call(changes, MODEL_PROFILES_KEY)) {
      return
    }
    void isOffscreenReady()
      .then((ready) => {
        if (!ready) return
        const push: OffscreenPush = { kind: 'offscreen:configChanged' }
        return chrome.runtime.sendMessage(push)
      })
      .catch(() => {
        // 尽力而为：容器刚被关掉 / 无人监听时不阻断
      })
  })

  chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
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
      | ((m: RuntimeRequest) => Promise<unknown>)
      | undefined
    if (!handler) {
      sendResponse({ ok: false, error: `未知消息类型：${msg.kind}` })
      return false
    }

    handler(msg)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e: unknown) =>
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
      )
    return true // 保留消息通道用于异步回传
  })
})
