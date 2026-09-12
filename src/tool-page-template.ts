// 工具页模板：桌面版是工具目录里的 index.html，由 webview 加载 tool:// 协议 URL；
// 插件版没有真实文件 URL，改为把 HTML 存进 lightning-fs，再由 side panel 以 srcdoc 注入 sandbox iframe。
// 桥接逻辑对应桌面版 preload 注入的 window.cap（preload/tool.ts）。
// 桥接脚本抽成外部同源文件（public/tool-bridge.js），避免 srcdoc 内联 <script> 被扩展 CSP 的
// 'unsafe-inline' 拦截。toolId 经 <body data-tool-id> 传递（HTML 属性，不受 CSP 限制）。
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
