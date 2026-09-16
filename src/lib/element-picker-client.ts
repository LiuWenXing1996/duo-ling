// 元素拾取 / 页面快照的**发起侧**封装（侧边栏与 SW 两个上下文共用，docs/proposals/implementing/element-picker.md）。
//
// 链路：chrome.userScripts.execute() 按 tabId 向**已加载页面**注入拾取器
// （src/public/duoling-picker.js，独立世界 us-builtin-picker），注入脚本返回
// 「点选时才 resolve」的 Promise，浏览器等结算后把载荷从 execute() 的返回值带回——
// 无消息回传链、无 SW 参与（前置探针已验证扩展页可访问该 API，见提案「动工前置验证」）。
//
// 采集方归属（2026-09-17 改判）：点选 = 用户在侧边栏点按钮（用户显式）；
// 快照 = AI 的 page_snapshot 工具经 SW 调 capturePageSnapshotFromTab（SW 定位活动标签）。
//
// 失败语义（都有明确文案，不静默）：
//   · chrome.userScripts 不可用 —— 138+ 逐扩展「允许运行用户脚本」开关未开 /
//     开发者模式未开，给引导文案（探针实测：开关关闭时该命名空间在所有上下文都不存在）；
//   · 内置页（chrome:// 等）不可注入；
//   · 快照：页面关闭 / 导航 → 60 秒超时兜底。

import type { ElementPickContext, PageSnapshotContext } from '@/shared/extension-ipc'

/** 拾取器世界：独立世界（与每脚本一世界惯例一致，提案「世界归属」决策） */
const PICKER_WORLD_ID = 'us-builtin-picker'
/** 拾取器文件（src/public/ 随包分发到产物根目录） */
const PICKER_FILE = 'duoling-picker.js'
/** 拾取超时：用户拾取中关页 / 导航会让注入 Promise 永不结算，兜底视为取消 */
const PICK_TIMEOUT_MS = 60_000

/** chrome.userScripts（含 execute）是否可用；不可用 = 138+ 逐扩展开关未开或开发者模式未开 */
export function isUserScriptsApiAvailable(): boolean {
  return typeof chrome.userScripts !== 'undefined' && typeof chrome.userScripts.execute === 'function'
}

/** 不可用时的引导文案（给用户行动指引，不裸抛 API 名） */
export function userScriptsUnavailableMessage(): string {
  return (
    '拾取器不可用：请到 chrome://extensions → 哆灵 → 详情，打开「允许运行用户脚本」开关' +
    '（并确认已开启右上角「开发者模式」），然后重试。'
  )
}

function ensureAvailable(): void {
  if (!isUserScriptsApiAvailable()) throw new Error(userScriptsUnavailableMessage())
}

/** 目标标签页：与档 0（collectPageContext）同语义——当前窗口的活动标签 */
async function getTargetTabId(): Promise<number> {
  if (!chrome.tabs?.query) throw new Error('tabs API 不可用，无法定位目标标签页')
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab?.id) throw new Error('未找到活动标签页')
  if (tab.url && /^(chrome|edge|about|devtools|view-source):/i.test(tab.url)) {
    throw new Error('浏览器内置页面（chrome:// 等）无法注入拾取器，请切到普通网页后重试')
  }
  return tab.id
}

/** 超时兜底：Promise 永不结算时按文案超时（导出便于单测） */
export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

/** 注入并执行拾取器（js 数组顺序执行，返回值取最后一段 code 的补全值——即运行器返回的 Promise） */
async function executePicker<T>(mode: 'pick' | 'snapshot', tabId: number): Promise<T | null> {
  const results = await chrome.userScripts.execute<T>({
    target: { tabId },
    worldId: PICKER_WORLD_ID,
    js: [{ file: PICKER_FILE }, { code: `__duolingPicker(${JSON.stringify(mode)})` }],
  })
  // execute 返回数组按注入目标各一项（我们只注入单个 tab），result 为注入脚本 Promise 的结算值
  const first = results[0]
  return (first?.result ?? null) as T | null
}

/**
 * 点选元素：页面亮拾取态，用户点选后 resolve 元素载荷（侧边栏上下文调用，用户显式动作）。
 * 用户取消（Esc / 右键）返回 null（静默，不是错误）；超时 / 注入失败抛错（文案用户可读）。
 */
export async function pickElement(): Promise<ElementPickContext | null> {
  ensureAvailable()
  const p = executePicker<ElementPickContext>('pick', await getTargetTabId())
  return withTimeout(p, PICK_TIMEOUT_MS, '拾取已取消：60 秒内未完成点选（页面可能已关闭或刷新）')
}

/**
 * 页面快照：静默抓渲染后 outerHTML（拾取器内截断 ~32KB），不亮任何 UI。
 * 调用方 = SW 的 chat:pageSnapshot 命令（AI 的 page_snapshot 工具触发）；
 * tabId 由 SW 定位（lastFocusedWindow 活动标签），本函数只管注入与取载荷。
 */
export async function capturePageSnapshotFromTab(tabId: number): Promise<PageSnapshotContext> {
  ensureAvailable()
  const ctx = await withTimeout(
    executePicker<PageSnapshotContext>('snapshot', tabId),
    PICK_TIMEOUT_MS,
    '页面快照采集失败：60 秒内未完成（页面可能已关闭或刷新）',
  )
  if (!ctx) throw new Error('页面快照采集失败：注入脚本未返回数据')
  return ctx
}
