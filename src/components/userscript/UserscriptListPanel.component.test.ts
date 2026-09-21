// UI 组件测试：UserscriptListPanel.vue 的两组易回归语义。
//
// A. **列表不承载报错展示**：报错属历史信息，由独立「错误日志」标签页承载，
//    脚本列表本身不展示任何脚本报错 —— 环境级问题（引擎不可用）只靠 availability 横幅一处兜底。
// B. **新建脚本动线**：新建**不**跳编辑器（不 emit edit），改为在该行标「刚新建」，
//    点该行「编辑」进过一次即摘标。
//    注：A 与 B 在「注册失败要不要告不告诉用户」上交过锋 —— 结论是**不告**（见下方 B 组第 3 条）。
// C. **从路径导入**：路径归一 → fetch 读字节 → 与文件选择器共用同一条导入动线；
//    路径非法 / 读到非 zip / 开关未开三类失败各给人话原因，且**都不该走到 importZip**。
// 边界 mock：ui-client（IPC 客户端）+ 全局 fetch（路径导入要读 file://）；按钮 / 弹窗 / 开关用真实 shadcn 组件。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import UserscriptListPanel from './UserscriptListPanel.vue'
import type { ScriptSummary, UserScriptsAvailability } from '@/lib/userscripts/types'

const list = vi.hoisted(() => vi.fn())
const errors = vi.hoisted(() => vi.fn())
const availability = vi.hoisted(() => vi.fn())
const create = vi.hoisted(() => vi.fn())
const toggle = vi.hoisted(() => vi.fn())
const importZip = vi.hoisted(() => vi.fn())
const groups = vi.hoisted(() => vi.fn())
const setGroup = vi.hoisted(() => vi.fn())
const createGroup = vi.hoisted(() => vi.fn())
const renameGroup = vi.hoisted(() => vi.fn())
const removeGroup = vi.hoisted(() => vi.fn())
const reorderGroups = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())
const subscribeAvailability = vi.hoisted(() =>
  vi.fn((cb: (a: UserScriptsAvailability) => void) => vi.fn()),
)

vi.mock('@/lib/userscripts/ui-client', () => ({
  userscriptClient: {
    list,
    errors,
    availability,
    create,
    toggle,
    getProject: vi.fn(),
    remove: vi.fn(),
    removeAll: vi.fn(),
    importZip,
    groups,
    setGroup,
    createGroup,
    renameGroup,
    removeGroup,
    reorderGroups,
    clearErrors: vi.fn(),
  },
  subscribeAvailability,
}))

const summary = (uuid: string, name: string): ScriptSummary => ({
  uuid,
  name,
  enabled: true,
  matches: ['https://a.example/*'],
  updatedAt: 0,
  group: '',
})

const OK_AVAILABILITY: UserScriptsAvailability = {
  available: true,
  isFirefox: false,
  chromeMajor: 140,
  guideText: '',
}
const ENGINE_OFF: UserScriptsAvailability = {
  available: false,
  isFirefox: false,
  chromeMajor: 140,
  guideText: 'Chrome ≥138：在扩展详情页开启「Allow User Scripts」开关后即可使用。',
}

let wrapper: VueWrapper

async function mountPanel(): Promise<VueWrapper> {
  const w = mount(UserscriptListPanel)
  await flushPromises()
  await flushPromises()
  return w
}

/** 列表行（编辑按钮 → 行容器）：取行内文本 */
function rowText(i: number): string {
  const btn = wrapper.findAll('button[aria-label="编辑脚本"]')[i]
  return btn?.element.closest('.bg-card')?.textContent ?? ''
}

const buttonByText = (text: string) => wrapper.findAll('button').find((b) => b.text() === text)!

/** 行内报错入口（旧行为；新设计不应出现） */
const errorChips = () => wrapper.findAll('button').filter((b) => b.text().includes('条报错'))

// —— 弹窗内容都在 portal 里：reka-ui 的 DialogContent 挂到 document.body，
//    wrapper.findAll 找不到，必须去 document 上按「不在组件根内」筛 ——

/** 弹窗（portal）里的按钮 */
function portalButtons(): HTMLButtonElement[] {
  const root = wrapper.element as HTMLElement
  return [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
    (b) => !root.contains(b),
  )
}

/** 弹窗里文本精确等于 text 的按钮 */
function portalButton(text: string): HTMLButtonElement | undefined {
  return portalButtons().find((b) => b.textContent?.trim() === text)
}

/** 弹窗里的路径输入框。按 `aria-label` 而不是 placeholder 定位 ——
 *  placeholder 是给用户看的示例文案，会反复改（这条通道的提示就改过三轮），
 *  测试跟着它碎等于每次调文案都要修测试；aria-label 同时补上输入框的无障碍名。 */
function pathInput(): HTMLInputElement {
  const root = wrapper.element as HTMLElement
  const el = [...document.querySelectorAll<HTMLInputElement>('input')].find(
    (i) => !root.contains(i) && i.getAttribute('aria-label') === '导入包文件路径',
  )
  if (!el) throw new Error('没找到路径输入框（弹窗没打开？）')
  return el
}

/** 往输入框里打字：v-model 认原生 input 事件；打完要等一轮重渲染 ——
 *  确认按钮的 disabled 依赖 importPath，不等就点，点的是个灰按钮（什么都不会发生）。 */
async function typePath(v: string): Promise<void> {
  const el = pathInput()
  el.value = v
  el.dispatchEvent(new Event('input'))
  await flushPromises()
}

/** 打开「从路径导入」弹窗：菜单用键盘开（happy-dom 下 pointer/click 都开不了，见 README 坑 12） */
async function openPathDialog(): Promise<void> {
  await buttonByText('导入').trigger('keydown', { key: 'ArrowDown' })
  await flushPromises()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
    el.textContent?.includes('输入文件路径'),
  )
  if (!item) throw new Error('菜单里没有「输入文件路径…」')
  item.click()
  await flushPromises()
}

/** zip 魔数开头 / 不是 zip 的两份假字节 */
const zipBytes = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02])
const notZipBytes = () => new Uint8Array([0x3c, 0x21, 0x44, 0x4f])

/** 弹窗是否已关：reka-ui 关闭时先切 `data-state="closed"` 再摘节点，
 *  而退出动画在 happy-dom 里不一定跑得完 —— 两种状态都算「关了」 */
function dialogClosed(): boolean {
  const dlg = document.querySelector('[role="dialog"]')
  return !dlg || dlg.getAttribute('data-state') === 'closed'
}

const okReport = (name = '导入的脚本') => ({
  succeeded: 1,
  failed: 0,
  results: [{ status: 'ok' as const, name, uuid: 'u9' }],
  ignored: [],
})

/** 设置「允许访问文件网址」的探测结果；null = 模拟探测不到（API 缺失） */
function setFileAccessAllowed(v: boolean | null): void {
  const c = globalThis as unknown as { chrome?: { extension?: unknown } }
  if (v === null) {
    if (c.chrome) delete c.chrome.extension
    return
  }
  c.chrome = {
    ...(c.chrome ?? {}),
    extension: { isAllowedFileSchemeAccess: () => v },
  } as typeof c.chrome
}

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue([summary('u1', '已有脚本')])
  errors.mockResolvedValue([])
  availability.mockResolvedValue(OK_AVAILABILITY)
  create.mockResolvedValue({ uuid: 'u2', name: '新建的脚本 1' })
  toggle.mockResolvedValue({})
  importZip.mockResolvedValue(okReport())
  groups.mockResolvedValue([])
  vi.stubGlobal('fetch', fetchMock)
  setFileAccessAllowed(true)
})

afterEach(() => {
  wrapper?.unmount()
  vi.unstubAllGlobals()
  setFileAccessAllowed(null)
})

describe('UserscriptListPanel 不承载报错展示', () => {
  it('挂载后不调用 userscriptClient.errors()（报错展示已迁出列表）', async () => {
    list.mockResolvedValue([summary('u1', '脚本A')])
    wrapper = await mountPanel()
    expect(errors).not.toHaveBeenCalled()
  })

  it('有报错的脚本行也不显示行内入口（报错不按脚本逐条复述，归独立标签页）', async () => {
    list.mockResolvedValue([summary('u1', '脚本A'), summary('u2', '脚本B')])
    wrapper = await mountPanel()
    expect(errorChips()).toHaveLength(0)
  })

  it('启停返回 registerError 时列表不出现 per-script 报错提示', async () => {
    list.mockResolvedValue([summary('u1', '脚本A')])
    toggle.mockResolvedValue({ registerError: 'userScripts 引擎不可用：…' })
    wrapper = await mountPanel()
    expect(errorChips()).toHaveLength(0)

    await wrapper.findComponent({ name: 'SwitchRoot' }).vm.$emit('update:modelValue', false)
    await flushPromises()

    expect(toggle).toHaveBeenCalledWith('u1', false)
    expect(errorChips()).toHaveLength(0)
  })

  it('引擎不可用时只显示 availability 横幅，不为每个脚本挂报错入口', async () => {
    availability.mockResolvedValue(ENGINE_OFF)
    list.mockResolvedValue([summary('u1', '脚本A'), summary('u2', '脚本B')])
    wrapper = await mountPanel()

    expect(wrapper.text()).toContain('用户脚本引擎不可用')
    expect(errorChips()).toHaveLength(0)
  })
})

describe('UserscriptListPanel 横幅自动刷新', () => {
  it('订阅广播：SW 推送 availabilityChanged 时横幅直接更新（无需手动重查）', async () => {
    availability.mockResolvedValue(ENGINE_OFF)
    wrapper = await mountPanel()
    expect(wrapper.text()).toContain('用户脚本引擎不可用')

    // 用户在扩展管理页开了开关 → SW 轮询发现并广播 → 横幅自动消掉
    const cb = subscribeAvailability.mock.calls.at(-1)![0] as (a: UserScriptsAvailability) => void
    cb(OK_AVAILABILITY)
    await flushPromises()
    expect(wrapper.text()).not.toContain('用户脚本引擎不可用')
  })

  it('卸载时退订广播', async () => {
    wrapper = await mountPanel()
    const unsub = subscribeAvailability.mock.results.at(-1)!.value as ReturnType<typeof vi.fn>
    wrapper.unmount()
    expect(unsub).toHaveBeenCalled()
  })
})

describe('UserscriptListPanel 搜索 / 筛选 / 排序', () => {
  const searchInput = () => wrapper.find('input[placeholder="搜索名称或匹配规则…"]')

  it('按名称过滤行，计数行显示「筛选显示 N 个」', async () => {
    list.mockResolvedValue([summary('u1', '脚本A'), summary('u2', '脚本B')])
    wrapper = await mountPanel()
    expect(wrapper.findAll('button[aria-label="编辑脚本"]')).toHaveLength(2)

    await searchInput().setValue('脚本A')
    expect(wrapper.findAll('button[aria-label="编辑脚本"]')).toHaveLength(1)
    expect(rowText(0)).toContain('脚本A')
    expect(wrapper.text()).toContain('筛选显示 1 个')
  })

  it('按匹配规则也能搜到（搜索域含 matches）', async () => {
    list.mockResolvedValue([summary('u1', '脚本A'), summary('u2', '脚本B')])
    wrapper = await mountPanel()
    await searchInput().setValue('a.example')
    expect(wrapper.findAll('button[aria-label="编辑脚本"]')).toHaveLength(2)
  })

  it('状态筛选「已停用」只显示停用脚本', async () => {
    const disabled = { ...summary('u1', '脚本A'), enabled: false }
    list.mockResolvedValue([summary('u2', '脚本B'), disabled])
    wrapper = await mountPanel()

    const chip = wrapper.findAll('button').find((b) => b.text().includes('已停用'))!
    await chip.trigger('click')
    await flushPromises()

    expect(wrapper.findAll('button[aria-label="编辑脚本"]')).toHaveLength(1)
    expect(rowText(0)).toContain('脚本A')
  })

  it('搜索 / 筛选滤空时提示调整条件，而非误导为「还没有脚本」', async () => {
    wrapper = await mountPanel()
    await searchInput().setValue('不存在的脚本')
    expect(wrapper.text()).toContain('没有匹配的脚本')
    expect(wrapper.text()).not.toContain('还没有用户脚本')
  })

  it('默认按更新时间新在前（createdAt 同值时保持原序）', async () => {
    const older = { ...summary('u1', '旧脚本'), updatedAt: 100 }
    const newer = { ...summary('u2', '新脚本'), updatedAt: 200 }
    list.mockResolvedValue([older, newer])
    wrapper = await mountPanel()
    expect(rowText(0)).toContain('新脚本')
    expect(rowText(1)).toContain('旧脚本')
  })
})

describe('UserscriptListPanel 批量操作菜单', () => {
  it('全部停用：只对启用中的脚本逐条 toggle，已停用的不动', async () => {
    const disabled = { ...summary('u1', '脚本A'), enabled: false }
    list.mockResolvedValue([summary('u2', '脚本B'), disabled])
    wrapper = await mountPanel()

    // reka-ui 的菜单在 happy-dom 里只认键盘开（trigger 上发 ArrowDown），内容 portal 到 body —— 去 document 上找菜单项
    await wrapper.find('button[title="批量操作（作用于全部脚本）"]').trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
      el.textContent?.includes('全部停用'),
    )!
    expect(item).toBeDefined()
    item.click()
    await flushPromises()

    expect(toggle).toHaveBeenCalledTimes(1)
    expect(toggle).toHaveBeenCalledWith('u2', false)
    expect(toggle).not.toHaveBeenCalledWith('u1', false)
  })

  it('「批量」菜单是全部类动作的唯一入口（四项齐备，页面上无第二个溢出菜单）', async () => {
    list.mockResolvedValue([summary('u1', '脚本A')])
    wrapper = await mountPanel()

    await wrapper
      .find('button[title="批量操作（作用于全部脚本）"]')
      .trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()

    // reka-ui 的菜单只在被打开时挂载，故这里查到的就是本菜单的项
    const labels = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) =>
      el.textContent?.trim(),
    )
    expect(labels).toEqual(['全部停用', '全部启用', '全部导出', '全部删除'])
    expect(wrapper.find('button[title="更多操作"]').exists()).toBe(false)
  })
})

describe('UserscriptListPanel 卡片布局', () => {
  it('同一张卡片内同时展示匹配规则与元信息（更新时间）', async () => {
    const s = { ...summary('u1', '脚本A'), updatedAt: 1758200000000 }
    list.mockResolvedValue([s])
    wrapper = await mountPanel()
    const card = wrapper.findAll('.bg-card').find((el) => el.text().includes('脚本A'))!
    expect(card.element.textContent).toContain('a.example')
    // 元信息行（更新时间 / 运行统计）存在：本 fixture 无运行统计，只渲染更新时间
    expect(card.element.textContent).not.toBe('')
  })
})

describe('UserscriptListPanel 新建脚本', () => {
  it('新建后不跳编辑器，且该行标「刚新建」（其他行不标）', async () => {
    wrapper = await mountPanel()
    expect(rowText(0)).not.toContain('刚新建')

    // 创建后列表多出这一行
    list.mockResolvedValue([summary('u2', '新建的脚本 1'), summary('u1', '已有脚本')])
    await buttonByText('添加脚本').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('edit')).toBeUndefined()
    expect(rowText(0)).toContain('新建的脚本 1')
    expect(rowText(0)).toContain('刚新建')
    expect(rowText(1)).not.toContain('刚新建')
  })

  it('点该行「编辑」：emit edit，同时摘掉「刚新建」标', async () => {
    wrapper = await mountPanel()
    list.mockResolvedValue([summary('u2', '新建的脚本 1'), summary('u1', '已有脚本')])
    await buttonByText('添加脚本').trigger('click')
    await flushPromises()

    await wrapper.findAll('button[aria-label="编辑脚本"]')[0]!.trigger('click')
    expect(wrapper.emitted('edit')).toEqual([['u2', '新建的脚本 1']])
    expect(rowText(0)).not.toContain('刚新建')
  })

  // 与上游同名的用例不同：上游断言「列表页弹出注册失败警告」，这里断言相反 ——
  // 注册失败**不在列表页报错**（报错属历史信息，归错误日志标签页；环境态由 availability 横幅兜底，
  // 在列表再说一遍是同一件事两次）。数据已落库这一点由「仍然标刚新建」体现。
  it('注册失败仍标「刚新建」，但不在列表页报错（归错误日志标签页）', async () => {
    wrapper = await mountPanel()
    list.mockResolvedValue([summary('u2', '新建的脚本 1'), summary('u1', '已有脚本')])
    create.mockResolvedValue({ uuid: 'u2', name: '新建的脚本 1', registerError: '未开启 Allow User Scripts' })
    await buttonByText('添加脚本').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('edit')).toBeUndefined()
    expect(rowText(0)).toContain('刚新建')
    expect(wrapper.text()).not.toContain('不会注入页面')
  })

  it('刷新列表不摘标（会话内标记，刷新重算的是数据不是这个标）', async () => {
    wrapper = await mountPanel()
    list.mockResolvedValue([summary('u2', '新建的脚本 1'), summary('u1', '已有脚本')])
    await buttonByText('添加脚本').trigger('click')
    await flushPromises()

    await wrapper.find('button[aria-label="刷新列表"]').trigger('click')
    await flushPromises()

    expect(rowText(0)).toContain('刚新建')
  })
})

describe('UserscriptListPanel 从路径导入', () => {
  it('导入菜单给两个入口：选择 zip 文件 / 输入文件路径', async () => {
    wrapper = await mountPanel()
    await buttonByText('导入').trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()

    const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) =>
      el.textContent?.trim(),
    )
    expect(items).toEqual(['选择 zip 文件…', '输入文件路径…'])
  })

  it('绝对路径：fetch 该 file:// URL → 交给导入链路 → 汇总报告复述来源', async () => {
    fetchMock.mockResolvedValue({ arrayBuffer: async () => zipBytes().buffer })
    wrapper = await mountPanel()
    await openPathDialog()
    await typePath('/Users/me/duo.zip')
    portalButton('导入')!.click()
    await flushPromises()
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledWith('file:///Users/me/duo.zip')
    expect(importZip).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).toContain('来源：/Users/me/duo.zip')
  })

  it('相对路径：就地给原因，既不 fetch 也不导入（不把「路径非法」拖到解码层才报）', async () => {
    wrapper = await mountPanel()
    await openPathDialog()
    await typePath('tmp/duo.zip')
    portalButton('导入')!.click()
    await flushPromises()

    expect(document.body.textContent).toContain('请填绝对路径')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(importZip).not.toHaveBeenCalled()
  })

  it('读到非 zip（后缀骗人 / 指向别的文件）：按魔数拦下，给一句人话而不是诊断数据', async () => {
    fetchMock.mockResolvedValue({ arrayBuffer: async () => notZipBytes().buffer })
    wrapper = await mountPanel()
    await openPathDialog()
    await typePath('/Users/me/fake.zip')
    portalButton('导入')!.click()
    await flushPromises()
    await flushPromises()

    expect(document.body.textContent).toContain('未识别到正确的 zip 内容')
    // 前 4 字节这类诊断数据不进用户文案（2026-09-19 定稿）
    expect(document.body.textContent).not.toContain('3c 21 44 4f')
    expect(importZip).not.toHaveBeenCalled()
  })

  it('开关未开 + 读不到：提示与常驻提示块同一句，并给「查看启用引导」（不猜「路径拼错了」）', async () => {
    setFileAccessAllowed(false)
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    wrapper = await mountPanel()
    await openPathDialog()
    await typePath('/Users/me/duo.zip')
    portalButton('导入')!.click()
    await flushPromises()
    await flushPromises()

    expect(document.body.textContent).toContain('未开启「允许访问文件网址」')
    expect(importZip).not.toHaveBeenCalled()

    // 引导入口：emit 给宿主切到引导标签页（完整步骤只此一份），**并且自己先关弹窗** ——
    // 宿主只切标签页，不关我们的弹窗（不关的话引导页上还压着这个弹窗，2026-09-19 手测发现）
    const guide = portalButton('查看启用引导')!
    expect(guide).toBeDefined()
    guide.click()
    await flushPromises()
    expect(wrapper.emitted('openGuide')).toBeTruthy()
    expect(dialogClosed()).toBe(true)
  })

  it('开关是开的 + 读不到：归因到路径拼写 / 指向了目录，不冤枉开关', async () => {
    setFileAccessAllowed(true)
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    wrapper = await mountPanel()
    await openPathDialog()
    await typePath('/Users/me/nope.zip')
    portalButton('导入')!.click()
    await flushPromises()
    await flushPromises()

    expect(document.body.textContent).toContain('请确认路径拼写')
    expect(document.body.textContent).not.toContain('允许访问文件网址')
    expect(importZip).not.toHaveBeenCalled()
  })

  it('探测不到开关（API 缺失）时不硬赖开关，两种可能都提', async () => {
    setFileAccessAllowed(null)
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    wrapper = await mountPanel()
    await openPathDialog()
    await typePath('/Users/me/duo.zip')
    portalButton('导入')!.click()
    await flushPromises()
    await flushPromises()

    expect(document.body.textContent).toContain('请确认路径拼写')
    expect(document.body.textContent).not.toContain('未开启「允许访问文件网址」')
  })
})

describe('UserscriptListPanel 分组', () => {
  it('groups() 返回分组时按分组头分块，未分组脚本进「未分组」节', async () => {
    groups.mockResolvedValue([{ id: 'g1', name: '购物助手', order: 0 }])
    list.mockResolvedValue([
      { ...summary('u1', '脚本A'), group: 'g1' },
      summary('u2', '脚本B'),
    ])
    wrapper = await mountPanel()

    expect(wrapper.text()).toContain('购物助手')
    expect(wrapper.text()).toContain('未分组')
    expect(wrapper.findAll('button[aria-label="编辑脚本"]')).toHaveLength(2)
  })

  it('「新建分组」按钮打开命名弹窗，填写后调用 createGroup', async () => {
    wrapper = await mountPanel()
    await buttonByText('新建分组').trigger('click')
    await flushPromises()

    const input = [...document.querySelectorAll<HTMLInputElement>('input')].find(
      (i) => !wrapper.element.contains(i) && i.getAttribute('aria-label') === '分组名称',
    )!
    expect(input).toBeDefined()
    input.value = '我的分组'
    input.dispatchEvent(new Event('input'))
    await flushPromises()

    portalButton('创建')!.click()
    await flushPromises()
    expect(createGroup).toHaveBeenCalledWith('我的分组')
  })
})
