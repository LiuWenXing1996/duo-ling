import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ToolIcon from './ToolIcon.vue'

describe('ToolIcon', () => {
  it('icon 为单个字符时直接渲染字符', () => {
    const wrapper = mount(ToolIcon, { props: { icon: '📄', fallback: '工具' } })
    expect(wrapper.text()).toBe('📄')
  })

  it('icon 为空时回退 fallback 首字符，再兜底 ✨', () => {
    expect(mount(ToolIcon, { props: { fallback: '测试' } }).text()).toBe('测')
    expect(mount(ToolIcon).text()).toBe('✨')
  })

  it('icon 为 lucide:<名称> 时异步加载 lucide 图标（渲染 svg）', async () => {
    const wrapper = mount(ToolIcon, { props: { icon: 'lucide:sparkle', fallback: '工具' } })
    await vi.waitFor(() => expect(wrapper.find('svg').exists()).toBe(true))
  })

  it('icon 为 lucide: 但名称不在允许列表时回退 fallback 首字符', async () => {
    const wrapper = mount(ToolIcon, { props: { icon: 'lucide:not-exist', fallback: '工具' } })
    await flushPromises()
    expect(wrapper.find('svg').exists()).toBe(false)
    expect(wrapper.text()).toBe('工')
  })
})
