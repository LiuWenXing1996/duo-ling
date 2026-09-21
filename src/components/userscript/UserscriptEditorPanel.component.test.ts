// UI 组件测试：UserscriptEditorPanel.vue（编辑器标签页的加载 / 保存 / 关闭确认逻辑）。
// 数据流（2026-09-20 单文件化后）：元数据走 userscriptClient.getProject（状态库），
// 源码走 fsClient.read（duoling-fs 工作树，单文件 Source = { code }）；配置全部由源码里的
// // ==UserScript== 块决定，编辑器不暴露配置表单——保存只传 { note }。
// 只验证交互逻辑：加载渲染、统一保存链路（note 传入 / 保存成功回写 / 注册失败提示 / 保存中禁用）。
// 边界 mock：ui-client（IPC 客户端）；CodeMirror 用真实实现（happy-dom 可跑）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UserscriptEditorPanel from './UserscriptEditorPanel.vue'
import type { ScriptProject } from '@/lib/userscripts/types'
import type { Source } from '@/lib/userscripts/us-git'

const getProject = vi.hoisted(() => vi.fn())
const save = vi.hoisted(() => vi.fn())
const read = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: { getProject, save },
  fsClient: { read },
}))

const UUID = 'test-uuid-1'
const CODE = 'console.log(1)'

const project: ScriptProject = {
  v: 2,
  uuid: UUID,
  name: '测试脚本',
  enabled: true,
  config: { matches: ['https://a.example/*'], allFrames: true, runAt: 'document_end' },
  group: '',
  source: { code: CODE, savedAt: 0 },
  createdAt: 0,
  updatedAt: 0,
}

/** 已保存源码（fs:read 的应答；单文件 Source 只有 code，无并行元数据文件） */
const headSource: Source = { code: CODE }

const saveOk = () => ({})

let wrapper: VueWrapper

async function mountEditor(): Promise<VueWrapper> {
  const w = mount(UserscriptEditorPanel, { props: { uuid: UUID } })
  await flushPromises()
  return w
}

// 底栏备注输入框（编辑器内唯一的 ui-input；data-slot 由 shadcn input 提供）
const noteInput = (): DOMWrapper<HTMLInputElement> =>
  new DOMWrapper<HTMLInputElement>(
    wrapper.element.querySelector('input[data-slot="input"]') as HTMLInputElement,
  )

const saveBtn = () => wrapper.findAll('button').find((b) => b.text() === '保存并重新注册')!

beforeEach(() => {
  vi.clearAllMocks()
  getProject.mockResolvedValue(project)
  read.mockResolvedValue(headSource)
  save.mockResolvedValue(saveOk())
})

afterEach(() => {
  wrapper?.unmount()
  vi.useRealTimers()
})

describe('UserscriptEditorPanel 加载与渲染', () => {
  it('加载后渲染脚本名与单文件标识', async () => {
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('测试脚本')
    expect(wrapper.text()).toContain('单文件脚本 · script.js')
  })

  it('getProject 失败时展示错误条', async () => {
    getProject.mockRejectedValue(new Error('脚本不存在'))
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('读取项目失败：脚本不存在')
  })

  it('源码读取失败（fs:read 抛错）展示「源码不可用」，不挡渲染', async () => {
    read.mockRejectedValue(new Error('ipc down'))
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('读取项目失败：源码不可用')
  })

  it('初始无未保存标记（未编辑）', async () => {
    wrapper = await mountEditor()
    expect(wrapper.emitted('dirty')).toBeUndefined()
    expect(wrapper.text()).not.toContain('有未保存改动')
  })
})

describe('UserscriptEditorPanel 统一保存链路', () => {
  it('保存成功：save(uuid, code, { note }) → 提示条含刷新提示', async () => {
    wrapper = await mountEditor()
    await saveBtn().trigger('click')
    await flushPromises()

    expect(save).toHaveBeenCalledTimes(1)
    const [uuid, code, opts] = save.mock.calls[0] as unknown as Parameters<typeof save>
    expect(uuid).toBe(UUID)
    expect(code).toBe(CODE)
    expect(opts).toEqual({ note: '' })
    expect(wrapper.text()).toContain('已保存并重新注册。目标页面刷新后生效。')
    expect(wrapper.text()).not.toContain('有未保存改动')
  })

  it('保存备注：填入后记入本次保存的 note', async () => {
    wrapper = await mountEditor()
    await noteInput().setValue('第一次改')
    await saveBtn().trigger('click')
    await flushPromises()
    const [, , opts] = save.mock.calls[0] as unknown as Parameters<typeof save>
    expect(opts).toEqual({ note: '第一次改' })
  })

  it('注册失败：保存仍成功，提示条带失败原因', async () => {
    wrapper = await mountEditor()
    save.mockResolvedValue({ registerError: '未开启 Allow User Scripts' })
    await saveBtn().trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain(
      '已保存，但注册失败，脚本不会注入页面：未开启 Allow User Scripts',
    )
  })

  it('保存中禁用保存按钮（防双击重复提交）', async () => {
    let resolveSave!: (r: unknown) => void
    save.mockReturnValue(new Promise((r) => (resolveSave = r)))
    wrapper = await mountEditor()
    await saveBtn().trigger('click')
    expect(wrapper.text()).toContain('保存中…')
    // saving 期间按钮文字变为「保存中…」，按新文字定位并断言禁用
    const savingBtn = wrapper.findAll('button').find((b) => b.text() === '保存中…')!
    expect(savingBtn.attributes('disabled')).toBeDefined()
    resolveSave(saveOk())
    await flushPromises()
  })
})
