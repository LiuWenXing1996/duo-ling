// UI 组件测试：LfsBrowserPanel.vue 的脚本仓目录名展示 + 右栏预览分档。
// 前者验证「/uscripts/<uuid> 目录在 uuid 后追加脚本名」这一条展示规则，以及
// 名称取不到时不影响整棵树（附注失败不升级为读取失败）；
// 后者验证二进制按图片 / 非图片分流（图片渲染 <img>，解不出才退回提示）。
// 边界 mock：ui-client（IPC 客户端）、file-tree 套件（渲染 name，便于断言；另给一个提交选中项的按钮）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import LfsBrowserPanel from './LfsBrowserPanel.vue'
import type { LfsFileContent, LfsNode } from '@duoling/shared'
import type { ScriptSummary } from '@/lib/userscripts/types'

const lfsTree = vi.hoisted(() => vi.fn())
const list = vi.hoisted(() => vi.fn())
const lfsReadFile = vi.hoisted(() => vi.fn())
/** 假 file-tree 的「点选」入口：测试改它、再点一次按钮，即等价于用户在树里选了某个文件 */
const pick = vi.hoisted(() => ({ path: '' }))

vi.mock('@/lib/userscripts/ui-client', () => ({
  offscreenService: { fsLfsTree: lfsTree, fsLfsReadFile: lfsReadFile },
  userscriptClient: { list },
}))

vi.mock('@/components/ai-elements/file-tree', () => ({
  FileTree: {
    name: 'FileTree',
    emits: ['update:selectedPath'],
    // 用 setup 而非 methods：methods 里访问 this.$emit 在 vue-tsc 下没有类型
    setup(_props: unknown, { emit }: { emit: (event: string, path: string) => void }) {
      return { pick: (): void => emit('update:selectedPath', pick.path) }
    },
    template: '<div><button class="mock-pick" @click="pick"><slot /></button></div>',
  },
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

/**
 * 最小树：一个命名的脚本仓 + 一个已无项目记录的孤儿仓（只有 uuid）。
 * u-1 下挂两个文件供预览断言：一张图（按扩展名分流到 <img>）与一个非图片二进制（走提示）。
 */
const tree: LfsNode = {
  path: '/',
  name: '根目录',
  type: 'folder',
  children: [
    {
      path: '/uscripts',
      name: 'uscripts',
      type: 'folder',
      children: [
        {
          path: '/uscripts/u-1',
          name: 'u-1',
          type: 'folder',
          children: [
            { path: '/uscripts/u-1/shot.png', name: 'shot.png', type: 'file', size: 3 },
            { path: '/uscripts/u-1/objects/9f', name: '9f', type: 'file', size: 40 },
          ],
        },
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
  savedAt: 0,
  group: '',
})

let wrapper: VueWrapper

async function mountPanel(): Promise<VueWrapper> {
  const w = mount(LfsBrowserPanel)
  await flushPromises()
  return w
}

beforeEach(() => {
  vi.clearAllMocks()
  pick.path = ''
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
    list.mockRejectedValue(new Error('扩展服务未响应，请重试'))
    wrapper = await mountPanel()
    expect(folders()[2]!.text()).toBe('u-1')
    expect(folders()[2]!.find('[data-slot="badge"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('读取失败')
  })
})

describe('LfsBrowserPanel 右栏预览分档', () => {
  /** 二进制读回的形状：content 是 base64（图片与非图片在这一点上没有区别，分流看扩展名） */
  const binaryFile = (path: string, content = 'AAAA'): LfsFileContent => ({
    path,
    size: 3,
    read: 3,
    truncated: false,
    encoding: 'base64',
    binary: true,
    content,
  })

  /** 走真实路径选中一个文件：点树里的按钮 → FileTree 抛 update:selectedPath → watch 拉内容 */
  async function selectFile(path: string): Promise<VueWrapper> {
    const w = await mountPanel()
    pick.path = path
    await w.find('.mock-pick').trigger('click')
    await flushPromises()
    return w
  }

  it('图片文件画出来：base64 拼成 data: URL 交给 <img>', async () => {
    lfsReadFile.mockResolvedValue(binaryFile('/uscripts/u-1/shot.png'))
    wrapper = await selectFile('/uscripts/u-1/shot.png')
    expect(wrapper.find('img').attributes('src')).toBe('data:image/png;base64,AAAA')
    expect(wrapper.text()).not.toContain('不支持预览')
  })

  it('非图片二进制维持提示：不画 <img>，也不把它说成图片', async () => {
    lfsReadFile.mockResolvedValue(binaryFile('/uscripts/u-1/objects/9f'))
    wrapper = await selectFile('/uscripts/u-1/objects/9f')
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('二进制文件')
    expect(wrapper.text()).toContain('不支持预览')
  })

  it('图片解不出时退回提示，并说清是「图片」而不是「二进制文件」', async () => {
    lfsReadFile.mockResolvedValue(binaryFile('/uscripts/u-1/shot.png'))
    wrapper = await selectFile('/uscripts/u-1/shot.png')
    await wrapper.find('img').trigger('error')
    await flushPromises()
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.text()).toContain('图片无法显示')
  })
})
