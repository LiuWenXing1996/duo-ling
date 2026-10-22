// offscreen document 的 SW 侧容器管理（ensure / close）。
//
// 归属：本文件是**全仓唯一**碰 chrome.offscreen 的模块（offscreen 自己不能创建自己），

//
// 触发点：offscreen 需「随时可用」，故在以下时机均确保容器在场（ensureOffscreen 幂等，重复调用无副作用）：
//   1. SW 模块冷启动（background.ts 顶层 void ensureOffscreen()）
//   2. chrome.runtime.onInstalled（安装 / 更新）
//   3. chrome.runtime.onStartup（浏览器启动）

//
// 说明：Chrome 不会自动启动 offscreen，必须显式 createDocument。策略是常驻：offscreen 不自关，
// 仅在 `offscreen:close` 调试命令下主动关。
// offscreen 容器的 reason 集：与 GM 运行时、对话链路实际用到的能力同源收敛
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
    justification:
      '运行 AI 生成脚本的编排循环、在 offscreen 内写剪贴板；需在扩展页面关闭后继续执行。',
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

export async function isOffscreenReady(): Promise<boolean> {
  return hasOffscreen()
}
