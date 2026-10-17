// offscreen document 的 SW 侧容器管理（ensure / close）。
//
// 归属：本文件是**全仓唯一**碰 chrome.offscreen 的模块（offscreen 自己不能创建自己），
// 由 SW 入口（src/entrypoints/background.ts）使用。
//
// 触发点：offscreen 需「随时可用」，故在以下时机均确保容器在场（ensureOffscreen 幂等，重复调用无副作用）：
//   1. SW 模块冷启动（background.ts 顶层 void ensureOffscreen()）
//   2. chrome.runtime.onInstalled（安装 / 更新）
//   3. chrome.runtime.onStartup（浏览器启动）
// 另：AI 生成入口与 offscreenService 在发起请求前也会先 ensure，作为兜底。
//
// 说明：Chrome 不会自动启动 offscreen，必须显式 createDocument。策略是常驻：offscreen 不自关，
// 仅在 `offscreen:close` 调试命令下主动关。
// offscreen 容器的 reason 集：与 GM 运行时、对话链路实际用到的能力同源收敛
import { sendRuntime } from '@duoling/shared'
import { GM_OFFSCREEN_REASONS } from './offscreen-reasons'

/** 与 src/entrypoints/offscreen.html 对应 */
const OFFSCREEN_PATH = 'offscreen.html'

/** 在途创建 promise：并发调用共享同一次创建，避免产生多份（官方示例的 creating 写法） */
let creating: Promise<void> | null = null

/** 容器是否已存在（每扩展同时只能有一份，故按 contextType 判定即可） */
async function hasOffscreen(): Promise<boolean> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  })
  return contexts.length > 0
}

/**
 * 确保 offscreen document 已就绪（幂等；并发调用共享同一在途 promise）。
 *
 * reasons 取包内 offscreen-reasons.ts 的 GM_OFFSCREEN_REASONS（BLOBS + WORKERS + CLIPBOARD，
 * 三项都不带自动关闭，故容器可长活）—— 逐项含义见该文件的文件头。
 */
export async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return
  if (creating) {
    await creating
    return
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: GM_OFFSCREEN_REASONS,
    justification: '运行 AI 生成脚本的编排循环、在 offscreen 内写剪贴板；需在扩展页面关闭后继续执行。',
  })
  try {
    await creating
  } finally {
    creating = null
  }
}

/** 关闭 offscreen document（幂等）。注意：常驻策略下一般不应主动调用；仅供调试（offscreen:close）使用 */
export async function closeOffscreen(): Promise<void> {
  if (!(await hasOffscreen())) return
  await chrome.offscreen.closeDocument()
}

/** 容器当前是否存在（供 UI / 调试查询） */
export async function isOffscreenReady(): Promise<boolean> {
  return hasOffscreen()
}

/** 单次探测的回调超时（ms）；超时即判未就绪，交给外层轮询重试 */
const PING_TIMEOUT_MS = 1000

/** 轮询间隔（ms） */
const PING_INTERVAL_MS = 50

/**
 * 探测容器**是否真在应答**（不只是「文档存在」）。
 *
 * `createDocument` resolve 只说明文档建好了，其 onMessage 未必注册完——此时发业务命令会得到
 * 「The message port closed before a response was received」。故就绪判据必须是「能应答一条消息」。
 * 用 `fs:ping`（不触碰文件系统），由 offscreen 侧的就绪 matcher 应答。
 */
function pingOffscreen(): Promise<boolean> {
  // 超时兜底：应答方永不回调（容器刚被销毁）时不把 promise 挂死。
  // 不区分失败原因：无响应本身就判未就绪。
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), PING_TIMEOUT_MS)
    sendRuntime({ kind: 'fs:ping' }).then(
      () => {
        clearTimeout(timer)
        resolve(true)
      },
      () => {
        clearTimeout(timer)
        resolve(false)
      },
    )
  })
}

/**
 * 等容器进入「可应答」状态（轮询 fs:ping，默认最多 2s）。
 *
 * 常见路径几乎不等待：容器已在时第一次 ping 即成功。只有刚创建 / 刚重载才会轮询几轮。
 * 返回 false 表示超时仍未就绪——调用方可据此重试或降级，**不要**再退回到固定 sleep 猜时间。
 */
export async function waitForOffscreenReady(timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await pingOffscreen()) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, PING_INTERVAL_MS))
  }
}

/**
 * 确保容器在场**且可应答**（= ensureOffscreen + waitForOffscreenReady）。
 * 单次写操作前应调这个；只在后台预热（SW 启动 / onStartup / onInstalled）时用 ensureOffscreen 即可，
 * 那里不需要立刻用容器，不该为了握手多等。
 */
export async function ensureOffscreenReady(timeoutMs = 2000): Promise<boolean> {
  try {
    await ensureOffscreen()
  } catch {
    // 创建失败（极少）：继续走一次探测，容器可能本就在（如并发创建），让判据统一
  }
  return waitForOffscreenReady(timeoutMs)
}
