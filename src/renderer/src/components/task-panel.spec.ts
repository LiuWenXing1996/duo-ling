import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import TaskPanel from './task-panel.vue'

const apiMock = {
  listTasks: vi.fn(),
  saveTasks: vi.fn()
}

const initialTasks = [
  { id: 1, title: '示例任务一', createdAt: '08-20' },
  { id: 2, title: '示例任务二', createdAt: '08-19' },
  { id: 3, title: '示例任务三', createdAt: '08-18' }
]

beforeEach(() => {
  apiMock.listTasks.mockResolvedValue(initialTasks)
  apiMock.saveTasks.mockResolvedValue(undefined)
  vi.stubGlobal('api', apiMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// 在 jsdom 中点击原生按钮（弹窗内容被 Teleport 到 body，需直接操作 DOM）
function clickNativeButtonByText(text: string) {
  const button = [...document.querySelectorAll('button')].find(
    (el) => el.textContent?.trim() === text
  )
  expect(button, `未找到按钮：${text}`).toBeTruthy()
  ;(button as HTMLButtonElement).click()
}

describe('TaskPanel', () => {
  it('挂载时通过 IPC 加载任务列表', async () => {
    const wrapper = mount(TaskPanel, { attachTo: document.body })
    await flushPromises()

    expect(apiMock.listTasks).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('任务列表')
    expect(wrapper.text()).toContain('示例任务一')
    expect(wrapper.text()).toContain('示例任务三')
    wrapper.unmount()
  })

  it('点击删除按钮弹出确认卡片，确认后删除并保存', async () => {
    const wrapper = mount(TaskPanel, { attachTo: document.body })
    await flushPromises()

    wrapper.find('button[aria-label="删除任务"]').trigger('click')
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('确认删除「示例任务一」？')
    })

    clickNativeButtonByText('删除')
    await vi.waitFor(() => {
      expect(wrapper.text()).not.toContain('示例任务一')
    })
    expect(wrapper.text()).toContain('示例任务二')
    expect(apiMock.saveTasks).toHaveBeenCalledWith(
      expect.not.arrayContaining([{ id: 1, title: '示例任务一', createdAt: '08-20' }])
    )
    wrapper.unmount()
  })

  it('删除全部按钮悬停显示 tooltip 文字提示', async () => {
    const wrapper = mount(TaskPanel, { attachTo: document.body })
    await flushPromises()

    await wrapper.find('button[aria-label="删除全部任务"]').trigger('pointermove')
    await vi.waitFor(() => {
      const tooltip = document.querySelector('[role="tooltip"]')
      expect(tooltip).toBeTruthy()
      expect(tooltip?.textContent).toContain('删除全部')
    })
    wrapper.unmount()
  })

  it('删除全部需二次确认，确认后清空列表并保存空数组', async () => {
    const wrapper = mount(TaskPanel, { attachTo: document.body })
    await flushPromises()

    wrapper.find('button[aria-label="删除全部任务"]').trigger('click')
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('确认删除全部任务？')
    })

    clickNativeButtonByText('删除')
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('暂无任务')
    })
    expect(wrapper.text()).not.toContain('示例任务')
    expect(apiMock.saveTasks).toHaveBeenCalledWith([])
    wrapper.unmount()
  })
})
