// UI 组件测试：LfsBrowserPanel.vue 的脚本仓目录名展示。
// 只验证「/uscripts/<uuid> 目录在 uuid 后追加脚本名」这一条展示规则，以及
// 名称取不到时不影响整棵树（附注失败不升级为读取失败）。
// 边界 mock：ui-client（IPC 客户端）、file-tree 套件（渲染 name，便于断言）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import LfsBrowserPanel from './LfsBrowserPanel.vue'
import type { LfsNode } from '@/lib/userscripts/us-fs'
import type { ScriptSummary } from '@/lib/userscripts/types'

const lfsTree = vi.hoisted(() => vi.fn())
const list = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  fsClient: { lfsTree, lfsReadFile: vi.fn() },
  userscriptClient: { list },
}))

vi.mock('@/components/ai-elements/file-tree', () => ({
  FileTree: { name: 'FileTree', template: '<div><slot /></div>' },
  // 目录名走 name 插槽（真实组件默认渲染 props.name），故 mock 要保留插槽语义
  FileTreeFolder: {
    name: 'FileTreeFolder',
    props: ['path', 'name'],
    template: '<div class="mock-folder"><slot name="name">{{ name }}</slot><slot /></div>',
  },
  FileTreeFile: { name: 'FileTreeFile', props: ['path', 'name'], template: '<div />' },
  FileTreeIcon: { name: 'FileTreeIcon', template: '<div><slot /></div>' },
  FileTreeName: { name: 'FileTreeName', template: '<span><slot /></span>' },
}))

vi.mock('@/components/ai-elements/code-block', () => ({
  CodeBlockContent: { name: 'CodeBlockContent', props: ['code', 'language'], template: '<pre />' },
}))

/** 最小树：一个命名的脚本仓 + 一个已无项目记录的孤儿仓（只有 uuid） */
const tree: LfsNode = {
  path: '/',
  name: 'lfs 根',
  type: 'folder',
  children: [
    {
      path: '/uscripts',
      name: 'uscripts',
      type: 'folder',
      children: [
        { path: '/uscripts/u-1', name: 'u-1', type: 'folder', children: [] },
        { path: '/uscripts/orphan', name: 'orphan', type: 'folder', children: [] },
      ],
    },
  ],
}

const summary = (uuid: string, name: string): ScriptSummary => ({
  uuid,
  name,
  enabled: true,
  matches: [],
  fileCount: 0,
  updatedAt: 0,
  buildOk: true,
})

let wrapper: VueWrapper

async function mountPanel(): Promise<VueWrapper> {
  const w = mount(LfsBrowserPanel)
  await flushPromises()
  return w
}

beforeEach(() => {
  vi.clearAllMocks()
  lfsTree.mockResolvedValue(tree)
  list.mockResolvedValue([summary('u-1', '登录助手')])
})

afterEach(() => {
  wrapper?.unmount()
})

describe('LfsBrowserPanel 脚本仓目录名', () => {
  // 目录节点在 DOM 中的顺序固定：0 根 / 1 uscripts / 2 命名仓 / 3 孤儿仓
  const folders = () => wrapper.findAll('.mock-folder')

  it('脚本仓目录用徽标显示脚本名、uuid 作次要文字；无项目记录的仓保持纯目录名', async () => {
    wrapper = await mountPanel()
    const repo = folders()[2]!
    expect(repo.find('[data-slot="badge"]').text()).toBe('登录助手')
    expect(repo.text()).toContain('u-1')
    expect(folders()[3]!.text()).toBe('orphan')
    expect(folders()[3]!.find('[data-slot="badge"]').exists()).toBe(false)
  })

  it('取脚本名失败只丢徽标：树正常渲染、不出错误条', async () => {
    list.mockRejectedValue(new Error('background 无响应'))
    wrapper = await mountPanel()
    expect(folders()[2]!.text()).toBe('u-1')
    expect(folders()[2]!.find('[data-slot="badge"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('读取失败')
  })
})
