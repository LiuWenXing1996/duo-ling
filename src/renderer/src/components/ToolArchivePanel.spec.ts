import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ToolArchivePanel from './ToolArchivePanel.vue'

describe('ToolArchivePanel（工具档案面板）', () => {
  const readMock = vi.fn()
  const writeMock = vi.fn()

  beforeEach(() => {
    readMock.mockReset()
    writeMock.mockReset()
    // 只注入 window.api，保留原生 window，避免破坏 @vue/test-utils 的 DOM 事件机制
    Object.defineProperty(window, 'api', {
      value: {
        tool: {
          archive: {
            read: readMock,
            write: writeMock
          }
        }
      },
      configurable: true
    })
  })

  it('加载后展示 markdown 渲染内容与编辑入口', async () => {
    readMock.mockResolvedValue({ ok: true, content: '## 定位\n一句话' })
    const wrapper = mount(ToolArchivePanel, {
      props: { toolId: 't-1', toolTitle: '工具一' }
    })
    await flushPromises()

    // markdown 已渲染（h2 标题出现）
    expect(wrapper.find('.tool-archive__markdown h2').text()).toBe('定位')
    // 存在编辑按钮
    expect(wrapper.text()).toContain('编辑')
  })

  it('无档案时显示「撰写档案」引导', async () => {
    readMock.mockResolvedValue({ ok: true, content: '' })
    const wrapper = mount(ToolArchivePanel, {
      props: { toolId: 't-1', toolTitle: '工具一' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('暂无档案')
    expect(wrapper.text()).toContain('撰写档案')
  })

  it('编辑 → 保存：写回 archive.md', async () => {
    readMock.mockResolvedValue({ ok: true, content: '' })
    writeMock.mockResolvedValue({ ok: true })
    const wrapper = mount(ToolArchivePanel, {
      props: { toolId: 't-1', toolTitle: '工具一' }
    })
    await flushPromises()

    // 进入编辑
    await wrapper.get('button').trigger('click')
    await flushPromises()
    const textarea = wrapper.find('textarea')
    expect(textarea.exists()).toBe(true)

    // 修改并保存（编辑态按钮：取消 / 保存，按文本定位「保存」）
    await textarea.setValue('## 定位\n新档案')
    const saveBtn = wrapper
      .findAll('button')
      .find((b) => b.text()?.trim() === '保存')
    expect(saveBtn, '未找到保存按钮').toBeTruthy()
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(writeMock).toHaveBeenCalledWith('t-1', '## 定位\n新档案')
    // 保存成功退回预览态，markdown 渲染新内容
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('.tool-archive__markdown h2').text()).toBe('定位')
  })
})
