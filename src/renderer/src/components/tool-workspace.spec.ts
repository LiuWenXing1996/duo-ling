import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ToolWorkspace from './tool-workspace.vue'

describe('ToolWorkspace', () => {
  beforeEach(() => {
    // jsdom 未实现 ResizeObserver，注入一个空实现（工具页尺寸同步在真实渲染进程由 WebContentsView 完成）
    vi.stubGlobal('ResizeObserver', class ResizeObserver {
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
    })

    // runCapability 分派依赖能力清单，façade 前端能力走注入方法（无需 IPC run）
    // 只注入 window.api，保留原生 window，避免破坏 @vue/test-utils 的 DOM 事件机制
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
              scenario: { keywords: [], object: 'Markdown' }
            }
          ]),
          run: vi.fn()
        },
        tool: {
          open: vi.fn().mockResolvedValue({ ok: true, error: '' }),
          close: vi.fn().mockResolvedValue({ ok: true, error: '' }),
          setBounds: vi.fn().mockResolvedValue({ ok: true, error: '' })
        }
      },
      configurable: true
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as unknown as Record<string, unknown>).api
  })

  it('渲染顶栏与默认工具页（PDF 合并器）', () => {
    const wrapper = mount(ToolWorkspace)

    // 顶栏：品牌 / 搜索 / 新建工具
    expect(wrapper.text()).toContain('小班')
    expect(wrapper.text()).toContain('新建工具')

    // 标签栏：默认打开的四个工具
    expect(wrapper.text()).toContain('PDF 合并器')
    expect(wrapper.text()).toContain('表格清洗')
    expect(wrapper.text()).toContain('批量重命名')
    expect(wrapper.text()).toContain('Markdown 渲染器')

    // 当前工具页：会话记录 + 对话框 + 会话详情（三栏）
    expect(wrapper.text()).toContain('会话记录')
    expect(wrapper.text()).toContain('对话框')
    expect(wrapper.text()).toContain('会话详情')
    expect(wrapper.text()).toContain('运行')

    wrapper.unmount()
  })

  it('点击标签可切换到对应工具页', async () => {
    const wrapper = mount(ToolWorkspace)

    const cleanTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text().includes('表格清洗'))
    expect(cleanTab).toBeTruthy()
    await cleanTab!.trigger('click')

    // 切换到表格清洗后，显示其专属内容
    expect(wrapper.text()).toContain('去重 23 行')

    wrapper.unmount()
  })

  it('Markdown 渲染器可直接运行并真实输出 HTML 预览', async () => {
    const wrapper = mount(ToolWorkspace)

    // 切到 Markdown 渲染器标签
    const mdTab = wrapper.findAll('[role="tab"]').find((tab) => tab.text().includes('Markdown 渲染器'))
    expect(mdTab).toBeTruthy()
    await mdTab!.trigger('click')

    // 输入端与运行按钮就位：定位 Markdown 输入框（避免抓到对话框的消息输入框）
    const mdTextarea = wrapper
      .findAll('textarea')
      .find((t) => (t.attributes('placeholder') ?? '').includes('Markdown'))
    expect(mdTextarea).toBeTruthy()

    // 输入内容并点击「运行」，走前端注入的真实渲染能力
    await mdTextarea!.setValue('### 你好世界')
    const runBtn = wrapper.findAll('button').find((b) => b.text().includes('运行'))
    expect(runBtn).toBeTruthy()
    await runBtn!.trigger('click')

    await flushPromises()
    expect(wrapper.html()).toContain('<h3>你好世界</h3>')

    wrapper.unmount()
  })

  it('点击「＋」新增占位工具（网页快照）', async () => {
    const wrapper = mount(ToolWorkspace)

    await wrapper.find('[aria-label="添加工具"]').trigger('click')

    expect(wrapper.text()).toContain('网页快照')
    expect(wrapper.text()).toContain('占位')
    expect(wrapper.text()).toContain('暂无会话详情')

    wrapper.unmount()
  })
})
