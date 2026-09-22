// 浮层开关存储单测：读写口径（默认值 / 禁用集合）与「补齐成开」的策略。
//
// 补齐策略放在本模块是为了单一来源：popup 的「对话浮层」按钮与页面右键菜单都走它，
// 两条入口的差异只在失败反馈，行为判据不重复实现。
//
// chrome.storage.local 用手写壳（内存对象 + 记录写入次数）—— 写入次数本身是被测语义的一部分：
// 无条件落盘会多触发一次 storage.onChanged，而内容脚本正听着那个事件增删浮层。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureFloatEnabled,
  getDisabledSites,
  getMasterEnabled,
  isFloatEnabledForHost,
  setHostDisabled,
} from '@/lib/float-panel-store'

interface StorageStub {
  data: Record<string, unknown>
  /** 落盘次数（set 调用计数） */
  setCalls: number
}

function stubStorage(init: Record<string, unknown> = {}): StorageStub {
  const stub: StorageStub = { data: { ...init }, setCalls: 0 }
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stub.data[key] })),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          stub.setCalls += 1
          Object.assign(stub.data, patch)
        }),
      },
    },
  })
  return stub
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('浮层开关存储', () => {
  it('总开关默认开（键不存在即视为开）', async () => {
    stubStorage()
    expect(await getMasterEnabled()).toBe(true)
  })

  it('站点不在禁用集合里时按「显示浮层」算', async () => {
    stubStorage()
    expect(await getDisabledSites()).toEqual([])
    expect(await isFloatEnabledForHost('example.com')).toBe(true)
  })

  it('关掉某站后该站为关、别站不受影响；重新打开即移出集合', async () => {
    stubStorage()
    await setHostDisabled('example.com', true)
    expect(await getDisabledSites()).toEqual(['example.com'])
    expect(await isFloatEnabledForHost('example.com')).toBe(false)
    expect(await isFloatEnabledForHost('other.com')).toBe(true)

    await setHostDisabled('example.com', false)
    expect(await getDisabledSites()).toEqual([])
    expect(await isFloatEnabledForHost('example.com')).toBe(true)
  })
})

describe('ensureFloatEnabled（页面外入口用的补齐策略）', () => {
  it('总开关关着：打开它', async () => {
    const stub = stubStorage({ 'duoling:floatEnabled': false })
    await ensureFloatEnabled('example.com')
    expect(await getMasterEnabled()).toBe(true)
    // 只动总开关：该站本来就不在禁用集合里
    expect(stub.setCalls).toBe(1)
    expect(await isFloatEnabledForHost('example.com')).toBe(true)
  })

  it('该站在禁用集合里：把它移出', async () => {
    const stub = stubStorage({ 'duoling:floatDisabledSites': ['example.com'] })
    await ensureFloatEnabled('example.com')
    expect(await getDisabledSites()).toEqual([])
    expect(stub.setCalls).toBe(1)
  })

  it('两处都已经是开的：一次都不写（多余的 set 会多触发一次 onChanged）', async () => {
    const stub = stubStorage()
    await ensureFloatEnabled('example.com')
    expect(stub.setCalls).toBe(0)
  })

  it('认不出站点（host 为空）：不碰禁用集合，只按总开关处理', async () => {
    const stub = stubStorage({ 'duoling:floatDisabledSites': ['example.com'] })
    await ensureFloatEnabled('')
    expect(stub.setCalls).toBe(0)
    expect(await getDisabledSites()).toEqual(['example.com'])
  })
})
