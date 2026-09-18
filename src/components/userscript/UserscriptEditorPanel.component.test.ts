// UI 组件测试：UserscriptEditorPanel.vue（编辑器标签页的保存 / 关闭确认逻辑）。
// 只验证交互逻辑，不测样式：加载渲染、dirty 上报（宿主关标签前确认的依据）、
// 保存链路（matches 必填拦截 / 构建失败不落盘 / 保存成功回写 baseline）、草稿恢复与丢弃。
// 边界 mock：ui-client（IPC 客户端）、文件树子组件；CodeMirror 用真实实现（happy-dom 可跑）。
// 数据流（2026-09-19 存储重构后）：元数据走 userscriptClient.getProject（状态库），
// 源码一律走 fsClient.readTree（duoling-fs 工作区 / HEAD），草稿 = 工作区相对 HEAD 的未提交改动。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DOMWrapper, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UserscriptEditorPanel from './UserscriptEditorPanel.vue'
import type { ScriptProject } from '@/lib/userscripts/types'
import type { SourceTree } from '@/lib/userscripts/us-git'
import type { BuildResult } from '@/lib/userscripts/offscreen-build-commands'

const getProject = vi.hoisted(() => vi.fn())
const updateFiles = vi.hoisted(() => vi.fn())
const build = vi.hoisted(() => vi.fn())
const readTree = vi.hoisted(() => vi.fn())
const writeFiles = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: { getProject, updateFiles },
  fsClient: { readTree, writeFiles },
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
  entry: 'main.js',
  fileCount: 1,
  createdAt: 0,
  updatedAt: 0,
}

/** HEAD 已保存源码树（fs:readTree committed=true 的应答） */
const headTree: SourceTree = {
  meta: { name: project.name, config: project.config, entry: 'main.js', createdAt: 0 },
  files: { 'main.js': 'console.log(1)' },
}

const buildOutcome = (files: Record<string, string> = headTree.files) => ({
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
  // 默认工作区与 HEAD 一致（无草稿）；草稿场景在用例内用 mockImplementation 按 committed 分流
  readTree.mockResolvedValue(headTree)
  writeFiles.mockResolvedValue(undefined)
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
    getProject.mockRejectedValue(new Error('脚本不存在'))
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('读取项目失败：脚本不存在')
  })

  it('源码读取失败（fs:readTree 抛错）展示「源码缺失」，不挡渲染', async () => {
    readTree.mockRejectedValue(new Error('ipc down'))
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('读取项目失败：源码缺失')
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

    expect(build).toHaveBeenCalledWith(headTree.files, 'main.js')
    expect(updateFiles).toHaveBeenCalledTimes(1)
    const [uuid, files, entry, bundle, opts] = updateFiles.mock.calls[0] as unknown as Parameters<
      typeof updateFiles
    >
    expect(uuid).toBe(UUID)
    expect(files).toEqual(headTree.files)
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
  /** 工作区草稿（相对 HEAD 有差异：名字与内容都改过） */
  const draftTree: SourceTree = {
    meta: {
      name: '草稿名',
      config: { matches: ['https://a.example/*'], allFrames: true, runAt: 'document_end' },
      entry: 'main.js',
      createdAt: 0,
    },
    files: { 'main.js': 'draft content' },
  }

  function draftScenario(): void {
    readTree.mockImplementation((_uuid: string, committed?: boolean) =>
      Promise.resolve(committed ? headTree : draftTree),
    )
  }

  it('工作区与 HEAD 有差异 = 有草稿：静默恢复 + 琥珀提示条 + dirty true', async () => {
    draftScenario()
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('检测到上次会话未保存的草稿，已自动恢复。')
    expect(wrapper.text()).toContain('有未保存改动')
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([true])
  })

  it('工作区与 HEAD 一致时不提示（treeEquals 判据）', async () => {
    wrapper = await mountEditor()
    expect(wrapper.text()).not.toContain('已自动恢复')
    expect(wrapper.emitted('dirty')).toBeUndefined()
  })

  it('丢弃草稿：先用 baseline（HEAD）重写工作区，成功后才回滚编辑态并清除 dirty', async () => {
    draftScenario()
    wrapper = await mountEditor()
    writeFiles.mockClear()

    const discardBtn = wrapper.findAll('button').find((b) => b.text() === '丢弃草稿')!
    await discardBtn.trigger('click')
    await flushPromises()

    // 写工作区用 baseline（HEAD 已保存内容），不是当前编辑态
    expect(writeFiles).toHaveBeenCalledWith(UUID, headTree.files, headTree.meta)
    expect(wrapper.text()).not.toContain('已自动恢复')
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([false])
    expect(wrapper.text()).not.toContain('有未保存改动')
  })

  it('丢弃草稿失败：工作区没回退就不动编辑态，错误条提示可重试', async () => {
    draftScenario()
    wrapper = await mountEditor()
    writeFiles.mockClear()
    writeFiles.mockRejectedValue(new Error('ipc down'))

    const discardBtn = wrapper.findAll('button').find((b) => b.text() === '丢弃草稿')!
    await discardBtn.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('丢弃草稿失败，可稍后重试：ipc down')
    // 编辑态仍是草稿内容 → dirty 保持 true，不欺骗宿主
    expect(wrapper.emitted('dirty')!.at(-1)).toEqual([true])
  })
})
