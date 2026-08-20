import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import Button from '../button.vue'

describe('Button', () => {
  it('渲染默认变体与插槽内容', () => {
    const wrapper = mount(Button, { slots: { default: '确定' } })
    expect(wrapper.text()).toContain('确定')
    expect(wrapper.classes()).toContain('bg-primary')
  })

  it('渲染 outline 变体', () => {
    const wrapper = mount(Button, { props: { variant: 'outline' } })
    expect(wrapper.classes()).toContain('border')
  })

  it('透传原生点击事件', async () => {
    const onClick = vi.fn()
    const wrapper = mount(Button, { attrs: { onClick } })
    await wrapper.trigger('click')
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
