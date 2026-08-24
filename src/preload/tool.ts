/// <reference lib="dom" />
// <webview> 承载的工具页（guest）独立 preload：暴露 window.cap.run 并向上报活。
//
// 工具页是独立的 webContents（独立 preload / 独立 CSP），与主窗口渲染层完全隔离。
// 工具页里 AI 生成的页面逻辑通过 cap.run('能力id', 参数) 调用原子能力，
// 这里把它桥接到主进程 capability:run（backend 走 utilityProcess，frontend 走主进程本地实现）。
// 另通过 sendToHost 周期报活，供宿主（主窗口渲染层在 <webview> 的 ipc-message 事件里）检测死循环/无响应。

import { contextBridge, ipcRenderer } from 'electron'

/** 心跳令牌：宿主（tool-page.vue）据它在 ipc-message 事件里识别报活消息 */
const HEARTBEAT_TOKEN = '__duo_ling_heartbeat__'

const cap = {
  run: (
    id: string,
    args: unknown
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> =>
    ipcRenderer.invoke('capability:run', id, args)
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('cap', cap)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.cap = cap
}

// 每 2s 向宿主报活：工具页若陷入死循环，事件循环被饿死、心跳停止，宿主据此判定卡死
function beat(): void {
  try {
    ipcRenderer.sendToHost(HEARTBEAT_TOKEN)
  } catch (error) {
    console.error(error)
  }
}
beat()
setInterval(beat, 2000)

// —— 统一滚动条宽度 ——
// 工具页是独立文档，宿主 main.css 的 ::-webkit-scrollbar 不会作用到这里，
// 导致 webview 使用默认 ~15px 系统滚动条，与宿主左/中栏的 6px 细滚动条宽度不一致。
// 这里注入与宿主一致的 6px 细滚动条，保证三栏滚动条外观统一（每次加载都会执行，贴合宿主主题色）。
const SCROLLBAR_CSS = `
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: oklch(0.556 0 0); border-radius: 9999px; }
  ::-webkit-scrollbar-thumb:hover { background: oklch(0.145 0 0); }
`

function ensureScrollbarStyle(): void {
  if (!document.getElementById('__duo_ling_scrollbar__')) {
    const style = document.createElement('style')
    style.id = '__duo_ling_scrollbar__'
    style.textContent = SCROLLBAR_CSS
    ;(document.head || document.documentElement)?.appendChild(style)
  }
}

// preload 在 DOM 解析前运行，head 尚未生成；等 DOMContentLoaded 后再挂（若已就绪则立即挂）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ensureScrollbarStyle)
} else {
  ensureScrollbarStyle()
}
