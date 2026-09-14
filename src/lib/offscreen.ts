// offscreen document 的 SW 侧容器管理（ensure / close）。
//
// 模块归属（§4.8 模块归属规则）：本文件用 chrome.offscreen，属 **SW 专属** ——
// 只允许被 src/entrypoints/background.ts 侧 import。offscreen 自己不能创建自己。
//
// 触发点（§4.8 新增机制 1）：**「收到生成请求」那一刻**才是唯一必然发生的时机 ——
// Chrome 不会自动启动 offscreen，安装 / 启动时 SW 也未必有机会跑。用户在生成入口点下去时
// ensure，容器一定在；onStartup / onInstalled 只是补挂。**刻意不在 SW 启动时自动创建** ——
// 那会让容器一启动就常驻，与既定退出条件（任务结束 + 侧边栏关闭 + 空闲 N 分钟自关，
// 方案 §6.2 #12）相悖。

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

/** 关闭 offscreen document（幂等）。退出条件见方案 §6.2 #12 */
export async function closeOffscreen(): Promise<void> {
  if (!(await hasOffscreen())) return
  await chrome.offscreen.closeDocument()
}

/** 容器当前是否存在（供 UI / 调试查询） */
export async function isOffscreenReady(): Promise<boolean> {
  return hasOffscreen()
}
