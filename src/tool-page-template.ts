// 工具页模板。
//
// 桌面版：工具目录里的 index.html 由 webview 经 `tool://` 协议加载，子资源（./js/main.js、./css/style.css）
// 由该协议按目录解析，CSP 由响应头下发（script-src 'self' 'unsafe-inline'）。
// 扩展版：srcdoc + sandbox iframe 承载，页面没有真实文件 URL，因此有两处已知差异：
//   1. 桥接脚本必须外置同源文件（`/tool-bridge.js`）—— srcdoc 内的内联 <script> 会被扩展 CSP 拦掉；
//   2. 子资源相对路径（./js/…）暂无协议可解析，属待办（见 README「工具页承载」）。
//      脚手架仍按桌面版的目录骨架落盘，供代码浏览与后续接入。
export function newToolScaffoldHtml(title: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
</head>
<body style="font-family:sans-serif;padding:16px;margin:0">
  <h1 style="font-size:16px;margin:0 0 8px">${title}</h1>
  <p style="color:#888;font-size:13px;margin:0">跟 AI 对话即可开始修改工具。</p>
  <script src="/tool-bridge.js"></script>
</body>
</html>
`
}

/** 工具入口脚本骨架：可继续拆分子模块（import './lib/util.js' 等） */
const SCAFFOLD_MAIN_JS = `// 工具入口脚本：可继续拆分子模块（import './lib/util.js' 等）
`

/** 工具样式文件骨架：只放一句注释，不预置演示样式，避免误导生成端 */
const SCAFFOLD_STYLE_CSS = `/* 工具样式写在这个文件里，入口页已通过 <link> 引用。 */
`

/** 工具档案初稿骨架：三段式占位（对齐 docs/tool-spec.md §8.2），留待 AI 首次实质改动时补写 */
const SCAFFOLD_ARCHIVE_MD = `## 定位
（待填：这个工具是做什么的，帮用户解决什么。）

## 关键决策
（待填：为什么这么设计，关键取舍与技术选型的缘由。）

## 已知限制
（待填：目前做不到什么、有什么已知问题。）
`

/** 新建工具的目录骨架文件集合（不含 meta.json，由 createTool 统一落盘） */
export function scaffoldFiles(title: string): { rel: string; content: string }[] {
  return [
    { rel: 'index.html', content: newToolScaffoldHtml(title) },
    { rel: 'js/main.js', content: SCAFFOLD_MAIN_JS },
    { rel: 'css/style.css', content: SCAFFOLD_STYLE_CSS },
    { rel: 'archive.md', content: SCAFFOLD_ARCHIVE_MD },
  ]
}

/** 一期示例工具（markdown 渲染）的页面：桥接脚本里带该示例的交互，用于验证「运行 → 提交 → 回滚」闭环 */
export function toolPageHtml(toolId: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"></head>
<body data-tool-id="${toolId}" style="font-family:sans-serif;padding:8px;margin:0;box-sizing:border-box">
  <textarea id="md" rows="5" style="width:100%;box-sizing:border-box" placeholder="输入 markdown..."></textarea>
  <button id="run">渲染并提交</button>
  <div id="out" style="margin-top:8px;border-top:1px solid #888;padding-top:8px"></div>
  <script src="/tool-bridge.js"></script>
</body>
</html>`
}
