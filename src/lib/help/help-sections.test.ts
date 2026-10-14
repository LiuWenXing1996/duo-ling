// 单测：帮助正文的目录派生（help-sections）。纯函数，不挂组件、不碰 DOM。
//
// 重点盯住围栏代码块：正文里有用户脚本示例，将来示例里出现 `#` 开头的行不该混进目录。
import { describe, expect, it } from 'vitest'
import { filterHelpSections, headingSlug, parseHelpSections } from './help-sections'
import helpContent from './help-content.md?raw'

describe('parseHelpSections', () => {
  it('收 ## 与 ###，忽略文档大标题 #', () => {
    expect(parseHelpSections('# 文档标题\n\n## 快速上手\n\n正文\n\n### 小节\n')).toEqual([
      { depth: 2, title: '快速上手', id: '快速上手' },
      { depth: 3, title: '小节', id: '小节' },
    ])
  })

  it('围栏代码块内的 # 不算标题', () => {
    const markdown = [
      '## 真章节',
      '',
      '```js',
      '#!/usr/bin/env node',
      '// # 这也是注释',
      '```',
      '',
      '## 另一章',
    ].join('\n')
    expect(parseHelpSections(markdown).map((s) => s.title)).toEqual(['真章节', '另一章'])
  })

  it('代码块结束后恢复识别（围栏状态是可进可出的）', () => {
    const markdown = '```\n# 块内\n```\n\n## 块外\n'
    expect(parseHelpSections(markdown).map((s) => s.title)).toEqual(['块外'])
  })

  it('行内 # 与四级标题不进目录', () => {
    expect(parseHelpSections('# 一级\n#### 四级\n\n普通文字 # 不在行首\n')).toEqual([])
  })
})

describe('headingSlug', () => {
  it('中文原样保留，空白转连字符', () => {
    expect(headingSlug('工具栏 popup')).toBe('工具栏-popup')
  })

  it('去掉标点与包裹标记，id 可直接进属性选择器', () => {
    expect(headingSlug('「引用」与`代码`、括号（示例）')).toBe('引用与代码括号示例')
  })

  it('标点被删后不留悬空连字符，首尾分隔符不留', () => {
    expect(headingSlug('与 `代码` 并列')).toBe('与-代码-并列')
    expect(headingSlug('（可选）说明：')).toBe('可选说明')
    expect(headingSlug('标题 — 副标题')).toBe('标题-副标题')
  })

  it('大小写归一，字母数字与连字符之外的字符一并去掉', () => {
    expect(headingSlug('GM API 速查 v2')).toBe('gm-api-速查-v2')
  })
})

describe('filterHelpSections', () => {
  const sections = parseHelpSections('## 快速上手\n### 会话归属\n## 用户脚本\n')

  it('关键词为空（或只有空白）时原样返回', () => {
    expect(filterHelpSections(sections, '')).toBe(sections)
    expect(filterHelpSections(sections, '   ')).toBe(sections)
  })

  it('按标题子串过滤，忽略大小写', () => {
    expect(filterHelpSections(sections, '脚本').map((s) => s.title)).toEqual(['用户脚本'])
    expect(filterHelpSections(parseHelpSections('## Working'), 'working')).toHaveLength(1)
  })

  it('没有匹配项时返回空数组', () => {
    expect(filterHelpSections(sections, '不存在的章节')).toEqual([])
  })
})

describe('真实正文', () => {
  it('解析出的目录非空，且首项是「快速上手」', () => {
    const sections = parseHelpSections(helpContent)
    expect(sections.length).toBeGreaterThan(5)
    expect(sections[0]).toEqual({ depth: 2, title: '快速上手', id: '快速上手' })
  })

  it('目录项 id 不重复（重复会让跳转只能命中第一个）', () => {
    const ids = parseHelpSections(helpContent).map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('目录项 id 均非空（标题被 slug 规则吃空，跳转就静默失效）', () => {
    for (const section of parseHelpSections(helpContent)) {
      expect(section.id, `标题「${section.title}」的 id 是空的`).not.toBe('')
    }
  })
})
