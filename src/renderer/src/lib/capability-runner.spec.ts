import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderMarkdown, runCapability } from './capability-runner'

const capabilityListMock = vi.fn()
const capabilityRunMock = vi.fn()

// 能力清单同时含 frontend 与 backend 两类，便于测试 runCapability 的分派逻辑
const ALL_CAPS = [
  {
    id: 'docs.markdown.render',
    name: 'Markdown 渲染',
    description: '将 Markdown 字符串渲染为 HTML 预览',
    inputSchema: { type: 'object', description: '渲染参数' },
    outputSchema: { type: 'object', description: '渲染结果' },
    sideEffect: 'read',
    runtime: 'frontend',
    cost: 'offline',
    scenario: { keywords: [], object: 'Markdown 文档' }
  },
  {
    id: 'local.file.read',
    name: '本地文件读取',
    description: '读取指定路径的本地文件内容',
    inputSchema: { type: 'object', description: '读取参数' },
    outputSchema: { type: 'object', description: '读取结果' },
    sideEffect: 'read',
    runtime: 'backend',
    cost: 'offline',
    scenario: { keywords: [], object: '本地文件' }
  }
] as Awaited<ReturnType<typeof window.api.capability.list>>

beforeEach(() => {
  vi.stubGlobal('window', { api: { capability: { list: capabilityListMock, run: capabilityRunMock } } })
  capabilityListMock.mockResolvedValue(ALL_CAPS)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('renderMarkdown（前端能力 docs.markdown.render）', () => {
  it('渲染标题、段落与行内粗体', () => {
    const html = renderMarkdown('# 标题\n\n一段 **加粗** 文本')
    expect(html).toContain('<h1>标题</h1>')
    expect(html).toContain('<p>一段 <strong>加粗</strong> 文本</p>')
  })

  it('渲染无序列表', () => {
    const html = renderMarkdown('- 甲\n- 乙')
    expect(html).toBe('<ul><li>甲</li><li>乙</li></ul>')
  })

  it('渲染代码块并转义 HTML', () => {
    const html = renderMarkdown('```\n<div>\n```')
    expect(html).toContain('<pre><code>&lt;div&gt;</code></pre>')
  })
})

describe('runCapability（统一调用入口分派）', () => {
  it('frontend 能力走注入方法，不触发 IPC run', async () => {
    const res = await runCapability('docs.markdown.render', { markdown: '# hi' })
    expect(res).toEqual({ ok: true, result: { html: '<h1>hi</h1>' } })
    expect(capabilityRunMock).not.toHaveBeenCalled()
  })

  it('backend 能力走 window.api.capability.run', async () => {
    capabilityRunMock.mockResolvedValue({ ok: true, result: { content: 'hello' } })
    const res = await runCapability('local.file.read', { path: '/tmp/a.txt' })
    expect(res).toEqual({ ok: true, result: { content: 'hello' } })
    expect(capabilityRunMock).toHaveBeenCalledWith('local.file.read', { path: '/tmp/a.txt' })
  })

  it('未知能力返回如实的错误信息', async () => {
    const res = await runCapability('no.such.capability')
    expect(res).toEqual({ ok: false, error: '未知能力: no.such.capability' })
  })
})
