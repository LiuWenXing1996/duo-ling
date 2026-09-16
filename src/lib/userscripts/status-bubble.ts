// 页面脚本状态浮窗的 SW 侧逻辑（提案② runtime-feedback-loop.md「页面脚本状态浮窗」）。
//
// 职责：判定「本页有哪些 enabled 脚本命中」（静态匹配口径）→ 计算浮窗数据 →
// 经 chrome.userScripts.execute() 注入 / 更新浮窗（独立世界 us-builtin-status）。
//
// 两个机制事实（提案决策记录「浮窗下行通道」）：
//   · userScripts API 没有「SW → userScript 世界」发消息方法（messaging 单向：世界 → SW），
//     实时更新走 execute() 补注入一条 __duolingStatusUpdate(data) 指令——同 worldId 的
//     execute 共享世界全局，与拾取器取消机制 cancelPick 同款套路；
//   · 浮窗点击「跳工作台」需要 chrome.runtime（messaging），故本世界必须 configureWorld
//     （messaging: true）——浮窗只上行发跳转请求，下行更新不依赖 messaging。
//
// 注入时机：tabs.onUpdated complete/url 变化（与脚本原生注入「只在新导航生效」同节奏——
// 刚启用脚本的页面本就要刷新才生效，浮窗跟随导航出现是自洽的）。SPA 软导航触发的
// onUpdated 靠世界全局幂等：已注入则只更新数据，不重建 DOM。
//
// 隐私足迹边界（沿用拾取器拍板）：没有命中脚本的页面**零注入**；「曾命中、现在不命中」
// 的已注入 tab 补一条自隐藏指令（内存集合跟踪，SW 被杀即失忆——最坏情况浮窗多亮一会儿）。

import type { ScriptProject, UserScriptErrorRecord } from '@/lib/userscripts/types'
import type { StatusBubbleData, StatusBubbleScript } from '@/shared/extension-ipc'
import { matchesAnyPattern } from './match-pattern'
import { listProjects } from './project-store'
import { listUserScriptErrors } from './store'
import { isUserScriptsApiAvailable } from '@/lib/element-picker-client'

/** 浮窗世界：独立世界（与每脚本一世界惯例一致） */
const STATUS_WORLD_ID = 'us-builtin-status'
/** 浮窗文件（src/public/ 随包分发到产物根目录） */
const STATUS_FILE = 'duoling-status.js'
/** 错误摘要截断（浮窗行内展示） */
const LAST_ERROR_TRUNC = 120

/** 已注入浮窗的 tab 集合（SW 内存态；onRemoved 时清理） */
const injectedTabs = new Set<number>()

/** 世界 messaging 配置只需成功一次（SW 生命周期内）；扩展更新后 SW 重启自然重来 */
let worldConfigured = false

export function forgetStatusBubbleTab(tabId: number): void {
  injectedTabs.delete(tabId)
}

/** 保证浮窗世界已开 messaging（浮窗上行「跳工作台」依赖 chrome.runtime） */
async function ensureWorldConfigured(): Promise<boolean> {
  if (worldConfigured) return true
  if (typeof chrome.userScripts?.configureWorld !== 'function') return false
  try {
    await chrome.userScripts.configureWorld({ worldId: STATUS_WORLD_ID, messaging: true })
    worldConfigured = true
    return true
  } catch (e) {
    console.warn('[duoling:status] 浮窗世界配置失败（无 messaging，跳转不可用）', e)
    return false
  }
}

/** 该 tab 当前应显示的浮窗数据；无命中脚本返回 null（= 应隐藏 / 不注入） */
export async function computeStatusBubbleData(url: string): Promise<StatusBubbleData | null> {
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    return null
  }
  if (!host) return null
  const [projects, errors] = await Promise.all([listProjects(), listUserScriptErrors()])
  const data = computeBubbleData(url, host, projects, errors)
  return data
}

/** 纯函数内核（导出便于单测）：enabled + matches 命中（排除 excludeMatches）→ 脚本行 */
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
  const scripts: StatusBubbleScript[] = hit.map((p) => {
    const mine = errors.filter((e) => e.uuid === p.uuid && (e.phase === 'runtime' || e.phase === 'register'))
    const last = mine[0] // listUserScriptErrors 最新在前
    return {
      uuid: p.uuid,
      name: p.name,
      errorCount: mine.length,
      ...(last
        ? { lastError: { message: last.message.slice(0, LAST_ERROR_TRUNC), time: last.time } }
        : {}),
    }
  })
  return { host, scripts }
}

/**
 * 导航时刷新浮窗：有命中 → 注入（幂等）或更新；无命中但此前注入过 → 补一条自隐藏。
 * 静默失败：页面正在卸载 / chrome:// 页 / userScripts 不可用，都不该影响页面本身。
 */
export async function refreshStatusBubbleForTab(tabId: number, url: string): Promise<void> {
  if (!isUserScriptsApiAvailable()) return
  if (/^(chrome|edge|about|devtools|view-source|chrome-extension):/i.test(url)) return
  try {
    const data = await computeStatusBubbleData(url)
    if (data) {
      await ensureWorldConfigured()
      await chrome.userScripts.execute({
        target: { tabId },
        worldId: STATUS_WORLD_ID,
        js: [{ file: STATUS_FILE }, { code: `__duolingStatus(${JSON.stringify(data)})` }],
      })
      injectedTabs.add(tabId)
      return
    }
    if (injectedTabs.has(tabId)) {
      await hideStatusBubble(tabId)
    }
  } catch {
    // 页面卸载中 / 世界未就绪：静默（下次导航再试）
  }
}

/** 错误落盘后的实时更新（dl-bridge 调用，sender.tab.id 定位出错 tab） */
export async function refreshStatusBubbleAfterError(tabId: number): Promise<void> {
  if (!injectedTabs.has(tabId) || !isUserScriptsApiAvailable()) return
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab.url) return
    const data = await computeStatusBubbleData(tab.url)
    if (data) {
      await chrome.userScripts.execute({
        target: { tabId },
        worldId: STATUS_WORLD_ID,
        js: [{ code: `window.__duolingStatusUpdate && __duolingStatusUpdate(${JSON.stringify(data)})` }],
      })
    } else {
      await hideStatusBubble(tabId)
    }
  } catch {
    // tab 已关闭 / 正在导航：静默
  }
}

/** 补注入自隐藏指令（幂等：浮窗不在场时该指令是 no-op） */
async function hideStatusBubble(tabId: number): Promise<void> {
  try {
    await chrome.userScripts.execute({
      target: { tabId },
      worldId: STATUS_WORLD_ID,
      js: [{ code: 'window.__duolingStatusUpdate && __duolingStatusUpdate(null)' }],
    })
  } catch {
    // 页面已卸载：静默
  } finally {
    injectedTabs.delete(tabId)
  }
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

/** 浮窗上行监听（SW 启动时挂一次）：{ __duolingStatusNav: true, uuid } 信封（api 契约同 extension-ipc.ts 注释） */
export function initStatusBubbleNav(): void {
  chrome.runtime.onUserScriptMessage.addListener((raw, _sender, sendResponse) => {
    const msg = raw as { __duolingStatusNav?: boolean; uuid?: string }
    if (!msg || msg.__duolingStatusNav !== true || !msg.uuid) return undefined
    void openWorkbenchErrors(msg.uuid).catch(() => {})
    sendResponse({ ok: true })
    return undefined
  })
}
