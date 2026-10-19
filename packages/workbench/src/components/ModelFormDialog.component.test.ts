// UI 组件测试：ModelFormDialog.vue（添加/编辑模型弹窗）。
// 只验证交互逻辑：地址栏的显隐与形状校验、保存/测试连接实际传出的参数、密钥可留空。
// reka-ui Dialog 经 teleport 挂到 body，故断言一律直接查 document.body（同 ConfirmDialog 的写法）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount } from '@vue/test-utils'
import type { ModelProfile, ModelProvider } from '@duoling/shared'
import ModelFormDialog from './ModelFormDialog.vue'

// 保存与连通性测试直连 model-store（不再经 window.api），在模块级替身里捕获入参。
// spread 保其余符号真身（同文件的 errorText 走的是 ui 的 format，不受影响）。
const modelMocks = vi.hoisted(() => ({ saveProfile: vi.fn(), testChatResult: vi.fn() }))
vi.mock('@duoling/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@duoling/shared')>()),
  saveProfile: modelMocks.saveProfile,
  testChatResult: modelMocks.testChatResult,
}))

const ADDRESS_PLACEHOLDER = 'https://example.com/v1/chat/completions'

const PROVIDERS: ModelProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/chat/completions',
    keyUrl: '',
    models: ['deepseek-flash'],
    supported: true,
  },
  // unsupported 的预设不出现在下拉里（如 AWS 走签名鉴权）
  { id: 'aws', name: 'AWS', baseUrl: '', keyUrl: '', models: [], supported: false },
]

const presetProfile: ModelProfile = {
  id: 'p-preset',
  name: 'DeepSeek',
  providerId: 'deepseek',
  baseUrl: 'https://api.deepseek.com/chat/completions',
  model: 'deepseek-flash',
  apiFormat: 'openai',
  hasApiKey: true,
}

const customProfile: ModelProfile = {
  id: 'p-custom',
  name: '本地假模型',
  providerId: 'custom',
  baseUrl: 'http://127.0.0.1:5199/chat/completions',
  model: 'stub-model',
  apiFormat: 'openai',
  hasApiKey: false,
}

let savedInput: Record<string, unknown> | undefined
let testChatCalls: Array<Record<string, unknown>>

beforeEach(() => {
  savedInput = undefined
  testChatCalls = []
  modelMocks.saveProfile.mockReset()
  modelMocks.testChatResult.mockReset()
  modelMocks.saveProfile.mockImplementation(async (input: Record<string, unknown>) => {
    savedInput = input
    return {}
  })
  modelMocks.testChatResult.mockImplementation(async (cfg: Record<string, unknown>) => {
    testChatCalls.push(cfg)
    return { ok: true }
  })
})

afterEach(() => {
  document.body.innerHTML = ''
})

function inputByPlaceholder(placeholder: string): DOMWrapper<HTMLInputElement> {
  const el = ([...document.body.querySelectorAll('input')] as HTMLInputElement[]).find(
    (i) => i.placeholder === placeholder,
  )
  expect(el, `未找到 placeholder 为「${placeholder}」的输入框`).toBeTruthy()
  return new DOMWrapper<HTMLInputElement>(el!)
}

function addressInput(): HTMLInputElement | null {
  return (
    ([...document.body.querySelectorAll('input')] as HTMLInputElement[]).find(
      (i) => i.placeholder === ADDRESS_PLACEHOLDER,
    ) ?? null
  )
}

function buttonByText(text: string): DOMWrapper<HTMLButtonElement> {
  const el = ([...document.body.querySelectorAll('button')] as HTMLButtonElement[]).find(
    (b) => b.textContent?.trim() === text,
  )
  expect(el, `未找到文案为「${text}」的按钮`).toBeTruthy()
  return new DOMWrapper<HTMLButtonElement>(el!)
}

/**
 * 展开服务商下拉。
 * 走 keydown（reka-ui 的 OPEN_KEYS 含 ArrowDown）而不是 pointerdown：后者在无头 DOM 里
 * 依赖 PointerEvent / pointer capture 特性，前者只要一个 KeyboardEvent。
 * 未展开时 SelectContent 不渲染，所以任何「下拉里没有 X」的断言都会恒真 —— 必须先展开。
 */
async function openProviderSelect(): Promise<void> {
  const trigger = document.body.querySelector('[role="combobox"]')
  expect(trigger, '未找到服务商下拉触发器').toBeTruthy()
  await new DOMWrapper(trigger as HTMLElement).trigger('keydown', { key: 'ArrowDown' })
  await flushPromises()
}

async function mountDialog(props: { open?: boolean; editing?: ModelProfile | null } = {}) {
  const wrapper = mount(ModelFormDialog, {
    props: { open: true, editing: null, providers: PROVIDERS, ...props },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

describe('ModelFormDialog · 地址栏显隐', () => {
  it('open=false 时不渲染弹窗内容', async () => {
    await mountDialog({ open: false })

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
  })

  it('新增态默认没有地址栏（未选服务商）', async () => {
    await mountDialog()

    expect(addressInput()).toBeNull()
  })

  it('编辑自定义端点：出现地址栏并回显已保存的地址', async () => {
    await mountDialog({ editing: customProfile })

    expect(addressInput()?.value).toBe('http://127.0.0.1:5199/chat/completions')
  })

  it('编辑预设服务商：没有地址栏（地址由服务商决定）', async () => {
    await mountDialog({ editing: presetProfile })

    expect(addressInput()).toBeNull()
  })

  it('服务商下拉：展开后列出受支持的预设与「自定义」，不列出 unsupported 预设', async () => {
    await mountDialog()
    await openProviderSelect()

    const text = document.body.textContent ?? ''
    // 两个正例先证下拉确实展开了 —— 少了它们，下面那句 not.toContain 恒真，等于没测
    expect(text).toContain('DeepSeek')
    expect(text).toContain('自定义')
    expect(text).not.toContain('AWS')
  })
})

describe('ModelFormDialog · 自定义端点', () => {
  it('地址形状不合法：就地提示且不能保存', async () => {
    await mountDialog({ editing: customProfile })

    await inputByPlaceholder(ADDRESS_PLACEHOLDER).setValue('not-a-url')
    await flushPromises()

    expect(document.body.textContent).toContain('请填写完整的接口地址')
    expect(buttonByText('保存').attributes('disabled')).toBeDefined()
  })

  it('本地回环地址合法（本地模型端点）', async () => {
    await mountDialog({ editing: customProfile })

    await inputByPlaceholder(ADDRESS_PLACEHOLDER).setValue(
      'http://127.0.0.1:8000/v1/chat/completions',
    )
    await flushPromises()

    expect(buttonByText('保存').attributes('disabled')).toBeUndefined()
  })

  it('保存：地址原样传出（不做拼接/剥离）、无 useFullUrl、密钥留空也放行', async () => {
    const wrapper = await mountDialog({ editing: customProfile })

    await inputByPlaceholder(ADDRESS_PLACEHOLDER).setValue(
      'http://127.0.0.1:5199/v1/chat/completions/',
    )
    await flushPromises()
    await buttonByText('保存').trigger('click')
    await flushPromises()

    expect(savedInput).toMatchObject({
      id: 'p-custom',
      providerId: 'custom',
      baseUrl: 'http://127.0.0.1:5199/v1/chat/completions/',
      model: 'stub-model',
      apiKey: '',
    })
    expect(savedInput).not.toHaveProperty('useFullUrl')
    expect(wrapper.emitted('saved')).toHaveLength(1)
  })

  it('测试连接：按表单里的地址发请求，编辑态带 profileId 回退密钥', async () => {
    await mountDialog({ editing: customProfile })

    await inputByPlaceholder(ADDRESS_PLACEHOLDER).setValue('http://127.0.0.1:5199/chat/completions')
    await flushPromises()
    await buttonByText('测试连接').trigger('click')
    await flushPromises()

    expect(testChatCalls[0]).toMatchObject({
      baseUrl: 'http://127.0.0.1:5199/chat/completions',
      model: 'stub-model',
      profileId: 'p-custom',
    })
    expect(testChatCalls[0]).not.toHaveProperty('useFullUrl')
  })
})

describe('ModelFormDialog · 预设服务商', () => {
  it('编辑预设服务商：保存沿用该配置的地址', async () => {
    await mountDialog({ editing: presetProfile })

    await buttonByText('保存').trigger('click')
    await flushPromises()

    expect(savedInput).toMatchObject({
      id: 'p-preset',
      providerId: 'deepseek',
      baseUrl: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-flash',
    })
  })
})
