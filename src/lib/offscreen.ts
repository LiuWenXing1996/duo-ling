// offscreen document 的 SW 侧容器管理（ensure / close）。
//
// 模块归属（§4.8 模块归属规则）：本文件用 chrome.offscreen，属 **SW 专属** ——
// 只允许被 src/entrypoints/background.ts 侧 import。offscreen 自己不能创建自己。
//
// 触发点：offscreen 需「随时可用」，故在以下时机均确保容器在场（ensureOffscreen 幂等，重复调用无副作用）：
//   1. SW 模块冷启动（background.ts 顶层 void ensureOffscreen()）
//   2. chrome.runtime.onInstalled（安装 / 更新）
//   3. chrome.runtime.onStartup（浏览器启动）
// 另：AI 生成入口与 aiFsClient 在发起请求前也会先 ensure，作为兜底。
//
// 说明：Chrome 不会自动启动 offscreen，必须显式 createDocument。早期设计曾「刻意不在启动时创建」、
// 计划配合「空闲 N 分钟自关」（方案 §6.2 #12）做常驻退出；现改为常驻策略（老大 2026-09-14 拍板），
// 原 §6.2 #12 的 idle 自关**已撤销**，offscreen 不再自关，仅在 `offscreen:close` 调试命令下主动关。

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
 * reasons 取 BLOBS + WORKERS：
 *   · BLOBS   —— 拿 URL.createObjectURL（esbuild 默认 worker 模式依赖它，而 SW 里没有）
 *   · WORKERS —— 派生子 worker 跑构建
 * 两者均不带自动关闭（只有 AUDIO_PLAYBACK 有 30s 无声自关），故容器可长活。
 */
export async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return
  if (creating) {
    await creating
    return
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['BLOBS', 'WORKERS'],
    justification: '运行 AI 生成脚本的编排循环与 esbuild 构建；需在扩展页面关闭后继续执行。',
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
