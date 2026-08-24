import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ToolWorkspace from './tool-workspace.vue'

describe('ToolWorkspace', () => {
  beforeEach(() => {
    // 只注入 window.api，保留原生 window，避免破坏 @vue/test-utils 的 DOM 事件机制
    // 新建工具落盘后返回 ID 与标题，由工作台直接打开对应标签页
    Object.defineProperty(window, 'api', {
      value: {
        tool: {
          create: vi.fn().mockResolvedValue({ ok: true, id: 't-init', title: '新建工具' }),
          list: vi.fn().mockResolvedValue([
            { id: 't-1', name: 'pdf-merge', title: 'PDF 合并器', description: '合并多个 PDF' }
          ]),
          update: vi.fn().mockResolvedValue({ ok: true }),
          getPreloadPath: vi.fn().mockResolvedValue('file:///preload/tool.cjs')
        },
        generator: {
          send: vi.fn().mockResolvedValue({ ok: true, content: '{}' }),
          abort: vi.fn().mockResolvedValue(undefined),
          onEvent: vi.fn(),
          offEvent: vi.fn()
        },
        model: {
          list: vi.fn().mockResolvedValue({ profiles: [], activeId: '' }),
          setActive: vi.fn().mockResolvedValue(undefined)
        },
        settings: {
          getSystemPrompt: vi.fn().mockResolvedValue(''),
          setSystemPrompt: vi.fn().mockResolvedValue(undefined),
          getGeneratorApprovalMode: vi.fn().mockResolvedValue('manual'),
          setGeneratorApprovalMode: vi.fn().mockResolvedValue(undefined)
        }
      },
      configurable: true
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as unknown as Record<string, unknown>).api
  })

  it('默认不展示任何演示/占位工具', () => {
    const wrapper = mount(ToolWorkspace)

    // 空工作台提示：指向左侧导航栏「新建工具」
    expect(wrapper.text()).toContain('还没有工具，点击左侧「新建工具」创建')

    // 不再渲染任何演示工具或占位标签
    expect(wrapper.text()).not.toContain('PDF 合并器')
    expect(wrapper.text()).not.toContain('表格清洗')
    expect(wrapper.text()).not.toContain('批量重命名')
    expect(wrapper.text()).not.toContain('Markdown 渲染器')
    expect(wrapper.text()).not.toContain('网页快照')
    expect(wrapper.text()).not.toContain('占位')

    wrapper.unmount()
  })

  it('点击「新建工具」直接创建工具并打开对应标签页', async () => {
    ;(window.api.tool.create as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      id: 't-abc',
      title: '新建工具'
    })
    const wrapper = mount(ToolWorkspace)

    // 顶栏「新建工具」按钮已迁移到根布局侧边栏（App.vue），
    // 这里直接调用组件暴露的方法触发新建。
    await (wrapper.vm as unknown as { createTool: () => Promise<void> }).createTool()
    await flushPromises()
    await wrapper.vm.$nextTick()

    // 调用主进程创建
    expect(window.api.tool.create).toHaveBeenCalledTimes(1)

    // 标签栏出现新工具标签，且被激活，空工作台提示消失
    expect(wrapper.text()).toContain('新建工具')
    expect(wrapper.text()).not.toContain('还没有工具，点击左侧「新建工具」创建')

    // 激活标签渲染三栏工具页：会话历史 / 当前会话 / 工具详情
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('会话历史')
    expect(wrapper.text()).toContain('当前会话')
    expect(wrapper.text()).toContain('工具详情')

    wrapper.unmount()
  })
})
