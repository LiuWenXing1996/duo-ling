import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ToolWorkspace from './ToolWorkspace.vue'

// 弹窗内容被 Teleport 到 body，需直接操作 DOM
function queryDialog(): HTMLElement {
  const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null
  expect(dialog, '未找到弹窗').toBeTruthy()
  return dialog!
}

function buttonByText(root: HTMLElement | Document, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === text
  ) as HTMLButtonElement | undefined
  expect(button, `未找到按钮：${text}`).toBeTruthy()
  return button!
}

describe('ToolWorkspace', () => {
  beforeEach(() => {
    // 只注入 window.api，保留原生 window，避免破坏 @vue/test-utils 的 DOM 事件机制
    // 新建工具落盘后返回 ID 与标题，由工作台直接打开对应标签页
    Object.defineProperty(window, 'api', {
      value: {
        tool: {
          create: vi.fn().mockResolvedValue({ ok: true, id: 't-init', title: '新工具' }),
          list: vi.fn().mockResolvedValue([
            { id: 't-1', name: 'pdf-merge', title: 'PDF 合并器', description: '合并多个 PDF' }
          ]),
          update: vi.fn().mockResolvedValue({ ok: true }),
          delete: vi.fn().mockResolvedValue({ ok: true }),
          updateMeta: vi.fn().mockResolvedValue({ ok: true, title: 'PDF 合并器', icon: 'P' }),
          getPreloadPath: vi.fn().mockResolvedValue('file:///preload/tool.cjs'),
          group: {
            list: vi.fn().mockResolvedValue({}),
            set: vi.fn().mockResolvedValue({})
          }
        },
        agent: {
          abort: vi.fn().mockResolvedValue(undefined)
        },
        agentTools: {
          list: vi.fn().mockResolvedValue([])
        },
        capability: {
          list: vi.fn().mockResolvedValue([])
        },
        model: {
          list: vi.fn().mockResolvedValue({ profiles: [], activeId: '' }),
          setActive: vi.fn().mockResolvedValue(undefined)
        },
        provider: {
          list: vi.fn().mockResolvedValue([])
        },
        settings: {
          getSystemPrompt: vi.fn().mockResolvedValue(''),
          setSystemPrompt: vi.fn().mockResolvedValue(undefined)
        }
      },
      configurable: true
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (window as unknown as Record<string, unknown>).api
  })

  it('默认展示主页标签，且不展示任何演示/占位工具', () => {
    const wrapper = mount(ToolWorkspace)

    // 主页标签始终存在，为默认视图
    expect(wrapper.text()).toContain('主页')

    // 主页空状态：指向「新增工具」按钮
    expect(wrapper.text()).toContain('还没有工具，点击右上角「新增工具」创建')

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
      title: '新工具'
    })
    const wrapper = mount(ToolWorkspace)

    // 主页网格里的「新增工具」与侧边栏按钮都调用组件暴露的方法，
    // 这里直接通过方法触发新建。
    await (wrapper.vm as unknown as { createTool: () => Promise<void> }).createTool()
    await flushPromises()
    await wrapper.vm.$nextTick()

    // 调用主进程创建
    expect(window.api.tool.create).toHaveBeenCalledTimes(1)

    // 标签栏出现新工具标签，且被激活；主页标签虽保持挂载但已隐藏（关闭「切页即卸载」行为）
    expect(wrapper.text()).toContain('新工具')
    const toolPanels = wrapper.findAll('[role="tabpanel"]')
    const homePanel = toolPanels.find((p) => p.text().includes('还没有工具'))
    expect(homePanel).toBeTruthy()
    expect(homePanel?.attributes('hidden')).toBeDefined()

    // 激活标签只渲染工具详情面板（会话历史/当前会话已上浮为全局三栏）
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('工具详情')

    wrapper.unmount()
  })

  it('主页网格展示所有工具，点击卡片打开对应标签页', async () => {
    const wrapper = mount(ToolWorkspace, {
      props: {
        tools: [
          { id: 't-1', name: 'pdf-merge', title: 'PDF 合并器', description: '合并多个 PDF' }
        ]
      }
    })
    await wrapper.vm.$nextTick()

    // 主页网格列出所有工具
    expect(wrapper.text()).toContain('PDF 合并器')
    expect(wrapper.text()).toContain('合并多个 PDF')

    // 点击卡片打开对应工具标签（只渲染工具详情面板）
    await wrapper.find('.tool-card').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('工具详情')

    wrapper.unmount()
  })

  it('打开设置标签页：新开一个「设置」标签并渲染设置面板', async () => {
    const wrapper = mount(ToolWorkspace)

    // 调用暴露的方法打开设置标签
    ;(wrapper.vm as unknown as { openSettingsTab: () => void }).openSettingsTab()
    await wrapper.vm.$nextTick()

    // 标签栏出现「设置」标签
    expect(wrapper.text()).toContain('设置')

    // 设置面板内容渲染（模型管理）
    await wrapper.vm.$nextTick()
    expect(wrapper.text()).toContain('模型管理')

    wrapper.unmount()
  })

  it('打开开发者标签页：新开一个「开发者」标签并渲染 Agent 工具介绍', async () => {
    ;(window.api.agentTools.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        type: 'function',
        function: {
          name: 'agent_tools_list',
          description: '列出所有已存在的工具。',
          parameters: { type: 'object', properties: {}, additionalProperties: false }
        }
      }
    ])
    const wrapper = mount(ToolWorkspace)

    ;(wrapper.vm as unknown as { openDeveloperTab: () => void }).openDeveloperTab()
    await wrapper.vm.$nextTick()
    await flushPromises()

    expect(wrapper.text()).toContain('开发者')
    expect(wrapper.text()).toContain('agent_tools_list')
    expect(wrapper.text()).toContain('列出所有已存在的工具。')

    wrapper.unmount()
  })

  it('主页工具卡片删除按钮：打开确认弹窗，确认后删除并通知刷新', async () => {
    const wrapper = mount(ToolWorkspace, {
      attachTo: document.body,
      props: {
        tools: [
          { id: 't-1', name: 'pdf-merge', title: 'PDF 合并器', description: '合并多个 PDF' }
        ]
      }
    })
    await flushPromises()

    // 点击删除按钮：仅打开确认弹窗，不立即删除
    await wrapper.find('.tool-card__action--delete').trigger('click')
    await flushPromises()

    const dialog = queryDialog()
    expect(dialog.textContent).toContain('删除工具')
    expect(dialog.textContent).toContain('PDF 合并器')

    // 点击弹窗「工具及数据一并删除」执行删除（keepData=false）
    await buttonByText(dialog, '工具及数据一并删除').click()
    await flushPromises()

    expect(window.api.tool.delete).toHaveBeenCalledWith('t-1', false)
    expect(wrapper.emitted('toolsChanged')).toBeTruthy()

    wrapper.unmount()
  })

  it('主页工具卡片删除：点击「取消」则不删除', async () => {
    const wrapper = mount(ToolWorkspace, {
      attachTo: document.body,
      props: {
        tools: [
          { id: 't-1', name: 'pdf-merge', title: 'PDF 合并器', description: '合并多个 PDF' }
        ]
      }
    })
    await flushPromises()

    await wrapper.find('.tool-card__action--delete').trigger('click')
    await flushPromises()

    const dialog = queryDialog()
    await buttonByText(dialog, '取消').click()
    await flushPromises()

    expect(window.api.tool.delete).not.toHaveBeenCalled()
    expect(wrapper.emitted('toolsChanged')).toBeFalsy()

    wrapper.unmount()
  })

  it('主页工具卡片编辑按钮：打开弹窗，保存名称/图标/描述并调用 updateMeta', async () => {
    const wrapper = mount(ToolWorkspace, {
      attachTo: document.body,
      props: {
        tools: [
          { id: 't-1', name: 'pdf-merge', title: 'PDF 合并器', description: '合并多个 PDF' }
        ]
      }
    })
    await flushPromises()

    // 点击编辑按钮：打开编辑弹窗，并回填当前元信息
    await wrapper.find('.tool-card__action--edit').trigger('click')
    await flushPromises()

    const dialog = queryDialog()
    expect(dialog.textContent).toContain('编辑工具')
    const inputs = dialog.querySelectorAll('input')
    expect(inputs).toHaveLength(4)
    expect((inputs[0] as HTMLInputElement).value).toBe('PDF 合并器')
    expect((inputs[1] as HTMLInputElement).value).toBe('')
    expect((inputs[2] as HTMLInputElement).value).toBe('合并多个 PDF')
    // 第 4 个输入框是分组：当前未分组，故为空
    expect((inputs[3] as HTMLInputElement).value).toBe('')

    // 修改表单后保存：通过在原生 input 上派发 input 事件更新 v-model
    const setInput = (el: Element, value: string): void => {
      ;(el as HTMLInputElement).value = value
      el.dispatchEvent(new Event('input'))
    }
    setInput(inputs[0]!, '新名称')
    setInput(inputs[1]!, 'P')
    setInput(inputs[2]!, '新描述')
    setInput(inputs[3]!, '办公')
    await flushPromises()
    await buttonByText(dialog, '保存').click()
    await flushPromises()

    expect(window.api.tool.updateMeta).toHaveBeenCalledWith('t-1', {
      title: '新名称',
      icon: 'P',
      description: '新描述'
    })
    // 分组变化时单独落盘分组映射
    expect(window.api.tool.group.set).toHaveBeenCalledWith('t-1', '办公')
    expect(wrapper.emitted('toolsChanged')).toBeTruthy()

    wrapper.unmount()
  })

  it('编辑工具时分组未变，不重复落盘分组映射', async () => {
    ;(window.api.tool.group.list as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      't-1': '办公'
    })
    const wrapper = mount(ToolWorkspace, {
      attachTo: document.body,
      props: {
        tools: [
          { id: 't-1', name: 'pdf-merge', title: 'PDF 合并器', description: '合并多个 PDF' }
        ]
      }
    })
    await flushPromises()

    await wrapper.find('.tool-card__action--edit').trigger('click')
    await flushPromises()

    const dialog = queryDialog()
    const inputs = dialog.querySelectorAll('input')
    expect((inputs[3] as HTMLInputElement).value).toBe('办公')

    // 分组保持「办公」不变，仅改名称
    const setInput = (el: Element, value: string): void => {
      ;(el as HTMLInputElement).value = value
      el.dispatchEvent(new Event('input'))
    }
    setInput(inputs[0]!, '新名称')
    await flushPromises()
    await buttonByText(dialog, '保存').click()
    await flushPromises()

    expect(window.api.tool.group.set).not.toHaveBeenCalled()
    expect(wrapper.emitted('toolsChanged')).toBeTruthy()

    wrapper.unmount()
  })
})
