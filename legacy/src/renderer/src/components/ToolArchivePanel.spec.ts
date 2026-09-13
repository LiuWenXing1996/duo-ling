import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ToolArchivePanel from './ToolArchivePanel.vue'

// 档案渲染与对话消息一致（vue-stream-markdown）；其 Transition appear 在测试环境被 stub 为空，
// 因此这里 mock 掉 Markdown，只验证「读到的 content 正确传给渲染器 / 空态提示」，渲染职责由真实环境覆盖。
vi.mock('vue-stream-markdown', () => ({
  Markdown: {
    name: 'Markdown',
    props: ['content'],
    template: '<div data-testid="md" :class="$attrs.class">{{ content }}</div>'
  }
}))

describe('ToolArchivePanel（工具档案面板）', () => {
  const readMock = vi.fn()

  beforeEach(() => {
    readMock.mockReset()
    // 只注入 window.api，保留原生 window，避免破坏 @vue/test-utils 的 DOM 事件机制
    Object.defineProperty(window, 'api', {
      value: {
        tool: {
          archive: {
            read: readMock
          }
        }
      },
      configurable: true
    })
  })

  it('加载后将读到的内容传给 Markdown 渲染，不提供手动编辑入口', async () => {
    readMock.mockResolvedValue({ ok: true, content: '## 定位\n一句话' })
    const wrapper = mount(ToolArchivePanel, {
      props: { toolId: 't-1', toolTitle: '工具一' }
    })
    await flushPromises()

    // content 已交给与对话消息一致的渲染器
    expect(wrapper.get('[data-testid="md"]').text()).toContain('## 定位')
    // 顶部提示由 AI 记录，不提供手动编辑
    expect(wrapper.text()).toContain('和 AI 对话')
    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.findAll('button').length).toBe(0)
  })

  it('无档案时显示引导（由 AI 对话记录），不渲染 Markdown', async () => {
    readMock.mockResolvedValue({ ok: true, content: '' })
    const wrapper = mount(ToolArchivePanel, {
      props: { toolId: 't-1', toolTitle: '工具一' }
    })
    await flushPromises()

    expect(wrapper.text()).toContain('暂无档案')
    expect(wrapper.text()).toContain('小哆')
    expect(wrapper.find('[data-testid="md"]').exists()).toBe(false)
  })
})
