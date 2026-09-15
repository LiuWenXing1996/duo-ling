// 层 4 组件测试：UserscriptEditorPanel.vue（编辑器标签页的保存 / 关闭确认逻辑）。
// 只验证交互逻辑，不测样式：加载渲染、dirty 上报（宿主关标签前确认的依据）、
// 保存链路（matches 必填拦截 / 构建失败不落盘 / 保存成功回写 baseline）、草稿恢复与丢弃。
// 边界 mock：ui-client（IPC 客户端）、文件树子组件；CodeMirror 用真实实现（happy-dom 可跑）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UserscriptEditorPanel from './UserscriptEditorPanel.vue'
import type { ScriptProject } from '@/lib/userscripts/types'
import type { BuildResult } from '@/lib/userscripts/offscreen-build-commands'
import type { UsHistoryTree } from '@/lib/userscripts/us-git'

const getProject = vi.hoisted(() => vi.fn())
const updateFiles = vi.hoisted(() => vi.fn())
const build = vi.hoisted(() => vi.fn())
const readDraft = vi.hoisted(() => vi.fn())
const writeDraft = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: { getProject, updateFiles },
  aiFsClient: { readDraft, writeDraft },
  aiBuildClient: { build },
}))

vi.mock('@/components/ai-elements/file-tree', () => ({
  FileTree: {
    name: 'FileTree',
    props: ['defaultExpanded', 'selectedPath'],
    template: '<div class="mock-file-tree"><slot /></div>',
  },
  FileTreeFile: { name: 'FileTreeFile', template: '<div />' },
  FileTreeFolder: { name: 'FileTreeFolder', template: '<div><slot /></div>' },
}))

vi.mock('@/components/userscript/UserscriptTreeNode.vue', () => ({
  default: { name: 'UserscriptTreeNode', props: ['node', 'entry'], template: '<div />' },
}))

const UUID = 'test-uuid-1'

const project: ScriptProject = {
  v: 1,
  uuid: UUID,
  name: '测试脚本',
  enabled: true,
  config: { matches: ['https://a.example/*'], allFrames: true, runAt: 'document_end' },
  files: { 'main.js': 'console.log(1)' },
  entry: 'main.js',
  createdAt: 0,
  updatedAt: 0,
}

const buildOutcome = (files: Record<string, string> = project.files) => ({
  status: 'ok',
  outcome: { code: 'compiled-code', files, remoteFetched: [] },
}) satisfies BuildResult

let wrapper: VueWrapper

async function mountEditor(): Promise<VueWrapper> {
  const w = mount(UserscriptEditorPanel, { props: { uuid: UUID } })
  await flushPromises()
  return w
}

// 表单输入定位（模板顺序固定）：0 脚本名称 / 1 matches / 5 保存备注
const inputs = (): DOMWrapper<HTMLInputElement>[] =>
  [...wrapper.element.querySelectorAll('input[type="text"]')].map(
    (el) => new DOMWrapper<HTMLInputElement>(el as HTMLInputElement),
  )

beforeEach(() => {
  vi.clearAllMocks()
  getProject.mockResolvedValue(project)
  readDraft.mockResolvedValue(null)
  writeDraft.mockResolvedValue(undefined)
  updateFiles.mockResolvedValue({})
  build.mockResolvedValue(buildOutcome())
})

afterEach(() => {
  wrapper?.unmount()
  vi.useRealTimers()
})

describe('UserscriptEditorPanel 加载与渲染', () => {
  it('加载后渲染脚本名 / 文件数 / 入口', async () => {
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('测试脚本')
    expect(wrapper.text()).toContain('1 个文件 · 入口 main.js')
  })

  it('getProject 失败时展示错误条', async () => {
    getProject.mockRejectedValue(new Error('项目不存在或为已弃用旧记录'))
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('读取项目失败：项目不存在或为已弃用旧记录')
  })
})

describe('UserscriptEditorPanel dirty 上报（宿主关标签前确认的依据）', () => {
  it('初始无 dirty 上报；编辑名称后 emit dirty true 且头部出现未保存标记', async () => {
    wrapper = await mountEditor()
    expect(wrapper.emitted('dirty')).toBeUndefined()
    expect(wrapper.text()).not.toContain('有未保存改动')

    await wrapper.find('input[type="text"]').setValue('改名')
    expect(wrapper.emitted('dirty')).toEqual([[true]])
    expect(wrapper.text()).toContain('有未保存改动')
  })
})

describe('UserscriptEditorPanel 保存链路', () => {
  it('matches 为空时前端拦截：显示错误、不触发构建与落盘', async () => {
    wrapper = await mountEditor()
    await inputs()[1]!.setValue('')
    await wrapper.find('button[type="button"]:not([disabled])').trigger('click') // 找到保存按钮见下
  })

  it('matches 为空时前端拦截：显示错误、不触发构建与落盘（正确定位保存按钮）', async () => {
    wrapper = await mountEditor()
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存并重新注册')!
    await inputs()[1]!.setValue('   ')
    await saveBtn.trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('保存失败：匹配规则（matches）至少填写一条')
    expect(build).not.toHaveBeenCalled()
    expect(updateFiles).not.toHaveBeenCalled()
  })

  it('保存成功：构建 → updateFiles（config 表单解析 + note）→ 提示条 → dirty 归零', async () => {
    wrapper = await mountEditor()
    await inputs()[0]!.setValue('新名字')
    await inputs()[1]!.setValue('https://b.example/*, https://c.example/*')
    await inputs()[5]!.setValue('第一次改')
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存并重新注册')!
    await saveBtn.trigger('click')
    await flushPromises()

    expect(build).toHaveBeenCalledWith(project.files, 'main.js')
    expect(updateFiles).toHaveBeenCalledTimes(1)
    const [uuid, files, entry, bundle, opts] = updateFiles.mock.calls[0] as unknown as Parameters<
      typeof updateFiles
    >
    expect(uuid).toBe(UUID)
    expect(files).toEqual(project.files)
    expect(entry).toBe('main.js')
    expect(bundle).toEqual({ code: 'compiled-code', builtAt: expect.any(Number) })
    expect(opts).toEqual({
      name: '新名字',
      config: {
        matches: ['https://b.example/*', 'https://c.example/*'],
        allFrames: true,
        runAt: 'document_end',
      },
      note: '第一次改',
    })
    expect(wrapper.text()).toContain('已保存并重新注册。')
    // dirty 归零（宿主可无确认关标签）+ 头部显示名跟随表单 + 备注清空
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([false])
    expect(wrapper.text()).not.toContain('有未保存改动')
    expect(wrapper.text()).toContain('新名字')
    expect(inputs()[5]!.element.value).toBe('')
  })

  it('构建失败（buildError）：issues 行内展示、不落盘、保持 dirty', async () => {
    wrapper = await mountEditor()
    // 先制造一次真实编辑（dirty=true），保存被构建拦下后 dirty 必须仍在
    await inputs()[0]!.setValue('改过名')
    build.mockResolvedValue({ status: 'buildError', issues: ['main.js:1:1  Unexpected token'] })
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存并重新注册')!
    await saveBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('构建失败（1 处），未保存：')
    expect(wrapper.text()).toContain('main.js:1:1  Unexpected token')
    expect(updateFiles).not.toHaveBeenCalled()
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([true])
  })

  it('构建中禁用保存按钮（防双击重复提交）', async () => {
    let resolveBuild!: (r: BuildResult) => void
    build.mockReturnValue(new Promise<BuildResult>((r) => (resolveBuild = r)))
    wrapper = await mountEditor()
    const saveBtn = wrapper.findAll('button').find((b) => b.text() === '保存并重新注册')!
    await saveBtn.trigger('click')
    expect(wrapper.text()).toContain('构建中…')
    expect(saveBtn.attributes('disabled')).toBeDefined()
    resolveBuild(buildOutcome())
    await flushPromises()
  })
})

describe('UserscriptEditorPanel 草稿恢复与丢弃', () => {
  const draft: UsHistoryTree = {
    meta: {
      name: '草稿名',
      config: { matches: ['https://a.example/*'], allFrames: true, runAt: 'document_end' },
      entry: 'main.js',
    },
    files: [{ path: 'main.js', content: 'draft content' }],
  }

  it('有草稿且与已保存不等：静默恢复 + 琥珀提示条 + dirty true', async () => {
    readDraft.mockResolvedValue(draft)
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('检测到上次会话未保存的草稿，已自动恢复。')
    expect(wrapper.text()).toContain('有未保存改动')
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([true])
  })

  it('草稿与已保存一致时不提示（draftEquals 判据）', async () => {
    readDraft.mockResolvedValue({
      meta: { name: project.name, config: project.config, entry: project.entry },
      files: [{ path: 'main.js', content: project.files['main.js']! }],
    })
    wrapper = await mountEditor()
    expect(wrapper.text()).not.toContain('已自动恢复')
    expect(wrapper.emitted('dirty')).toBeUndefined()
  })

  it('读草稿失败按无草稿处理（best-effort，不挡打开）', async () => {
    readDraft.mockRejectedValue(new Error('timeout'))
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('测试脚本')
    expect(wrapper.emitted('dirty')).toBeUndefined()
  })

  it('丢弃草稿：先用 baseline 重写工作区，成功后才回滚编辑态并清除 dirty', async () => {
    readDraft.mockResolvedValue(draft)
    wrapper = await mountEditor()
    writeDraft.mockClear()

    const discardBtn = wrapper.findAll('button').find((b) => b.text() === '丢弃草稿')!
    await discardBtn.trigger('click')
    await flushPromises()

    // 写工作区用 baseline（状态库已保存内容），不是当前编辑态
    expect(writeDraft).toHaveBeenCalledWith(UUID, project)
    expect(wrapper.text()).not.toContain('已自动恢复')
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([false])
    expect(wrapper.text()).not.toContain('有未保存改动')
  })

  it('丢弃草稿失败：工作区没回退就不动编辑态，错误条提示可重试', async () => {
    readDraft.mockResolvedValue(draft)
    wrapper = await mountEditor()
    writeDraft.mockClear()
    writeDraft.mockRejectedValue(new Error('ipc down'))

    const discardBtn = wrapper.findAll('button').find((b) => b.text() === '丢弃草稿')!
    await discardBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('丢弃草稿失败，可稍后重试：ipc down')
    // 编辑态仍是草稿内容 → dirty 保持 true，不欺骗宿主
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([true])
  })
})
