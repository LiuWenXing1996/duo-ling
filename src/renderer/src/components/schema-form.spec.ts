import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SchemaForm from './schema-form.vue'

const schema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '要回显的文本' },
    level: { type: 'string', enum: ['low', 'high'] },
    count: { type: 'integer', minimum: 1 },
    on: { type: 'boolean' },
    nested: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] }
  },
  required: ['text']
}

function mountForm(modelValue: Record<string, unknown> = {}) {
  return mount(SchemaForm, { props: { schema, modelValue } })
}

describe('SchemaForm', () => {
  it('按 schema 渲染各类型控件', () => {
    const wrapper = mountForm()
    expect(wrapper.find('input[type="text"]').exists()).toBe(true)
    expect(wrapper.find('input[type="number"]').exists()).toBe(true)
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(true)
    expect(wrapper.find('select').exists()).toBe(true)
  })

  it('enum 字段渲染为下拉并包含全部选项', () => {
    const wrapper = mountForm()
    const options = wrapper.findAll('select option').map((opt) => opt.text())
    expect(options).toEqual(expect.arrayContaining(['low', 'high']))
  })

  it('嵌套 object 递归渲染子表单', () => {
    const wrapper = mountForm()
    expect(wrapper.findComponent(SchemaForm).exists()).toBe(true)
  })

  it('字段描述渲染为说明文字', () => {
    const wrapper = mountForm()
    expect(wrapper.text()).toContain('要回显的文本')
  })

  it('编辑字段后 emit update:modelValue（合并新值）', async () => {
    const wrapper = mountForm()
    await wrapper.find('input[type="text"]').setValue('你好')
    const events = wrapper.emitted('update:modelValue')!
    expect(events.at(-1)![0]).toMatchObject({ text: '你好' })
  })

  it('必填字段无「可选」标记，可选字段带标记', () => {
    const wrapper = mountForm()
    const labels = wrapper.findAll('label').map((label) => label.text())
    expect(labels.some((text) => text.includes('可选'))).toBe(true)
    const requiredLabel = labels.find((text) => text.includes('text'))
    expect(requiredLabel).toBeDefined()
    expect(requiredLabel).not.toContain('可选')
  })
})
