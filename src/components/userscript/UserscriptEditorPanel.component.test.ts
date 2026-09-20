// UI 组件测试：UserscriptEditorPanel.vue（编辑器标签页的保存 / 关闭确认逻辑）。
// 只验证交互逻辑，不测样式：加载渲染、dirty 上报（宿主关标签前确认的依据）、
// 统一保存链路（matches 必填拦截 / 保存成功回写 / 注册失败提示）。
// 边界 mock：ui-client（IPC 客户端）；CodeMirror 用真实实现（happy-dom 可跑）。
// 数据流（2026-09-20 单文件化后）：元数据走 userscriptClient.getProject（状态库），
// 源码走 fsClient.read（duoling-fs 工作树，单文件 Source）；编辑内容只活在页面内存，不落盘；
// 保存走 userscriptClient.save（唯一入口：提交 + 落库 + 重注册一条龙，无构建）。
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

/** 已保存源码（fs:read 的应答；保存后工作树与 HEAD 一致，无草稿概念） */
const headSource: Source = {
  meta: { name: project.name, config: project.config, createdAt: 0 },
  code: CODE,
}

const saveOk = () => ({})

let wrapper: VueWrapper

async function mountEditor(): Promise<VueWrapper> {
  const w = mount(UserscriptEditorPanel, { props: { uuid: UUID } })
  await flushPromises()
  return w
}

// 表单输入定位（模板顺序固定）：0 脚本名称 / 1 matches / 5 保存备注。
// 控件统一走 ui/input（shadcn），故按 data-slot 取；配置区默认收起但 unmount-on-hide=false，
// 表单仍在 DOM 里（仅被 hidden 隐藏），定位不受折叠影响。
const inputs = (): DOMWrapper<HTMLInputElement>[] =>
  [...wrapper.element.querySelectorAll('input[data-slot="input"]')].map(
    (el) => new DOMWrapper<HTMLInputElement>(el as HTMLInputElement),
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
})

describe('UserscriptEditorPanel 配置区（默认收起 + 摘要行）', () => {
  it('收起态摘要行交代当前注入面，且 runAt 下拉回显当前值', async () => {
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('脚本配置')
    // 摘要 = runAt · 匹配条数（收起时也能确认注入面）
    expect(wrapper.text()).toContain('document_end · 匹配 1 条')
    // 下拉触发器的回显文本（SelectValue 取选中项文本）；
    // 先确认内容区没被算进触发器子树，否则这条断言会被 portal 内容蒙混过关
    const runAtTrigger = wrapper.find('[data-slot="select-trigger"]')
    expect(runAtTrigger.html()).not.toContain('select-content')
    expect(runAtTrigger.text()).toContain('document_end（默认）')
  })

  it('收起态表单仍在 DOM 但被 hidden 隐藏（unmount-on-hide=false），展开开关翻转 aria-expanded', async () => {
    wrapper = await mountEditor()
    const trigger = wrapper.find('[data-slot="collapsible-trigger"]')
    expect(trigger.attributes('aria-expanded')).toBe('false')
    // 收起 = 留在 DOM 里、由 hidden 属性隐藏（reka-ui unmountOnHide=false 的语义；
    // 属性值经 Vue 归一为空串，故只断言存在性，不断言具体值）
    expect(wrapper.find('[data-slot="collapsible-content"]').attributes('hidden')).toBeDefined()
    // 表单字段随之仍在 DOM：控件与编辑态始终同源
    expect(inputs().length).toBeGreaterThan(0)
    await trigger.trigger('click')
    expect(wrapper.find('[data-slot="collapsible-trigger"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('[data-slot="collapsible-content"]').attributes('hidden')).toBeUndefined()
  })
  it('注入 iframe 开关：切换即标 dirty，保存时 allFrames 跟随（控件换成 ui/switch 后语义不变）', async () => {
    wrapper = await mountEditor()
    const sw = wrapper.find('[role="switch"]')
    expect(sw.attributes('aria-checked')).toBe('true')
    await sw.trigger('click')
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([true])
    await saveBtn().trigger('click')
    await flushPromises()
    const [, , opts] = save.mock.calls[0] as unknown as Parameters<typeof save>
    expect((opts as { config: { allFrames: boolean } }).config.allFrames).toBe(false)
  })
})

describe('UserscriptEditorPanel dirty 上报（宿主关标签前确认的依据）', () => {
  it('初始无 dirty 上报；编辑名称后 emit dirty true 且头部出现未保存标记', async () => {
    wrapper = await mountEditor()
    expect(wrapper.emitted('dirty')).toBeUndefined()
    expect(wrapper.text()).not.toContain('有未保存改动')

    await wrapper.find('input[data-slot="input"]').setValue('改名')
    expect(wrapper.emitted('dirty')).toEqual([[true]])
    expect(wrapper.text()).toContain('有未保存改动')
  })
})

describe('UserscriptEditorPanel 统一保存链路', () => {
  it('matches 为空时前端拦截：显示错误、不触发保存（正确定位保存按钮）', async () => {
    wrapper = await mountEditor()
    await inputs()[1]!.setValue('   ')
    await saveBtn().trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('保存失败：匹配规则（matches）至少填写一条')
    expect(save).not.toHaveBeenCalled()
  })

  it('保存成功：save（code + config 表单解析 + note）→ 提示条含刷新提示 → dirty 归零', async () => {
    wrapper = await mountEditor()
    await inputs()[0]!.setValue('新名字')
    await inputs()[1]!.setValue('https://b.example/*, https://c.example/*')
    await inputs()[5]!.setValue('第一次改')
    await saveBtn().trigger('click')
    await flushPromises()

    expect(save).toHaveBeenCalledTimes(1)
    const [uuid, code, opts] = save.mock.calls[0] as unknown as Parameters<typeof save>
    expect(uuid).toBe(UUID)
    expect(code).toBe(CODE)
    expect(opts).toEqual({
      name: '新名字',
      config: {
        matches: ['https://b.example/*', 'https://c.example/*'],
        excludeMatches: undefined,
        includeGlobs: undefined,
        excludeGlobs: undefined,
        allFrames: true,
        runAt: 'document_end',
      },
      note: '第一次改',
    })
    expect(wrapper.text()).toContain('已保存并重新注册。目标页面刷新后生效。')
    // dirty 归零（宿主可无确认关标签）+ 头部显示名跟随表单 + 备注清空
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([false])
    expect(wrapper.text()).not.toContain('有未保存改动')
    expect(wrapper.text()).toContain('新名字')
    expect(inputs()[5]!.element.value).toBe('')
  })

  it('注册失败：保存仍成功（dirty 归零），提示条带失败原因与引导入口信号', async () => {
    wrapper = await mountEditor()
    await inputs()[0]!.setValue('改过名')
    save.mockResolvedValue({ registerError: '未开启 Allow User Scripts' })
    await saveBtn().trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('已保存，但注册失败，脚本不会注入页面：未开启 Allow User Scripts')
    // 保存恒成功：源码已保存 → dirty 归零（宿主可关标签，不丢内容）
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([false])
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
