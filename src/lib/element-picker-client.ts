// 拾取 / 页面读数的**发起侧**封装（对话界面与 SW 两个上下文共用）。
//
// 三条支路走同一条通道：请 SW 向那一页的常驻件下发指令，件执行后把载荷上报回来
// （件源码、下发与配对见 userscripts/page-inspector-host.ts、userscripts/page-inspector-bridge.ts）。
// 走常驻的理由：指令的时刻是「页面早已打开」，而注册件只在页面开始加载时注入，两者差的正是
// 这个时间点；而结果只能靠消息上行（注册件没有返回值通道）。
//
// 目标页的选法两边不同、且刻意不同：拾取 = 用户此刻看着的那一页（SW 取激活页，判据见
// page-inspector-bridge 的调用处）；快照 / 环境读数 = 按**会话归属**反查（见 background.ts 的
// resolveAiTargetTab）—— AI 决定要读时用户完全可能已经切走，取激活页会把别人那一页的数据
// 喂给模型。
//
// 失败语义（都有明确文案，不静默）：
//   · chrome.userScripts 不可用 —— 138+ 逐扩展「允许运行用户脚本」开关未开 /
//     开发者模式未开，给引导文案（探针实测：开关关闭时该命名空间在所有上下文都不存在）；
//   · 内置页（chrome:// 等）与扩展页（chrome-extension://）不可注入；
//   · 件不在位 / 页面关掉 / 导航 → 由 bridge 那一层即时失败或超时兜底。

import { EXTENSION_NAME } from '@/lib/extension-identity'
import { runtimeSend } from '@/shared/runtime-send'
import type { ElementPickContext, PageEnvContext, PageSnapshotContext } from '@/shared/extension-ipc'
import { runInspectorCommand } from '@/lib/userscripts/page-inspector-bridge'

/** chrome.userScripts（含 register）是否可用；不可用 = 138+ 逐扩展开关未开或开发者模式未开 */
export function isUserScriptsApiAvailable(): boolean {
  return (
    typeof chrome.userScripts !== 'undefined' && typeof chrome.userScripts.register === 'function'
  )
}

/** 不可用时的引导文案（给用户行动指引，不裸抛 API 名）。
 *  分步说明（按浏览器 / 版本分支）与「打开扩展管理页」按钮统一在工作台「引导」标签页，
 *  见 lib/extension-page.ts 的 userScriptsGuideSteps；此处只指路，不复述步骤。 */
export function userScriptsUnavailableMessage(): string {
  return '拾取元素 / 读快照 / 读环境不可用：需要开启「允许运行用户脚本」'
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
 * 在前置判据里拦住，比让 Chrome 把英文报错漏给用户好；而且这两类页面本来也不该被读取。
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
 * 所以取消的主路径在发起侧，且走与「开始」同一根线（SW 下发收工指令，见 page-inspector-bridge）：
 * 件内的世界全局 `__duolingPickerActive` 收掉拾取，那条 pick 的 Promise resolve null，
 * 正在等待的 pickElement() 随之以「用户取消」收场。
 */
export async function cancelPick(): Promise<void> {
  // 失败静默：没有进行中的拾取时本就没有可取消的东西，报错只会给用户一个无从处理的提示
  await runtimeSend<null>({ kind: 'picker:cancel' }).catch(() => {})
}

/**
 * 页面快照：静默抓渲染后 outerHTML（件内截断 ~32KB），不亮任何 UI。
 * 调用方 = SW 的 'page:snapshot' 命令（AI 的 page_snapshot 工具触发）；
 * tabId 由调用方定位（SW 侧按会话归属反查，兜底最后聚焦窗口的激活页），本函数只管下发与取载荷。
 */
export async function capturePageSnapshotFromTab(tabId: number): Promise<PageSnapshotContext> {
  ensureAvailable()
  const ctx = await runInspectorCommand<PageSnapshotContext>(tabId, 'snapshot')
  if (!ctx) throw new Error('页面快照采集失败：件未返回数据')
  return ctx
}

/**
 * 页面环境读数：静默读视口尺寸 / 设备像素比 / 页面里读到的 UA，不亮任何 UI。
 * 调用方 = SW 的 'page:env' 命令（AI 的 page_env_read 工具触发）；
 * tabId 由调用方定位（口径与快照一致：SW 侧按会话归属反查），本函数只管下发与取载荷。
 */
export async function capturePageEnvFromTab(tabId: number): Promise<PageEnvContext> {
  ensureAvailable()
  const ctx = await runInspectorCommand<PageEnvContext>(tabId, 'env')
  if (!ctx) throw new Error('页面环境读取失败：件未返回数据')
  return ctx
}
