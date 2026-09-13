import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import UiTestPanel from './UiTestPanel.vue'

describe('UiTestPanel（方案 C 预览：单层折叠 + step 分组）', () => {
  it('渲染标题与 mock 对话（用户消息 + 思考与执行过程 + 最终答案）', async () => {
    const wrapper = mount(UiTestPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('UI 测试 · 方案 C')
    expect(wrapper.text()).toContain('介绍一下这个项目的结构')
    expect(wrapper.text()).toContain('思考过程')
    // 最终答案留在气泡，不进折叠链
    expect(wrapper.text()).toContain('你的项目结构如下')
  })

  it('不加「第 N 步」分组标题：节点直接平铺在折叠区内', async () => {
    const wrapper = mount(UiTestPanel)
    await flushPromises()
    const stepHeaders = wrapper.findAll('span').filter((n) => /^第 \d+ 步$/.test(n.text()))
    expect(stepHeaders.length).toBe(0)
  })

  it('思考 / 工具 / 中间正文节点进入链，最终答案不进链', async () => {
    const wrapper = mount(UiTestPanel)
    await flushPromises()
    const text = wrapper.text()
    // 思考节点：step 1 一个 + step 2 两个（含超长）+ step 3 一个 = 4 个，label 为「思考」（不带序号）
    const thinkingLabels = wrapper.findAll('div').filter((n) => n.text().trim() === '思考')
    expect(thinkingLabels.length).toBe(4)
    // 中间正文节点：label 为「说明」（不带序号）
    expect(wrapper.findAll('div').some((n) => n.text().trim() === '说明')).toBe(true)
    // 工具卡片标题
    expect(text).toContain('查询工具列表')
    expect(text).toContain('打开工具')
    // 中间轮正文作为链上一环
    expect(text).toContain('当前共有 7 个工具')
    // 最终答案文本只出现一次（气泡中），而非链中重复
    expect(text.match(/你的项目结构如下/g)?.length).toBe(1)
  })
})
