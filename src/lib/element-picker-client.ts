// 元素拾取 / 页面快照的**发起侧**封装（对话界面与 SW 两个上下文共用）。
//
// 两条支路的执行通道不同，别混：
//   · 拾取（用户点按钮发起）—— 请 SW 向那一页的常驻件下发指令，件执行后把载荷上报回来
//     （件源码、下发与配对见 userscripts/picker-host.ts、userscripts/picker-bridge.ts）。
//     走常驻的理由：拾取发生在「页面早已打开、用户刚点按钮」，注册件只在页面开始加载时注入，
//     两者差的正是这个时间点；而结果只能靠消息上行（注册件没有返回值通道）。
//   · 快照 / 环境读数（AI 在生成中途发起）—— 仍走 chrome.userScripts.execute() 按需注入
//     （src/public/duoling-picker.js，独立世界 us-builtin-picker）。
//
// 目标页的选法两边不同、且刻意不同：拾取 = 用户此刻看着的那一页（SW 取激活页，判据见
// picker-bridge 的调用处）；快照 = 按**会话归属**反查（见 background.ts 的 resolveAiTargetTab）
// —— AI 决定要读时用户完全可能已经切走，取激活页会把别人那一页的数据喂给模型。
//
// 失败语义（都有明确文案，不静默）：
//   · chrome.userScripts 不可用 —— 138+ 逐扩展「允许运行用户脚本」开关未开 /
//     开发者模式未开，给引导文案（探针实测：开关关闭时该命名空间在所有上下文都不存在）；
//   · 内置页（chrome:// 等）与扩展页（chrome-extension://）不可注入；
//   · 快照：页面关闭 / 导航 → 60 秒超时兜底。

import { EXTENSION_NAME } from '@/lib/extension-identity'
import { runtimeSend } from '@/shared/runtime-send'
import type { ElementPickContext, PageEnvContext, PageSnapshotContext } from '@/shared/extension-ipc'
// 拾取器的世界与文件名归件那侧持有（注册与注入按同一份常量走）：本文件只为快照 / 环境读数的
// execute 注入 import 它们，不在两处各写一份
import { PICKER_FILE, PICKER_HOST_WORLD_ID } from '@/lib/userscripts/picker-host'

/** 快照 / 环境读数的超时：注入期间用户关页 / 导航会让 Promise 永不结算，兜底视为失败 */
const PICK_TIMEOUT_MS = 60_000

/** chrome.userScripts（含 execute）是否可用；不可用 = 138+ 逐扩展开关未开或开发者模式未开 */
export function isUserScriptsApiAvailable(): boolean {
  return typeof chrome.userScripts !== 'undefined' && typeof chrome.userScripts.execute === 'function'
}

/** 不可用时的引导文案（给用户行动指引，不裸抛 API 名）。
 *  分步说明（按浏览器 / 版本分支）与「打开扩展管理页」按钮统一在工作台「引导」标签页，
 *  见 lib/extension-page.ts 的 userScriptsGuideSteps；此处只指路，不复述步骤。 */
export function userScriptsUnavailableMessage(): string {
  return '拾取器不可用：需要先开启「允许运行用户脚本」权限（工作台「引导」标签页有开启步骤），开启后重试。'
}

function ensureAvailable(): void {
  if (!isUserScriptsApiAvailable()) throw new Error(userScriptsUnavailableMessage())
}

/**
 * 页面不可注入的原因（null = 可注入）；调用方自行接「无法…」的后半句。
 *
 * 判据来自 Chrome 注入失败的原话：`Cannot access contents of url "…". Extension manifest must
 * request permission to access this host.` —— 能触发它的页面有两类：
 *   · 浏览器内置页（chrome:// / about: 等）：任何扩展都进不去；
 *   · 扩展页（chrome-extension://）：**连本扩展自己的页面也不行** —— host_permissions 里的
 *     `<all_urls>` 不覆盖 chrome-extension 这个 scheme。
 *     （真机复现：活动标签是工作台时点「点选元素」，对话界面就显示那句英文原话。）
 *
 * 在前置判据里拦住，比让 Chrome 把英文报错漏给用户好；而且这两类页面本来也不该被拾取。
 */
export function pageInjectionBlockReason(url: string | undefined): string | null {
  if (!url) return null
  if (/^chrome-extension:|^moz-extension:/i.test(url)) {
    // 本扩展自己的页面单独说清——否则用户只会觉得「莫名其妙，我啥也没干」
    const ownPrefix =
      typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('') : ''
    return ownPrefix && url.startsWith(ownPrefix)
      ? `当前标签页是${EXTENSION_NAME}自己的页面（工作台等）`
      : '当前标签页是其他扩展的页面'
  }
  if (/^(chrome|edge|about|devtools|view-source):/i.test(url)) {
    return '当前标签页是浏览器内置页面（chrome:// 等）'
  }
  return null
}

/**
 * 注入失败的错误归一化：Chrome 的英文原话换成用户可读文案，其余原样上抛。
 * 覆盖前置判据拦不住的漏网情形（典型：file:// 页面未开「允许访问文件网址」，报的是同一句）。
 * 导出便于单测（同 withTimeout）。
 */
export function friendlyInjectError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e)
  if (/must request permission to access this host|Cannot access contents of url/i.test(raw)) {
    return new Error(
      `当前页面不支持${EXTENSION_NAME}（浏览器内置页 / 扩展页，或未开启「允许访问文件网址」），请切到普通网页后重试`
    )
  }
  return e instanceof Error ? e : new Error(raw)
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

/** chrome.userScripts.execute 的薄封装：注入失败时把 Chrome 的英文原话归一成用户可读文案 */
async function executeInPickerWorld<T>(mode: 'snapshot' | 'env', tabId: number) {
  try {
    return await chrome.userScripts.execute<T>({
      target: { tabId },
      worldId: PICKER_HOST_WORLD_ID,
      js: [{ file: PICKER_FILE }, { code: `__duolingPicker(${JSON.stringify(mode)})` }],
    })
  } catch (e) {
    throw friendlyInjectError(e)
  }
}

/** 注入并执行拾取器（js 数组顺序执行，返回值取最后一段 code 的补全值——即运行器返回的 Promise） */
async function executePicker<T>(mode: 'snapshot' | 'env', tabId: number): Promise<T | null> {
  const results = await executeInPickerWorld<T>(mode, tabId)
  // execute 返回数组按注入目标各一项（我们只注入单个 tab），result 为注入脚本 Promise 的结算值
  const first = results[0]
  return (first?.result ?? null) as T | null
}

/**
 * 点选元素：请 SW 向那一页的常驻件下发指令，用户点选后返回元素载荷（对话界面调用，用户显式动作）。
 * 用户取消（右键 / 对话界面 Esc / 页面 Esc）返回 null（静默，不是错误）；超时 / 件不在位抛错。
 *
 * 可用性前置判断留在发起侧：开关没开时该命名空间在所有上下文都不存在，没必要白跑一趟 IPC。
 */
export async function pickElement(): Promise<ElementPickContext | null> {
  ensureAvailable()
  return runtimeSend<ElementPickContext | null>({ kind: 'picker:pick' })
}

/**
 * 取消进行中的拾取（对话界面 Esc 触发）。
 *
 * 为什么不能只靠页面里的 Esc 监听：拾取期间键盘焦点在对话界面（发起按钮所在文档），
 * keydown 不会到达页面 document——除非先点页面，而点击会被拾取拦截成「选中」。
 * 所以取消的主路径在发起侧，且走与「开始」同一根线（SW 下发收工指令，见 picker-bridge）：
 * 件内的世界全局 `__duolingPickerActive` 收掉拾取，那条 pick 的 Promise resolve null，
 * 正在等待的 pickElement() 随之以「用户取消」收场。
 */
export async function cancelPick(): Promise<void> {
  // 失败静默：没有进行中的拾取时本就没有可取消的东西，报错只会给用户一个无从处理的提示
  await runtimeSend<null>({ kind: 'picker:cancel' }).catch(() => {})
}

/**
 * 页面快照：静默抓渲染后 outerHTML（拾取器内截断 ~32KB），不亮任何 UI。
 * 调用方 = SW 的 'page:snapshot' 命令（AI 的 page_snapshot 工具触发）；
 * tabId 由调用方定位（SW 侧按会话归属反查，兜底最后聚焦窗口的激活页），本函数只管注入与取载荷。
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

/**
 * 页面环境读数：静默读视口尺寸 / 设备像素比 / 页面里读到的 UA，不亮任何 UI。
 * 调用方 = SW 的 'page:env' 命令（AI 的 page_env_read 工具触发）；
 * tabId 由调用方定位（口径与快照一致：SW 侧按会话归属反查），本函数只管注入与取载荷。
 */
export async function capturePageEnvFromTab(tabId: number): Promise<PageEnvContext> {
  ensureAvailable()
  const ctx = await withTimeout(
    executePicker<PageEnvContext>('env', tabId),
    PICK_TIMEOUT_MS,
    '页面环境读取失败：60 秒内未完成（页面可能已关闭或刷新）',
  )
  if (!ctx) throw new Error('页面环境读取失败：注入脚本未返回数据')
  return ctx
}
