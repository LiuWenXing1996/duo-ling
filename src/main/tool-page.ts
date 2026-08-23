// 主进程侧：把「AI 生成的完整 HTML」保存为工具页的 index.html。
//
// 新架构「工具 = 一份可打开的完整 HTML」：AI 产出自我包含的 HTML 文档（内联 <style>/<script>），
// 宿主直接落盘到 <userData>/tools/<id>/index.html，再由独立 WebContentsView 加载（tool:// 协议）。
// 页面交互用原生 JS 调用 window.cap.run（来自工具页 preload）执行原子能力；全程零模板编译、零 eval。

import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 工具页面目录根：<userData>/tools/<id>/… */
export function toolsRoot(): string {
  return join(app.getPath('userData'), 'tools')
}

export interface ToolPageInput {
  /** kebab-case 工具 id（也是 tool:// 协议的 host） */
  name: string
  title: string
  description: string
  /** AI 生成的、自我包含的完整 HTML 文档源码 */
  html: string
}

/** 把 AI 生成的完整 HTML 保存为工具页 index.html，返回 tool:// URL。 */
export function writeToolPage(input: ToolPageInput): { url: string } {
  const dir = join(toolsRoot(), input.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), input.html, 'utf8')
  return { url: `tool://${input.name}/index.html` }
}
