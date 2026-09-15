// 层 4 组件测试：ConfirmDialog.vue（关闭确认弹窗）。
// 只验证交互逻辑（确认/取消回调、update:open、文案渲染、danger 形态），不测样式像素。
// reka-ui Dialog 经 Portal teleport 到 body 且异步挂载 —— mount 时 attachTo: document.body +
// flushPromises 后直接查 document.body（test-utils 的 teleport stub 会吞掉子内容，不能用）。
import { afterEach, describe, expect, it } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import ConfirmDialog from './ConfirmDialog.vue'

const buttons = (): HTMLButtonElement[] =>
  [...document.body.querySelectorAll('button')] as HTMLButtonElement[]
const byText = (text: string): HTMLButtonElement | undefined =>
  buttons().find((b) => b.textContent?.trim() === text)
const btn = (text: string): DOMWrapper<HTMLButtonElement> =>
  new DOMWrapper<HTMLButtonElement>(byText(text)!)

async function mountDialog(props: {
  open?: boolean
  title?: string
  description?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
} = {}) {
  const wrapper = mount(ConfirmDialog, {
    props: { open: true, title: '删除脚本？', ...props },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('ConfirmDialog', () => {
  it('open=false 时不渲染弹窗内容', async () => {
    await mountDialog({ open: false })
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(buttons()).toHaveLength(0)
  })

  it('渲染标题与描述文案', async () => {
    await mountDialog({ description: '该操作不可撤销' })
    expect(document.body.textContent).toContain('删除脚本？')
    expect(document.body.textContent).toContain('该操作不可撤销')
  })

  it('没有 description 时不渲染描述节点', async () => {
    await mountDialog()
    expect(document.body.querySelector('[data-slot="dialog-description"]')).toBeNull()
  })

  it('默认按钮文案为 取消 / 确定', async () => {
    await mountDialog()
    expect(byText('取消')).toBeTruthy()
    expect(byText('确定')).toBeTruthy()
  })

  it('confirmText / cancelText 覆盖默认文案', async () => {
    await mountDialog({ confirmText: '删除', cancelText: '再想想' })
    expect(byText('删除')).toBeTruthy()
    expect(byText('再想想')).toBeTruthy()
    expect(byText('确定')).toBeUndefined()
  })

  it('点确认：emit confirm + update:open false（弹窗自行关闭）', async () => {
    const wrapper = await mountDialog()
    await btn('确定').trigger('click')
    expect(wrapper.emitted('confirm')).toHaveLength(1)
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('点取消：只 emit update:open false，不 emit confirm', async () => {
    const wrapper = await mountDialog()
    await btn('取消').trigger('click')
    expect(wrapper.emitted('confirm')).toBeUndefined()
    expect(wrapper.emitted('update:open')).toEqual([[false]])
  })

  it('danger=true 时确认按钮带 destructive 类', async () => {
    await mountDialog({ danger: true })
    expect(byText('确定')!.className).toContain('bg-destructive')
  })

  it('danger 缺省时确认按钮用 primary 类', async () => {
    await mountDialog()
    expect(byText('确定')!.className).toContain('bg-primary')
  })
})
