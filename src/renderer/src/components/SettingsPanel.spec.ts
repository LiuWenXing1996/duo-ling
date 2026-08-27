import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import SettingsPanel from './SettingsPanel.vue'

const modelApiMock = {
  list: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
  setActive: vi.fn(),
  toggle: vi.fn(),
  test: vi.fn()
}

const providerApiMock = {
  list: vi.fn()
}

const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    supported: true
  },
  {
    id: 'aws',
    name: 'AWS',
    baseUrl: 'https://aws.example.com/v1',
    keyUrl: '',
    models: ['claude-3-5-sonnet'],
    supported: false
  }
]

const LIST = {
  profiles: [
    {
      id: 'p1',
      name: 'DeepSeek',
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      enabled: true,
      useFullUrl: false,
      apiFormat: 'openai',
      hasApiKey: true
    },
    {
      id: 'p2',
      name: 'Qwen',
      providerId: 'custom',
      baseUrl: 'https://dashscope.example.com/v1',
      model: 'qwen-plus',
      enabled: false,
      useFullUrl: false,
      apiFormat: 'openai',
      hasApiKey: false
    }
  ],
  activeId: 'p1'
}

function stubApi(listData: unknown = LIST): void {
  modelApiMock.list.mockResolvedValue(listData)
  modelApiMock.save.mockImplementation(async (profile: Record<string, unknown>) => ({
    id: (profile.id as string) ?? 'new-id',
    name: profile.name,
    providerId: (profile.providerId as string) ?? '',
    baseUrl: profile.baseUrl,
    model: profile.model,
    enabled: (profile.enabled as boolean) ?? true,
    useFullUrl: (profile.useFullUrl as boolean) ?? false,
    apiFormat: 'openai',
    hasApiKey: Boolean(profile.apiKey)
  }))
  modelApiMock.delete.mockResolvedValue(undefined)
  modelApiMock.setActive.mockResolvedValue(undefined)
  modelApiMock.toggle.mockResolvedValue(undefined)
  modelApiMock.test.mockResolvedValue({ ok: true, models: ['deepseek-chat'] })
  providerApiMock.list.mockResolvedValue(PROVIDERS)
  vi.stubGlobal('api', {
    model: modelApiMock,
    provider: providerApiMock
  })
}

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

beforeEach(() => {
  vi.clearAllMocks()
  stubApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SettingsPanel', () => {
  it('渲染模型表格并显示服务商名', async () => {
    const wrapper = mount(SettingsPanel)
    await flushPromises()

    expect(modelApiMock.list).toHaveBeenCalledTimes(1)
    expect(providerApiMock.list).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('DeepSeek')
    expect(wrapper.text()).toContain('Qwen')
    expect(wrapper.text()).toContain('服务商')
    expect(wrapper.text()).toContain('操作')
    expect(wrapper.text()).toContain('自定义')
    wrapper.unmount()
  })

  it('无配置时展示空态与添加按钮', async () => {
    stubApi({ profiles: [], activeId: '' })
    const wrapper = mount(SettingsPanel)
    await flushPromises()

    expect(wrapper.text()).toContain('还没有模型配置')
    wrapper.unmount()
  })

  it('点击添加模型直接打开表单（默认自定义模型）', async () => {
    const wrapper = mount(SettingsPanel, { attachTo: document.body })
    await flushPromises()

    await buttonByText(wrapper.element, '添加模型').click()
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('添加模型')
    })

    const dialog = queryDialog()
    // 打开后直接进入表单，以接口地址为源头，模型为自由输入
    expect(dialog.textContent).toContain('接口地址')
    expect(dialog.textContent).toContain('从服务商快捷填入')
    expect(dialog.textContent).toContain('模型')
    const modelInput = dialog.querySelector<HTMLInputElement>(
      'input[placeholder="输入模型 ID，如 gpt-4o"]'
    )
    expect(modelInput).toBeTruthy()
    wrapper.unmount()
  })

  it('通过自定义模型添加：填表并保存后刷新列表', async () => {
    const wrapper = mount(SettingsPanel, { attachTo: document.body })
    await flushPromises()

    await buttonByText(wrapper.element, '添加模型').click()
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('添加模型')
    })

    // 打开后即为自定义模型表单，无需再进入自定义视图
    const dialog = queryDialog()
    const modelInput = dialog.querySelector<HTMLInputElement>(
      'input[placeholder="输入模型 ID，如 gpt-4o"]'
    )
    const urlInput = dialog.querySelector<HTMLInputElement>(
      'input[placeholder="例如 https://api.openai.com/v1"]'
    )

    expect(modelInput).toBeTruthy()
    expect(urlInput).toBeTruthy()
    modelInput!.value = 'qwen-max'
    modelInput!.dispatchEvent(new Event('input'))
    urlInput!.value = 'https://dashscope.example.com/v1'
    urlInput!.dispatchEvent(new Event('input'))
    await flushPromises()

    await buttonByText(dialog, '添加模型').click()
    await vi.waitFor(() => {
      expect(modelApiMock.save).toHaveBeenCalledTimes(1)
    })

    const arg = modelApiMock.save.mock.calls[0][0]
    expect(arg).toMatchObject({
      name: '',
      baseUrl: 'https://dashscope.example.com/v1',
      apiKey: '',
      model: 'qwen-max',
      enabled: true
    })
    expect(modelApiMock.list).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('切换开关调用 model.toggle', async () => {
    const wrapper = mount(SettingsPanel)
    await flushPromises()

    const switchBtn = wrapper.find('[role="switch"]')
    expect(switchBtn.exists()).toBe(true)
    await switchBtn.trigger('click')
    await flushPromises()

    expect(modelApiMock.toggle).toHaveBeenCalledWith('p1', false)
    wrapper.unmount()
  })

  it('删除模型需确认并调用 model.delete', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const wrapper = mount(SettingsPanel, { attachTo: document.body })
    await flushPromises()

    const deleteBtn = wrapper.findAll('button').find((b) => b.attributes('title') === '删除')
    expect(deleteBtn).toBeTruthy()
    await deleteBtn!.trigger('click')
    await flushPromises()

    expect(modelApiMock.delete).toHaveBeenCalledWith('p1')
    expect(modelApiMock.list).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('点击「打开开发者界面」发出 open-developer 事件', async () => {
    const wrapper = mount(SettingsPanel, { attachTo: document.body })
    await flushPromises()

    await buttonByText(wrapper.element, '打开开发者界面').click()
    expect(wrapper.emitted('open-developer')).toBeTruthy()
    wrapper.unmount()
  })
})
