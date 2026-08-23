import { describe, expect, it } from 'vitest'
import { buildCoverage, extractCapabilities, parseGeneratedTool } from './tool-generator'
import type { CapabilityItem } from './capability-runner'

const ALL_CAPS = [
  {
    id: 'docs.markdown.render',
    name: 'Markdown 渲染',
    description: '将 Markdown 字符串渲染为 HTML 预览',
    inputSchema: {
      type: 'object',
      description: '渲染参数',
      fields: { markdown: { type: 'markdown', description: 'Markdown 原文' } }
    },
    outputSchema: {
      type: 'object',
      description: '渲染结果',
      fields: { html: { type: 'string', description: 'HTML 预览' } }
    },
    sideEffect: 'read',
    runtime: 'frontend',
    cost: 'offline',
    scenario: { keywords: [], object: 'Markdown 文档' }
  },
  {
    id: 'local.file.read',
    name: '本地文件读取',
    description: '读取指定路径的本地文件内容',
    inputSchema: {
      type: 'object',
      description: '读取参数',
      fields: { path: { type: 'string', description: '文件绝对路径' } }
    },
    outputSchema: {
      type: 'object',
      description: '读取结果',
      fields: { content: { type: 'string', description: '文件文本内容' } }
    },
    sideEffect: 'read',
    runtime: 'backend',
    cost: 'offline',
    scenario: { keywords: [], object: '本地文件' }
  }
] as CapabilityItem[]

// 自我包含的完整 HTML 文档（内联 <style>/<script>，用 cap.run 调能力）
const HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><style>body{padding:16px}</style></head>
<body>
<textarea id="path" placeholder="文件绝对路径"></textarea>
<button id="run">渲染预览</button>
<div id="out"></div>
<script>
document.getElementById('run').addEventListener('click', async () => {
  const file = await cap.run('local.file.read', { path: document.getElementById('path').value });
  const res = await cap.run('docs.markdown.render', { markdown: file.content });
  document.getElementById('out').innerHTML = res.html;
});
</script>
</body>
</html>`

const JSON_TOOL = JSON.stringify({
  name: 'md-file-preview',
  title: 'Markdown 文件预览',
  description: '读取本地 Markdown 文件并渲染为 HTML',
  html: HTML
})

describe('parseGeneratedTool（解析 LLM 输出的 JSON 信封，内含 html）', () => {
  it('解析 ```json 代码块中的工具定义', () => {
    const content = ['```json', JSON_TOOL, '```'].join('\n')
    const def = parseGeneratedTool(content)
    expect(def?.name).toBe('md-file-preview')
    expect(def?.title).toBe('Markdown 文件预览')
    expect(def?.description).toBe('读取本地 Markdown 文件并渲染为 HTML')
    expect(def?.html).toContain('<!doctype html>')
    expect(def?.html).toContain("cap.run('local.file.read'")
  })

  it('能直接从纯 JSON（无代码块）解析', () => {
    const def = parseGeneratedTool(JSON_TOOL)
    expect(def?.name).toBe('md-file-preview')
    expect(def?.html).toContain('docs.markdown.render')
  })

  it('缺 html / html 为空 / 非法输入时返回 null', () => {
    expect(parseGeneratedTool('')).toBeNull()
    expect(parseGeneratedTool('我需要先了解你的需求')).toBeNull()
    expect(parseGeneratedTool('{"name":"x","title":"t","description":"d"}')).toBeNull()
    expect(parseGeneratedTool('{"name":"x","title":"t","html":""}')).toBeNull()
    expect(parseGeneratedTool('{bad json')).toBeNull()
  })
})

describe('extractCapabilities（从 html 源码提取能力依赖）', () => {
  it('提取 html 中 cap.run 用到的能力 id', () => {
    expect(extractCapabilities(HTML)).toEqual(['local.file.read', 'docs.markdown.render'])
  })

  it('识别 window.cap.run 前缀', () => {
    const html = '<script>await window.cap.run("local.file.read", {});</script>'
    expect(extractCapabilities(html)).toEqual(['local.file.read'])
  })

  it('无能力调用时返回空数组', () => {
    expect(extractCapabilities('<div>静态页</div>')).toEqual([])
  })
})

describe('buildCoverage（能力覆盖预判）', () => {
  it('全部覆盖时 missing 为空', () => {
    const def = parseGeneratedTool(JSON_TOOL)!
    const report = buildCoverage(def, ALL_CAPS)
    expect(report.covered).toEqual(['local.file.read', 'docs.markdown.render'])
    expect(report.missing).toEqual([])
  })

  it('缺能力时对应 id 进入 missing', () => {
    const def = parseGeneratedTool(
      JSON.stringify({
        ...(JSON.parse(JSON_TOOL) as object),
        html: `<script>
          await cap.run('pdf.merge', {});
          await cap.run('docs.markdown.render', {});
        </script>`
      })
    )!
    const report = buildCoverage(def, ALL_CAPS)
    expect(report.covered).toEqual(['docs.markdown.render'])
    expect(report.missing).toEqual(['pdf.merge'])
  })
})
