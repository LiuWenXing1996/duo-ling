// 浮层存储单测：per-site 开关（默认值 / 禁用集合 / 补齐成开）与按钮位置（按站点记的读写与钳制）。
//
// 补齐策略放在本模块是为了单一来源：popup 的「对话浮层」按钮与页面右键菜单都走它，
// 两条入口的差异只在失败反馈，行为判据不重复实现。
//
// chrome.storage.local 用手写壳（内存对象 + 记录写入次数）—— 写入次数本身是被测语义的一部分：
// 无条件落盘会多触发一次 storage.onChanged，而内容脚本正听着那个事件增删浮层。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FLOAT_POS,
  clampFloatPos,
  ensureFloatEnabled,
  getDisabledSites,
  getFloatPos,
  getMasterEnabled,
  isFloatEnabledForHost,
  setFloatPos,
  setHostDisabled,
} from '@/lib/float-panel-store'

const POS_KEY = 'duoling:floatPos'

/** 悬浮按钮边长（px），与 content.ts 的 FAB_SIZE 一致 —— 钳制几何要用它 */
const FAB = 52

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

describe('按钮位置读写', () => {
  it('没拖过时取不到位置（由调用方退回默认值）', async () => {
    stubStorage()
    expect(await getFloatPos('a.com')).toBeNull()
    expect(DEFAULT_FLOAT_POS).toEqual({ right: 20, bottom: 20 })
  })

  it('记下后能按 host 取回，落盘取整', async () => {
    stubStorage()
    await setFloatPos('a.com', { right: 120.4, bottom: 88.6 })
    expect(await getFloatPos('a.com')).toEqual({ right: 120, bottom: 89 })
  })

  it('各站点互不干扰：改一个不动另一个', async () => {
    stubStorage()
    await setFloatPos('a.com', { right: 10, bottom: 10 })
    await setFloatPos('b.com', { right: 200, bottom: 300 })
    await setFloatPos('a.com', { right: 30, bottom: 40 })
    expect(await getFloatPos('a.com')).toEqual({ right: 30, bottom: 40 })
    expect(await getFloatPos('b.com')).toEqual({ right: 200, bottom: 300 })
    expect(await getFloatPos('c.com')).toBeNull()
  })

  it('存坏了（非对象 / 缺字段 / 非有限数）一律当没记过', async () => {
    const stub = stubStorage({ [POS_KEY]: 'oops' })
    expect(await getFloatPos('a.com')).toBeNull()

    stub.data[POS_KEY] = { 'a.com': { right: 1 } }
    expect(await getFloatPos('a.com')).toBeNull()

    stub.data[POS_KEY] = { 'a.com': { right: Number.NaN, bottom: 5 } }
    expect(await getFloatPos('a.com')).toBeNull()
  })
})

describe('位置钳制', () => {
  const viewport = { width: 1000, height: 800 }

  it('视口内原样返回', () => {
    expect(clampFloatPos({ right: 100, bottom: 200 }, viewport, FAB)).toEqual({
      right: 100,
      bottom: 200,
    })
  })

  it('越界拉回：负值归零，超出按「按钮完整可见」封顶', () => {
    expect(clampFloatPos({ right: -30, bottom: -5 }, viewport, FAB)).toEqual({
      right: 0,
      bottom: 0,
    })
    expect(clampFloatPos({ right: 5000, bottom: 5000 }, viewport, FAB)).toEqual({
      right: viewport.width - FAB,
      bottom: viewport.height - FAB,
    })
  })

  it('视口比按钮还小时归零（不出现负上限把坐标甩到视口外）', () => {
    expect(clampFloatPos({ right: 10, bottom: 10 }, { width: 40, height: 30 }, FAB)).toEqual({
      right: 0,
      bottom: 0,
    })
  })
})
