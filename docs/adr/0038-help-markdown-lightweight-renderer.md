# 0038. 帮助正文用轻量渲染器，不复用对话流式渲染器

日期: 2026-10-18
状态: 已接受
代码落点: packages/workbench/src/lib/help/help-markdown.ts（文件头指针指回本文件）

## 背景

帮助正文是随包发布、形式固定的静态长文档；对话消息那条渲染链路（vue-stream-markdown）是为 AI 流式输出设计的重型渲染器。

## 决策

- 帮助正文用 markdown-it（同步、约 40KB）+ 一份自己的排版样式（`.help-prose`，见 src/assets/main.css）。

## 备选与否决

- **复用 vue-stream-markdown**：自带复制 / 下载 / 放大控件与逐块入场动画，还自带一整套 Tailwind 产物样式（含完整 CSS 变量层）——静态长文档用它既排版不可控（覆盖等于跟构建产物对抗），首开还要等约 600KB 的 chunk。

## 细节（与对话侧同款取舍）

- 代码块高亮用 shiki：动态 import（防止把 shiki 钉进首屏静态图）+ JS 正则引擎（扩展页 CSP `script-src 'self'` 不允许 wasm 实例化）。
- highlighter 异步加载而渲染同步——就绪前 fence 走朴素 `<pre><code>`，就绪后由 HelpBody 重渲染补上高亮，正文不为高亮等待。
