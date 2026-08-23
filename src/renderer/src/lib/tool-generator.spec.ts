import { describe, expect, it } from 'vitest'
import { buildCoverage, extractCapabilities, parseGeneratedTool } from './tool-generator'
import type { CapabilityItem } from './capability-runner'

const ALL_CAPS = [
  {
    id: 'docs.markdown.render',
    name: 'Markdown 渲染',
    description: '将 Markdown 字符串渲染为 HTML 预览',
    inputSchema: { type: 'object', description: '渲染参数', fields: { markdown: { type: 'markdown', description: 'Markdown 原文' } } },
    outputSchema: { type: 'object', description: '渲染结果', fields: { html: { type: 'string', description: 'HTML 预览' } } },
    sideEffect: 'read',
    runtime: 'frontend',
    cost: 'offline',
    scenario: { keywords: [], object: 'Markdown 文档' }
  },
  {
    id: 'local.file.read',
    name: '本地文件读取',
    description: '读取指定路径的本地文件内容',
    inputSchema: { type: 'object', description: '读取参数', fields: { path: { type: 'string', description: '文件绝对路径' } } },
    outputSchema: { type: 'object', description: '读取结果', fields: { content: { type: 'string', description: '文件文本内容' } } },
    sideEffect: 'read',
    runtime: 'backend',
    cost: 'offline',
    scenario: { keywords: [], object: '本地文件' }
  }
] as CapabilityItem[]

const TEMPLATE = `<div class="p-4 space-y-3">
  <input v-model="path" placeholder="文件绝对路径" />
  <button @click="run">渲染预览</button>
  <div v-if="html" v-html="html"></div>
</div>`

const SETUP = `export default function setup() {
  const path = ref('');
  const html = ref('');
  async function run() {
    const file = await cap.run('local.file.read', { path: path.value });
    const rendered = await cap.run('docs.markdown.render', { markdown: file.content });
    html.value = rendered.html;
  }
  return { path, html, run };
}`

const JSON_TOOL = JSON.stringify({
  name: 'md-file-preview',
  title: 'Markdown 文件预览',
  description: '读取本地 Markdown 文件并渲染为 HTML',
  template: TEMPLATE,
  setup: SETUP
})

describe('parseGeneratedTool（解析 LLM 输出的 JSON 信封，内含 template + setup）', () => {
  it('解析 ```json 代码块中的工具定义', () => {
    const content = ['```json', JSON_TOOL, '```'].join('\n')
    const def = parseGeneratedTool(content)
    expect(def?.name).toBe('md-file-preview')
    expect(def?.title).toBe('Markdown 文件预览')
    expect(def?.template).toContain('v-model="path"')
    expect(def?.setup).toContain("cap.run('local.file.read'")
  })

  it('能直接从纯 JSON（无代码块）解析', () => {
    const def = parseGeneratedTool(JSON_TOOL)
    expect(def?.name).toBe('md-file-preview')
    expect(def?.setup).toContain('docs.markdown.render')
  })

  it('缺 template / 缺 setup / 非法输入时返回 null', () => {
    expect(parseGeneratedTool('')).toBeNull()
    expect(parseGeneratedTool('我需要先了解你的需求')).toBeNull()
    expect(parseGeneratedTool('{"name":"x","title":"t"}')).toBeNull()
    expect(parseGeneratedTool('{"name":"x","template":"<div></div>","setup":""}')).toBeNull()
    expect(parseGeneratedTool('{bad json')).toBeNull()
  })
})

describe('extractCapabilities（从组件逻辑提取能力依赖）', () => {
  it('提取 setup 中 cap.run 用到的能力 id', () => {
    expect(extractCapabilities(SETUP)).toEqual(['local.file.read', 'docs.markdown.render'])
  })

  it('无能力调用时返回空数组', () => {
    expect(extractCapabilities('export default function setup() { return { ok: true }; }')).toEqual([])
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
        setup: `export default function setup() {
          await cap.run('pdf.merge', {});
          await cap.run('docs.markdown.render', {});
        }`
      })
    )!
    const report = buildCoverage(def, ALL_CAPS)
    expect(report.covered).toEqual(['docs.markdown.render'])
    expect(report.missing).toEqual(['pdf.merge'])
  })
})
