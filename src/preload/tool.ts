// 工具页（WebContentsView）独立 preload：只暴露 window.cap.run。
//
// 工具页是独立的 webContents（独立 preload / 独立 CSP），与主窗口渲染层完全隔离。
// 工具页里 AI 生成的 Options API 通过 cap.run('能力id', 参数) 调用原子能力，
// 这里把它桥接到主进程 capability:run（backend 走 utilityProcess，frontend 走主进程本地实现）。

import { contextBridge, ipcRenderer } from 'electron'

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
