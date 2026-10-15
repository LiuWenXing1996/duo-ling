// 帮助正文的 markdown → HTML 渲染（markdown-it，同步、约 40KB）。
//
// 为什么不复用对话消息那条链路（vue-stream-markdown）：那是为 AI 流式输出设计的重型渲染器 ——
// 自带复制 / 下载 / 放大控件与逐块入场动画，还自带一整套 Tailwind 产物样式（含完整 CSS 变量层），
// 静态长文档用它既排版不可控（覆盖等于跟构建产物对抗），首开还要等约 600KB 的 chunk。帮助正文
// 随包发布、形式固定，用轻量解析器 + 一份自己的排版样式更直接。
//
// 代码块高亮用 shiki，取舍与对话侧 code-block 的 utils.ts 一致：动态 import（防止把 shiki
// 钉进首屏静态图）+ JS 正则引擎（扩展页 CSP `script-src 'self'` 不允许 wasm 实例化）。
// highlighter 异步加载而渲染同步 —— 就绪前 fence 走朴素 <pre><code>，就绪后由 HelpBody
// 重渲染补上高亮，正文不为高亮等待。
//
// 排版样式见 src/assets/main.css 的 `.help-prose`（typography 插件的 prose + 项目语义 token）。
import type { BundledLanguage, BundledTheme, HighlighterGeneric } from 'shiki'
import MarkdownIt from 'markdown-it'
import { headingSlug } from './help-sections'

type HelpHighlighter = HighlighterGeneric<BundledLanguage, BundledTheme>

let highlighter: HelpHighlighter | undefined
let highlighterPromise: Promise<HelpHighlighter> | undefined

/** 加载代码高亮器；就绪前 fence 一直输出朴素代码块。幂等：并发调用共享同一次加载 */
export function loadHelpHighlighter(): Promise<HelpHighlighter> {
  highlighterPromise ??= Promise.all([import('shiki'), import('shiki/engine/javascript')])
    .then(([shiki, engineModule]) =>
      shiki.createHighlighter({
        themes: ['github-light', 'github-dark'],
        // 帮助正文目前只有 javascript 围栏；出现新语言的代码块时在这里加
        langs: ['javascript'],
        engine: engineModule.createJavaScriptRegexEngine(),
      }),
    )
    // createHighlighter 返回的是 Promise；必须等实例落定再回填模块变量 ——
    // fence 同步读它，读到一个未落定的 Promise 就会报「getLoadedLanguages is not a function」
    .then((loaded) => {
      highlighter = loaded
      return loaded
    })
  return highlighterPromise
}

const md = new MarkdownIt({
  // 正文里不需要原始 HTML，关掉即不留注入面
  html: false,
  // 裸链接自动成链，正文里写 URL 不必套尖括号
  linkify: true,
})

// 标题注入 id：跳转按 id 找元素，不按标题文本匹配 —— 将来出现同名标题也不会串到第一节
md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
  const inline = tokens[idx + 1]
  const title = (inline?.children ?? []).map((child) => child.content).join('')
  tokens[idx].attrSet('id', headingSlug(title))
  return self.renderToken(tokens, idx, options)
}

// 外链开新标签：工作台本身就是扩展页，同页导航会把整个工作台顶掉
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx].attrSet('target', '_blank')
  tokens[idx].attrSet('rel', 'noreferrer')
  return self.renderToken(tokens, idx, options)
}

// 代码块：highlighter 就绪且语言已加载时走 shiki 双主题（暗色的切换靠 CSS 换 --shiki-dark，
// 见 main.css）；否则朴素 <pre><code>，正文先出、高亮后补
md.renderer.rules.fence = (tokens, idx, _options, _env, _self) => {
  const token = tokens[idx]
  const lang = token.info.trim().split(/\s+/)[0] ?? ''
  const code = token.content
  if (highlighter && lang && highlighter.getLoadedLanguages().includes(lang as BundledLanguage)) {
    try {
      return highlighter.codeToHtml(code, {
        lang: lang as BundledLanguage,
        themes: { light: 'github-light', dark: 'github-dark' },
      })
    } catch {
      // 高亮失败退回朴素渲染，别让整篇正文跟着崩
    }
  }
  return `<pre><code class="language-${md.utils.escapeHtml(lang)}">${md.utils.escapeHtml(code)}</code></pre>`
}

/** 渲染帮助正文（内容随包发布，非用户输入；原始 HTML 已在解析层禁用） */
export function renderHelpMarkdown(source: string): string {
  return md.render(source)
}
