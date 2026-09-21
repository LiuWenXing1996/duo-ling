// 组件测试：设置 · 关于分区的「检查更新」行（AboutSection.vue）。
//
// 守两类分支：
//   · 四种结果态各显示什么（没查过 / 已最新 / 有新版本 / 上次没查成）；
//   · 点「检查」会不会真的跑一次检查并刷新显示。
//
// 边界 mock：构建信息由 vite.define 注入，测试环境里这个裸标识符不存在，故连读取函数一起
// 替掉（只替换读值的那几个，保留 fmtBuildTime 真实实现）；检查更新的读写替掉后即可完全
// 控制结论，不必碰网络与 IndexedDB。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import AboutSection from './AboutSection.vue'

const readUpdateCheck = vi.hoisted(() => vi.fn())
const runUpdateCheck = vi.hoisted(() => vi.fn())
const tabsCreate = vi.hoisted(() => vi.fn())

vi.mock('@/lib/update-check', () => ({ readUpdateCheck, runUpdateCheck }))
vi.mock('@/lib/build-info', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/build-info')>()),
  readInjectedBuildInfo: () => ({
    time: '2026-09-22T00:00:00.000Z',
    branch: 'test-branch',
    version: '0.2.0-alpha.1',
    repo: 'owner/repo',
  }),
  readPageBuildStamp: () => ({ branch: 'test-branch', time: '09-22 00:00:00' }),
  fetchSwBuildStamp: async () => ({ branch: 'test-branch', time: '09-22 00:00:00' }),
}))

const wrappers: VueWrapper[] = []

async function mountSection(): Promise<VueWrapper> {
  tabsCreate.mockResolvedValue(undefined)
  vi.stubGlobal('chrome', {
    runtime: { getManifest: () => ({ version: '0.2.0' }) },
    tabs: { create: tabsCreate },
  })
  const w = mount(AboutSection)
  wrappers.push(w)
  await flushPromises()
  return w
}

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.length = 0
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

/** 检查更新那一行 */
const row = (w: VueWrapper) => w.find('[data-testid="update-check-row"]')

/** 一份检查结果（时间固定，断言只看版本号与文案） */
const record = (status: unknown, current = '0.2.0-alpha.1') => ({
  checkedAt: Date.UTC(2026, 8, 22, 1, 2, 3),
  current,
  status,
})

describe('关于分区的「检查更新」行', () => {
  it('没查过：说明「尚未检查过」，只有「检查」一个按钮', async () => {
    readUpdateCheck.mockResolvedValue(undefined)
    const w = await mountSection()
    expect(row(w).text()).toContain('尚未检查过')
    expect(row(w).findAll('button')).toHaveLength(1)
  })

  it('已是最新：给出最新版本号，不出现去处的按钮', async () => {
    readUpdateCheck.mockResolvedValue(record({ kind: 'current', latest: '0.2.0-alpha.1' }))
    const w = await mountSection()
    expect(row(w).text()).toContain('已是最新')
    expect(row(w).text()).toContain('0.2.0-alpha.1')
    expect(row(w).findAll('button')).toHaveLength(1)
  })

  it('有新版本：出现「查看 vX」按钮，点它打开 Release 页面', async () => {
    readUpdateCheck.mockResolvedValue(
      record({ kind: 'update', latest: '0.3.0', releaseUrl: 'https://example.com/r' }),
    )
    const w = await mountSection()

    const buttons = row(w).findAll('button')
    expect(buttons).toHaveLength(2)
    expect(buttons[0]!.text()).toContain('0.3.0')

    await buttons[0]!.trigger('click')
    await flushPromises()
    expect(tabsCreate).toHaveBeenCalledWith({ url: 'https://example.com/r' })
  })

  it('上次没查成：把原因显示出来（这是设置页，诊断信息该看得见）', async () => {
    readUpdateCheck.mockResolvedValue(record({ kind: 'unavailable', reason: 'GitHub 返回 403' }))
    const w = await mountSection()
    expect(row(w).text()).toContain('GitHub 返回 403')
  })

  it('点「检查」：真的跑一次检查，并把新结果显示出来', async () => {
    readUpdateCheck.mockResolvedValue(undefined)
    runUpdateCheck.mockResolvedValue(
      record({ kind: 'update', latest: '0.9.9', releaseUrl: 'https://example.com/r' }),
    )
    const w = await mountSection()
    expect(row(w).text()).toContain('尚未检查过')

    await row(w).findAll('button')[0]!.trigger('click')
    await flushPromises()

    expect(runUpdateCheck).toHaveBeenCalledTimes(1)
    expect(row(w).text()).toContain('0.9.9')
  })
})
