// UI 组件测试：UserscriptEditorPanel.vue（编辑器标签页的加载 / 保存 / 关闭确认逻辑）。
// 数据流（2026-09-20 单文件化后）：元数据走 userscriptClient.getProject（状态库），
// 源码走 fsClient.read（duoling-fs 工作树，单文件 Source = { code }）；配置全部由源码里的
// // ==UserScript== 块决定，编辑器不暴露配置表单——保存只传 { note }。
// 只验证交互逻辑：加载渲染、统一保存链路（note 传入 / 保存成功回写 / 注册失败提示 / 保存中禁用）。
// 边界 mock：ui-client（IPC 客户端）；CodeMirror 用真实实现（happy-dom 可跑）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UserscriptEditorPanel from './UserscriptEditorPanel.vue'
import { EditorView } from '@codemirror/view'
import type { ScriptProject } from '@/lib/userscripts/types'
import type { Source } from '@/lib/userscripts/us-git'

const getProject = vi.hoisted(() => vi.fn())
const save = vi.hoisted(() => vi.fn())
const read = vi.hoisted(() => vi.fn())
const availability = vi.hoisted(() => vi.fn())
const subscribeAvailability = vi.hoisted(() => vi.fn())

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: { getProject, save, availability },
  fsClient: { read },
  // 编辑器订阅引擎可用性（决定注册失败时给不给「去开权限」引导入口）
  subscribeAvailability,
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

// 底栏备注输入框已挪进保存弹窗（见 saveViaDialog 里的 aria-label="保存备注"）

const saveBtn = () => wrapper.findAll('button').find((b) => b.text() === '保存')!

/** 弹窗（teleport 到 body）里的按钮：按文本精确匹配，排除组件根内的按钮 */
function portalButton(text: string): HTMLButtonElement {
  const btn = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => !wrapper.element.contains(b) && b.textContent?.trim() === text,
  )
  if (!btn) throw new Error(`弹窗里没找到按钮「${text}」`)
  return btn
}

/** 完整走一次保存：底栏「保存」→（可选）填备注 → 弹窗「保存」 */
async function saveViaDialog(note?: string): Promise<void> {
  await saveBtn().trigger('click')
  await flushPromises()

  if (note) {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="保存备注"]')
    if (!input) throw new Error('弹窗里没找到备注输入框')
    input.value = note
    input.dispatchEvent(new Event('input'))
    await flushPromises()
  }

  portalButton('保存').click()
  await flushPromises()
}

/**
 * 在编辑器里改掉源码。保存链路只在「内容与已保存版本不同」时才真正发请求——无改动点保存
 * 会被就地拦下（提示条说明未生成新版本），故保存类用例都要先过一次这里。
 * 走真实 CodeMirror 实例：EditorView.findFromDOM 从渲染出的 .cm-content 反查。
 */
async function typeCode(next: string): Promise<void> {
  const dom = wrapper.element.querySelector('.cm-content') as HTMLElement | null
  const view = dom ? EditorView.findFromDOM(dom) : null
  if (!view) throw new Error('没找到 CodeMirror 实例')
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } })
  // 必须等一轮渲染：保存按钮的 disabled 由 canSave（内容对比）算出来，不等就点到灰按钮 —— 什么都不会发生
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
  getProject.mockResolvedValue(project)
  read.mockResolvedValue(headSource)
  save.mockResolvedValue(saveOk())
  availability.mockResolvedValue({
    available: true,
    isFirefox: false,
    chromeMajor: 138,
    guideText: '',
  })
  subscribeAvailability.mockReturnValue(() => {})
})

afterEach(() => {
  wrapper?.unmount()
  vi.useRealTimers()
})

describe('UserscriptEditorPanel 加载与渲染', () => {
  it('加载后渲染脚本名与单文件标识，并把名字回报给宿主（标签标题跟随）', async () => {
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('测试脚本')
    expect(wrapper.text()).toContain('单文件脚本')
    expect(wrapper.emitted('nameChange')).toEqual([['测试脚本']])
  })

  it('getProject 失败时展示错误条', async () => {
    getProject.mockRejectedValue(new Error('脚本不存在'))
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('读取失败：脚本不存在')
  })

  it('源码读取失败（fs:read 抛错）展示读不到源码，不挡渲染', async () => {
    read.mockRejectedValue(new Error('ipc down'))
    wrapper = await mountEditor()
    expect(wrapper.text()).toContain('读取失败：脚本源码读不到')
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
    await typeCode('console.log(2)')
    await saveViaDialog()

    expect(save).toHaveBeenCalledTimes(1)
    const [uuid, code, opts] = save.mock.calls[0] as unknown as Parameters<typeof save>
    expect(uuid).toBe(UUID)
    expect(code).toBe('console.log(2)')
    expect(opts).toEqual({ note: '' })
    expect(wrapper.text()).toContain('已保存，目标页面刷新后生效。')
    expect(wrapper.text()).not.toContain('有未保存改动')
  })

  it('没有改动时保存按钮是灰的（不必点一下才知道没变化）', async () => {
    wrapper = await mountEditor()
    expect(saveBtn().attributes('disabled')).toBeDefined()
    expect(save).not.toHaveBeenCalled()
  })

  it('改字后按钮变亮；改回原样又变灰', async () => {
    wrapper = await mountEditor()
    expect(saveBtn().attributes('disabled')).toBeDefined()

    await typeCode('console.log(2)')
    await flushPromises()
    expect(saveBtn().attributes('disabled')).toBeUndefined()

    await typeCode(CODE)
    await flushPromises()
    expect(saveBtn().attributes('disabled')).toBeDefined()
    expect(save).not.toHaveBeenCalled()
  })

  it('停用中的脚本保存：不谎报「已重新注册」', async () => {
    getProject.mockResolvedValue({ ...project, enabled: false })
    wrapper = await mountEditor()
    await typeCode('console.log(3)')
    await saveViaDialog()
    expect(wrapper.text()).toContain('已保存。脚本处于停用状态，启用后才会注入页面。')
  })

  it('注册失败且引擎不可用：给出「查看开启引导」入口', async () => {
    availability.mockResolvedValue({
      available: false,
      isFirefox: false,
      chromeMajor: 138,
      guideText: '去开权限',
    })
    save.mockResolvedValue({ registerError: '未开启 Allow User Scripts' })
    wrapper = await mountEditor()
    await typeCode('console.log(4)')
    await saveViaDialog()
    expect(wrapper.text()).toContain('查看开启引导')
  })

  it('注册失败但引擎可用（matches 之类）：不给权限引导入口', async () => {
    save.mockResolvedValue({ registerError: '脚本缺少匹配规则（matches），不会在任何页面运行' })
    wrapper = await mountEditor()
    await typeCode('console.log(5)')
    await saveViaDialog()
    expect(wrapper.text()).toContain('脚本缺少匹配规则')
    expect(wrapper.text()).not.toContain('查看开启引导')
  })

  it('保存备注：弹窗里填的备注记入本次保存的 note', async () => {
    wrapper = await mountEditor()
    await typeCode('console.log(6)')
    await saveViaDialog('第一次改')
    const [, , opts] = save.mock.calls[0] as unknown as Parameters<typeof save>
    expect(opts).toEqual({ note: '第一次改' })
  })

  it('点保存先开备注弹窗，此时还没有发保存请求', async () => {
    wrapper = await mountEditor()
    await typeCode('console.log(9)')
    await saveBtn().trigger('click')
    await flushPromises()

    expect(document.body.textContent).toContain('保存这一版？')
    expect(document.querySelector('input[aria-label="保存备注"]')).not.toBeNull()
    expect(save).not.toHaveBeenCalled() // 弹窗里确认后才真正保存

    portalButton('保存').click()
    await flushPromises()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('注册失败：保存仍成功，提示条带失败原因', async () => {
    wrapper = await mountEditor()
    await typeCode('console.log(7)')
    save.mockResolvedValue({ registerError: '未开启 Allow User Scripts' })
    await saveViaDialog()
    expect(wrapper.text()).toContain(
      '已保存，但脚本没能生效：未开启 Allow User Scripts',
    )
  })

  it('保存中禁用保存按钮（防双击重复提交）', async () => {
    let resolveSave!: (r: unknown) => void
    save.mockReturnValue(new Promise((r) => (resolveSave = r)))
    wrapper = await mountEditor()
    await typeCode('console.log(8)')
    await saveViaDialog()
    expect(wrapper.text()).toContain('保存中…')
    // saving 期间按钮文字变为「保存中…」，按新文字定位并断言禁用
    const savingBtn = wrapper.findAll('button').find((b) => b.text() === '保存中…')!
    expect(savingBtn.attributes('disabled')).toBeDefined()
    resolveSave(saveOk())
    await flushPromises()
  })
})
