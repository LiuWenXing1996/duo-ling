// 单测：帮助正文渲染（help-markdown）。
//
// 与目录共用 `headingSlug`，这里盯住「渲染出的标题 id = 目录项 id」这对关系：它是跳转能否
// 生效的全部依据，两边各自演化会静默失效（点目录毫无反应，且不报错）。
import { describe, expect, it } from 'vitest'
import { renderHelpMarkdown } from './help-markdown'
import { headingSlug, parseHelpSections } from './help-sections'
import helpContent from './help-content.md?raw'

describe('renderHelpMarkdown', () => {
  it('## / ### 标题带 id，且与目录项 id 一一对应', () => {
    const html = renderHelpMarkdown(helpContent)
    for (const section of parseHelpSections(helpContent)) {
      expect(html, `标题「${section.title}」没渲染出 id=${section.id}`).toContain(
        `<h${section.depth} id="${section.id}">`,
      )
    }
  })

  it('文档大标题不进目录，但同样有 id', () => {
    expect(renderHelpMarkdown('# 标题\n')).toContain(`<h1 id="${headingSlug('标题')}">`)
  })

  it('标题里的行内标记不进入 id', () => {
    expect(renderHelpMarkdown('## 关于 `GM` API\n')).toContain('id="关于-gm-api"')
  })

  it('原始 HTML 被转义（解析层已禁用，不留注入面）', () => {
    const html = renderHelpMarkdown('<script>alert(1)</script>\n')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('外链开新标签，不会把工作台整页顶掉', () => {
    const html = renderHelpMarkdown('[示例](https://example.com)\n')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer"')
  })

  it('正文里的三张配图都渲染出 img，路径指向随包的 /help/ 资源（暗色换图靠 CSS，见 main.css）', () => {
    const html = renderHelpMarkdown(helpContent)
    for (const name of ['workbench', 'floatpanel', 'popup']) {
      expect(html, `配图 ${name} 应以 <img> 形式嵌进正文`).toContain(
        `<img src="/help/${name}.webp"`,
      )
    }
  })
})

describe('fence 代码块（朴素态）', () => {
  // 本文件不调 loadHelpHighlighter，highlighter 保持未就绪，fence 恒走朴素分支 ——
  // 模块级单例意味着「就绪态」用例不能与本文件混写，要另起文件隔离状态。
  it('代码文本转义并带上语言 class', () => {
    const html = renderHelpMarkdown('```js\nconst a = "<b>";\n```\n')
    expect(html).toContain('<pre><code class="language-js">')
    expect(html).toContain('&quot;&lt;b&gt;&quot;')
  })

  it('无语言标注时 language class 为空但不报错', () => {
    expect(renderHelpMarkdown('```\nplain\n```\n')).toContain('<code class="language-">')
  })
})
