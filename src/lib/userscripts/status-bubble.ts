// 页面脚本状态浮窗的 SW 侧逻辑。
//
// 职责四件：
//   ① 按「启用脚本 matches 并集」**持久注册**浮窗（`userScripts.register`，不再每导航 execute）；
//   ② 维护浮窗**端口**（每 tab 一条），把「本页脚本 + 错误记录」推给浮窗；
//   ③ 把脚本注入时广播的 runId **转发**给浮窗；④ 浮窗点击 → 工作台错误日志深链。
//
// 三个机制事实（此前注释在此写错过，勿回退）：
//   · **注册用 `userScripts.register` + `worldId`**（世界 `us-builtin-status`）：声明式持久挂载、
//     免每导航注入、Firefox 136+ 支持。userScripts 的 `world` 只有 `USER_SCRIPT` / `MAIN`，
//     **没有 ISOLATED**——「放隔离世界」= 这里用自定义 `worldId` 的 USER_SCRIPT 世界（与页面隔离）。
//   · **下行通道用端口**：userScripts 的 messaging 并非单向。USER_SCRIPT 世界可 `runtime.connect()`
//     （需 `configureWorld({messaging:true})`），SW 侧经 `runtime.onUserScriptConnect` 拿到的
//     `Port` 是**双向**的，可 `port.postMessage()` 主动推数据（Chrome 115+/Firefox 136+）。
//     旧写法「SW 只能再 execute 一条更新指令」依赖 `userScripts.execute`——它在 Firefox 稳定版
//     不支持，故废弃（那正是浮窗当初唯一卡 Firefox 的地方）。
//   · **runId 指针归浮窗所有，不归 SW**：脚本每次页面加载 mint 一个 runId 并上报，SW 只**转发**
//     给该 tab 的浮窗，自己不存。浮窗自持 `uuid → { runId… }` 并本地过滤「本次运行」的错误。
//     因此 SW 无指针状态（重启不丢）；SW 也不做 runId 过滤——过滤口径由数据归属方（浮窗）决定。
//
// 浮窗为什么能只显「本次运行」：它是 **per-document 实例**（register 声明式注入，每个文档新建），
// 实例内的 runId 集合只装本文档收到的广播 → 真刷新即新建实例 → 旧 runId 天然出局。SW 侧不需要
// 任何「按页 / 按 tab 分区」的状态；tabId 只剩寻址用途（端口登记、tabs API 出入参）。

import type { ScriptProject, UserScriptErrorRecord } from '@/lib/userscripts/types'
import type { StatusBubbleData, StatusBubblePush, StatusBubbleScript, StatusBubbleUp } from '@/shared/extension-ipc'
import { matchesAnyPattern } from './match-pattern'
import { enabledMatchUnion, sameMatchSet } from './match-union'
import { listProjects } from './project-store'
import { listUserScriptErrors } from './store'

/** 浮窗的注册 ID：一个扩展一份（与用户脚本的 `us-<uuid>` 世界、MAIN 桩并列的内置注册） */
export const STATUS_BUBBLE_ID = 'dl-status-bubble'
/** 浮窗世界：自定义 USER_SCRIPT 世界（与页面、与每脚本世界都隔离） */
export const STATUS_WORLD_ID = 'us-builtin-status'
/** 浮窗端口名（浮窗 `runtime.connect({ name })` 用，SW 侧据此筛选） */
const STATUS_PORT_NAME = 'duoling:status'
/** 浮窗文件（src/public/ 随包分发到产物根目录） */
const STATUS_FILE = 'duoling-status.js'
/** 错误摘要截断（浮窗行内展示） */
const LAST_ERROR_TRUNC = 120

/**
 * 浮窗端口表：tabId → Port。**这不是状态，是寻址表**——只用来知道「往哪条连接推」，
 * 不含任何 runId / 错误数据（那些要么在浮窗内存里，要么在 storage）。tab 关闭时清理。
 */
const statusPorts = new Map<number, chrome.runtime.Port>()

/** 世界 messaging 配置只需成功一次（SW 生命周期内）；扩展更新后 SW 重启自然重来 */
let worldConfigured = false

export function forgetStatusBubbleTab(tabId: number): void {
  statusPorts.delete(tabId)
}

/** 保证浮窗世界已开 messaging（浮窗 `runtime.connect` 与上行都依赖它） */
async function ensureWorldConfigured(): Promise<boolean> {
  if (worldConfigured) return true
  if (typeof chrome.userScripts?.configureWorld !== 'function') return false
  try {
    await chrome.userScripts.configureWorld({ worldId: STATUS_WORLD_ID, messaging: true })
    worldConfigured = true
    return true
  } catch (e) {
    console.warn('[duoling:status] 浮窗世界配置失败（无 messaging，浮窗收不到推送）', e)
    return false
  }
}

/** 该 URL 当前应显示的浮窗数据；无命中脚本返回 null（= 浮窗自隐藏） */
export async function computeStatusBubbleData(url: string): Promise<StatusBubbleData | null> {
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  if (!host) return null
  const [projects, errors] = await Promise.all([listProjects(), listUserScriptErrors()])
  return computeBubbleData(url, host, projects, errors)
}

/**
 * 纯函数内核（导出便于单测）：enabled + matches 命中（排除 excludeMatches）→ 脚本行。
 *
 * **只做两件事：选脚本、附带原始错误记录**（runtime + register 阶段，最新在前）。
 * 「哪些错误算本次运行」不在这里判——runId 指针在浮窗侧（SW 不持有），故这里原样透传
 * （每条带 `runId` / `phase`），由浮窗按自持的 runId 集合过滤后计数与渲染。
 */
export function computeBubbleData(
  url: string,
  host: string,
  projects: ScriptProject[],
  errors: UserScriptErrorRecord[],
): StatusBubbleData | null {
  const hit = projects.filter(
    (p) =>
      p.enabled &&
      matchesAnyPattern(url, p.config.matches) &&
      !(p.config.excludeMatches?.length && matchesAnyPattern(url, p.config.excludeMatches)),
  )
  if (!hit.length) return null
  const scripts: StatusBubbleScript[] = hit.map((p) => ({
    uuid: p.uuid,
    name: p.name,
    errors: errors
      .filter((e) => e.uuid === p.uuid && (e.phase === 'runtime' || e.phase === 'register'))
      .map((e) => ({
        message: e.message.slice(0, LAST_ERROR_TRUNC),
        time: e.time,
        runId: e.runId ?? null,
        // 收窄成浮窗认识的两态：register 错误没有页面/运行上下文，浮窗里恒显
        phase: e.phase === 'register' ? ('register' as const) : ('runtime' as const),
      })),
  }))
  return { host, scripts }
}

/** 推一条给某 tab 的浮窗；没连上（未注入 / 连接已断）就丢弃——浮窗连上时会主动拉一次 */
function pushToTab(tabId: number, payload: StatusBubblePush): void {
  const port = statusPorts.get(tabId)
  if (!port) return
  try {
    port.postMessage(payload)
  } catch {
    // 连接已断（SW 重启竞态）：摘掉，等浮窗重连
    statusPorts.delete(tabId)
  }
}

/**
 * 重算并推送浮窗数据（tab 已开 → 更新；无命中 → data:null，浮窗自隐藏）。
 * 导航完成 / SPA 软导航 / 错误落盘 / 浮窗连上时都会调。
 */
export async function pushStatusBubble(tabId: number, url: string): Promise<void> {
  if (!statusPorts.has(tabId)) return
  try {
    const data = await computeStatusBubbleData(url)
    pushToTab(tabId, { t: 'data', data })
  } catch {
    // 页面卸载中 / 世界未就绪：静默（下次导航或浮窗重连再刷）
  }
}

/** 按 tabId 取当前 URL 后刷新（浮窗上行 `refresh` / 连接建立时用） */
async function pushStatusBubbleByTabId(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.url) return
    await pushStatusBubble(tabId, tab.url)
  } catch {
    // tab 已关闭：静默
  }
}

/** 错误落盘后的实时更新（dl-bridge 调用，sender.tab.id 定位出错 tab） */
export async function refreshStatusBubbleAfterError(tabId: number): Promise<void> {
  if (!statusPorts.has(tabId)) return
  await pushStatusBubbleByTabId(tabId)
}

/**
 * 脚本注入时广播的 runId → 转给该 tab 的浮窗（**只转发，不存储**）。
 * 浮窗未连上就丢弃：浮窗是 per-document 实例，连上时会拉到完整数据，且真刷新本就要换新 runId。
 */
export function relayRunStart(tabId: number, uuid: string, runId: string): void {
  pushToTab(tabId, { t: 'runstart', uuid, runId })
}

/**
 * 按并集维护浮窗注册（幂等；调用方负责串行化，与 MAIN 桩同走 registerChain）。
 *
 * 并集为空 → 注销：**没有命中脚本的页面零注入**的隐私边界由此保持（浮窗不会被静默塞进全网站点）。
 * 并集未变且已注册 → 跳过重注册（重注册会让已加载页面到下次导航才换新）。
 */
export async function syncStatusBubbleRegister(projects?: ScriptProject[]): Promise<void> {
  if (!chrome.userScripts || typeof chrome.userScripts.register !== 'function') return
  const list = projects ?? (await listProjects())
  const union = enabledMatchUnion(list)
  let existing: chrome.userScripts.RegisteredUserScript | undefined
  try {
    existing = (await chrome.userScripts.getScripts()).find((s) => s.id === STATUS_BUBBLE_ID)
  } catch {
    return // 引擎不可用时静默跳过（上层已有状态横幅兜底）
  }
  if (!union) {
    if (existing) await chrome.userScripts.unregister({ ids: [STATUS_BUBBLE_ID] }).catch(() => {})
    return
  }
  if (existing && sameMatchSet(existing, union)) return
  await ensureWorldConfigured()
  await chrome.userScripts.unregister({ ids: [STATUS_BUBBLE_ID] }).catch(() => {})
  const script: chrome.userScripts.RegisteredUserScript = {
    id: STATUS_BUBBLE_ID,
    worldId: STATUS_WORLD_ID,
    js: [{ file: STATUS_FILE }],
    matches: union.matches,
    excludeMatches: union.excludeMatches,
    includeGlobs: union.includeGlobs,
    excludeGlobs: union.excludeGlobs,
    // document_start：浮窗要早于脚本默认的 document_end 广播挂好端口监听（少漏 runId）
    runAt: 'document_start',
    // 不设 allFrames：浮窗只出现在主 frame（往子帧里画浮窗没有意义）
  }
  try {
    await chrome.userScripts.register([script])
    console.log('[duoling:sw] 状态浮窗注册成功：', JSON.stringify(union.matches))
  } catch (e) {
    console.warn('[duoling:sw] 状态浮窗注册失败：', e)
    throw e
  }
}

/**
 * 浮窗端口监听（SW 启动时挂一次）：连接登记 / 上行消息 / 断开清理。
 *
 * ⚠️ 必须由 defineBackground 调用，不在模块顶层挂监听：本模块会被协议一致性测试间接触达，
 * fakeBrowser 没有 `onUserScriptConnect`，顶层挂载会直接炸（踩过 onConnect 那次）。
 */
export function initStatusBubblePorts(): void {
  if (typeof chrome.runtime.onUserScriptConnect?.addListener !== 'function') return
  chrome.runtime.onUserScriptConnect.addListener((port) => {
    if (port.name !== STATUS_PORT_NAME) return
    const tabId = port.sender?.tab?.id
    if (tabId == null) {
      console.warn('[duoling:status] 浮窗端口缺少 tabId，无法关联页面')
      return
    }
    statusPorts.set(tabId, port)
    port.onDisconnect.addListener(() => {
      // 只清理「当前登记的就是这条连接」的情形（SW 重启后浮窗重连会换新 Port）
      if (statusPorts.get(tabId) === port) statusPorts.delete(tabId)
    })
    port.onMessage.addListener((raw) => {
      const msg = raw as StatusBubbleUp
      if (!msg) return
      if (msg.t === 'openErrors' && msg.uuid) void openWorkbenchErrors(msg.uuid).catch(() => {})
      // 浮窗重连后主动拉一次：补上「断连期间少收的推送」
      if (msg.t === 'refresh') void pushStatusBubbleByTabId(tabId)
    })
    // 连上即给首帧（省掉浮窗侧一次 refresh 往返）
    void pushStatusBubbleByTabId(tabId)
  })
}

/**
 * 浮窗上行：点击脚本行 → 打开 / 聚焦工作台并深链定位到该脚本的错误（workbench.html#/errors/<uuid>）。
 * 已打开工作台时更新 hash 并激活（hash 变化不重载页面，WorkbenchApp 的 hash 处理器接管）。
 */
export async function openWorkbenchErrors(uuid: string): Promise<void> {
  const base = chrome.runtime.getURL('workbench.html')
  const url = `${base}#/errors/${encodeURIComponent(uuid)}`
  const tabs = await chrome.tabs.query({ url: `${base}*` })
  const existing = tabs.find((t) => t.id != null)
  if (existing?.id != null) {
    await chrome.tabs.update(existing.id, { url, active: true })
    if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {})
  } else {
    await chrome.tabs.create({ url })
  }
}
