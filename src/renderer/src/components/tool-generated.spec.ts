import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ToolGenerated from './tool-generated.vue'
import type { GeneratedToolDef } from '@/lib/tool-generator'

/** 与生成器约定的 md-file-preview 完整组件定义：template + setup */
const MD_FILE_DEF: GeneratedToolDef = {
  name: 'md-file-preview',
  title: 'Markdown 文件预览',
  description: '读取本地 Markdown 文件并渲染为 HTML',
  template: `<div class="p-4 space-y-3">
  <input v-model="path" placeholder="文件绝对路径" />
  <button @click="run">渲染预览</button>
  <div v-if="html" class="preview" v-html="html"></div>
  <p v-if="error" class="text-red-500">{{ error }}</p>
</div>`,
  setup: `export default function setup() {
  const path = ref('');
  const html = ref('');
  const error = ref('');
  async function run() {
    error.value = '';
    try {
      const file = await cap.run('local.file.read', { path: path.value });
      const rendered = await cap.run('docs.markdown.render', { markdown: file.content });
      html.value = rendered.html;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  }
  return { path, html, error, run };
}`
}

describe('ToolGenerated（运行时编译 AI 生成的完整组件）', () => {
  beforeEach(() => {
    // 能力清单：docs.markdown.render 走前端注入；local.file.read 走 backend IPC（mock 为本地读取）
    Object.defineProperty(window, 'api', {
      value: {
        capability: {
          list: vi.fn().mockResolvedValue([
            {
              id: 'docs.markdown.render',
              runtime: 'frontend',
              name: 'Markdown 渲染',
              description: '',
              inputSchema: { type: 'object', description: '' },
              outputSchema: { type: 'object', description: '' },
              sideEffect: 'read',
              cost: 'offline',
              scenario: { keywords: [], object: 'Markdown 文档' }
            },
            {
              id: 'local.file.read',
              runtime: 'backend',
              name: '本地文件读取',
              description: '',
              inputSchema: { type: 'object', description: '' },
              outputSchema: { type: 'object', description: '' },
              sideEffect: 'read',
              cost: 'offline',
              scenario: { keywords: [], object: '本地文件' }
            }
          ]),
          // backend 能力经 IPC 返回，这里 mock 出读文件结果
          run: vi.fn().mockResolvedValue({ ok: true, result: { content: '# 你好世界' } })
        }
      },
      configurable: true
    })
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).api
  })

  it('由 AI 生成的 template 编译出组件的输入框与按钮（而非固定外壳）', async () => {
    const wrapper = mount(ToolGenerated, { props: { def: MD_FILE_DEF } })
    await flushPromises()

    // 输入框来自模板里的 v-model="path"，按钮来自 @click="run"
    const input = wrapper.find('input[placeholder="文件绝对路径"]')
    expect(input.exists()).toBe(true)
    const runBtn = wrapper.findAll('button').find((b) => b.text().includes('渲染预览'))
    expect(runBtn).toBeTruthy()

    wrapper.unmount()
  })

  it('点击运行走「backend 读取 → frontend 渲染」链路并展示结果', async () => {
    const wrapper = mount(ToolGenerated, { props: { def: MD_FILE_DEF } })
    await flushPromises()

    const input = wrapper.find('input[placeholder="文件绝对路径"]')
    await input.setValue('/tmp/demo.md')

    const runBtn = wrapper.findAll('button').find((b) => b.text().includes('渲染预览'))
    await runBtn!.trigger('click')
    await flushPromises()

    // 前端 docs.markdown.render 把后端 local.file.read 拿到的 Markdown 渲染为 <h1>
    expect(wrapper.html()).toContain('<h1>你好世界</h1>')

    // 确认 backend 能力确实经过 IPC 被调用（入参为输入框填写的路径）
    expect(window.api.capability.run).toHaveBeenCalledWith('local.file.read', { path: '/tmp/demo.md' })

    wrapper.unmount()
  })
})
