import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolWorkspace from './tool-workspace.vue'

describe('ToolWorkspace', () => {
  it('渲染顶栏与默认工具页（PDF 合并器）', () => {
    const wrapper = mount(ToolWorkspace)

    // 顶栏：品牌 / 搜索 / 新建工具
    expect(wrapper.text()).toContain('小班')
    expect(wrapper.text()).toContain('新建工具')

    // 标签栏：默认打开的三个工具
    expect(wrapper.text()).toContain('PDF 合并器')
    expect(wrapper.text()).toContain('表格清洗')
    expect(wrapper.text()).toContain('批量重命名')

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

  it('点击「＋」新增占位工具（网页快照）', async () => {
    const wrapper = mount(ToolWorkspace)

    await wrapper.find('[aria-label="添加工具"]').trigger('click')

    expect(wrapper.text()).toContain('网页快照')
    expect(wrapper.text()).toContain('占位')
    expect(wrapper.text()).toContain('暂无会话详情')

    wrapper.unmount()
  })
})
