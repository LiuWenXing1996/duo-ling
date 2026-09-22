// 浮层存储单测：per-site 开关（默认值 / 禁用集合 / 补齐成开 / 条目判定与增删）与按钮位置
// （按站点记的读写与钳制）。
//
// 条目语义（本测试的重点）：
//   A. 集合里存的是 **match pattern**，纯域名连子域一起关，形近域不受影响；
//   B. **历史条目兼容**：早期直接存的裸 hostname 按精确匹配 —— 换存储格式不能把用户的旧设置弄失效；
//   C. 写路径：popup 的开关语义（按 host 关 / 恢复时把覆盖它的条目全删）、名单逐条删除、
//      批量添加的三分类（新增 / 已在名单 / 未识别）与批内去重。
//
// 补齐策略放在本模块是为了单一来源：popup 的「对话浮层」按钮与页面右键菜单都走它，
// 两条入口的差异只在失败反馈，行为判据不重复实现。
//
// chrome.storage.local 用手写壳（内存对象 + 记录写入次数 + onChanged 派发）—— 写入次数本身是
// 被测语义的一部分：无条件落盘会多触发一次 storage.onChanged，而内容脚本正听着那个事件增删浮层。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_FLOAT_POS,
  addDisabledSites,
  clampFloatPos,
  ensureFloatEnabled,
  getDisabledSites,
  getFloatPos,
  getMasterEnabled,
  isFloatEnabledForHost,
  removeDisabledSite,
  setFloatPos,
  setHostDisabled,
  subscribeFloatSettings,
} from '@/lib/float-panel-store'

// 字面量键名是**存储契约**，正是要钉住的东西
const MASTER_KEY = 'duoling:floatEnabled'
const DISABLED_KEY = 'duoling:floatDisabledSites'
const POS_KEY = 'duoling:floatPos'
/** 纯域名 `example.com` 在集合里的样子 */
const PATTERN = '*://*.example.com/*'

/** 悬浮按钮边长（px），与 content.ts 的 FAB_SIZE 一致 —— 钳制几何要用它 */
const FAB = 52

type ChangeMap = Record<string, { newValue?: unknown }>
type Listener = (changes: ChangeMap, area: string) => void

/** onChanged 的订阅者（subscribeFloatSettings 的用例直接驱动它们） */
let listeners: Listener[]

interface StorageStub {
  data: Record<string, unknown>
  /** 落盘次数（set 调用计数） */
  setCalls: number
}

function stubStorage(init: Record<string, unknown> = {}): StorageStub {
  const stub: StorageStub = { data: { ...init }, setCalls: 0 }
  listeners = []
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stub.data[key] })),
        set: vi.fn(async (patch: Record<string, unknown>) => {
          stub.setCalls += 1
          const changes: ChangeMap = {}
          for (const [k, v] of Object.entries(patch)) {
            changes[k] = { newValue: v }
            stub.data[k] = v
          }
          fireChange(changes, 'local')
        }),
      },
      onChanged: {
        addListener: (fn: Listener) => listeners.push(fn),
        removeListener: (fn: Listener) => {
          listeners = listeners.filter((l) => l !== fn)
        },
      },
    },
  })
  return stub
}

/** 派发一次 storage 变更（set 之后自动走这条；用例也可直接驱动，模拟别的上下文改了 storage） */
function fireChange(changes: ChangeMap, area: string): void {
  for (const fn of [...listeners]) fn(changes, area)
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
    // 入列的是规范化后的 pattern（纯域名连子域一起关）
    expect(await getDisabledSites()).toEqual([PATTERN])
    expect(await isFloatEnabledForHost('www.example.com')).toBe(false)
    expect(await isFloatEnabledForHost('other.com')).toBe(true)

    await setHostDisabled('example.com', false)
    expect(await getDisabledSites()).toEqual([])
    expect(await isFloatEnabledForHost('example.com')).toBe(true)
  })
})

describe('isFloatEnabledForHost（条目判定）', () => {
  it('总开关关 → 一律不显示，不看名单', async () => {
    stubStorage({ [MASTER_KEY]: false })
    expect(await isFloatEnabledForHost('example.com')).toBe(false)
  })

  it('pattern 条目：纯域名连子域一起关，形近域不受影响', async () => {
    stubStorage({ [DISABLED_KEY]: [PATTERN] })
    expect(await isFloatEnabledForHost('example.com')).toBe(false)
    expect(await isFloatEnabledForHost('a.b.example.com')).toBe(false)
    expect(await isFloatEnabledForHost('notexample.com')).toBe(true)
    expect(await isFloatEnabledForHost('example.com.evil.test')).toBe(true)
  })

  it('历史裸 hostname 条目：按精确匹配兼容（旧设置不能失效）', async () => {
    stubStorage({ [DISABLED_KEY]: ['www.example.com'] })
    expect(await isFloatEnabledForHost('www.example.com')).toBe(false)
    expect(await isFloatEnabledForHost('example.com')).toBe(true)
    expect(await isFloatEnabledForHost('a.www.example.com')).toBe(true)
  })
})

describe('setHostDisabled（popup 的「当前网站显示浮层」开关）', () => {
  it('开：把覆盖该 host 的条目全删掉（含历史裸 hostname 条目）', async () => {
    const stub = stubStorage({
      [DISABLED_KEY]: ['*://*.a.com/*', 'www.a.com', '*://*.other.com/*'],
    })
    await setHostDisabled('www.a.com', false)
    expect(stub.data[DISABLED_KEY]).toEqual(['*://*.other.com/*'])
  })

  it('认不出的 host 不落盘；已在名单里则不重复写', async () => {
    const stub = stubStorage()
    await setHostDisabled('not a host', true)
    expect(stub.data[DISABLED_KEY]).toBeUndefined()

    await setHostDisabled('a.com', true)
    const once = stub.data[DISABLED_KEY]
    await setHostDisabled('a.com', true)
    expect(stub.data[DISABLED_KEY]).toBe(once)
  })
})

describe('ensureFloatEnabled（页面外入口用的补齐策略）', () => {
  it('总开关关着：打开它', async () => {
    const stub = stubStorage({ [MASTER_KEY]: false })
    await ensureFloatEnabled('example.com')
    expect(await getMasterEnabled()).toBe(true)
    // 只动总开关：该站本来就不在禁用集合里
    expect(stub.setCalls).toBe(1)
    expect(await isFloatEnabledForHost('example.com')).toBe(true)
  })

  it('该站在禁用集合里：把它移出', async () => {
    const stub = stubStorage({ [DISABLED_KEY]: ['example.com'] })
    await ensureFloatEnabled('example.com')
    expect(await getDisabledSites()).toEqual([])
    expect(stub.setCalls).toBe(1)
  })

  it('被 pattern 条目（含子域）覆盖时同样移出 —— 条目不是裸 hostname，不能按字符串比对', async () => {
    const stub = stubStorage({ [DISABLED_KEY]: [PATTERN] })
    await ensureFloatEnabled('www.example.com')
    expect(await getDisabledSites()).toEqual([])
    expect(stub.setCalls).toBe(1)
  })

  it('两处都已经是开的：一次都不写（多余的 set 会多触发一次 onChanged）', async () => {
    const stub = stubStorage()
    await ensureFloatEnabled('example.com')
    expect(stub.setCalls).toBe(0)
  })

  it('认不出站点（host 为空）：不碰禁用集合，只按总开关处理', async () => {
    const stub = stubStorage({ [DISABLED_KEY]: ['example.com'] })
    await ensureFloatEnabled('')
    expect(stub.setCalls).toBe(0)
    expect(await getDisabledSites()).toEqual(['example.com'])
  })
})

describe('removeDisabledSite（设置页名单的「恢复显示」）', () => {
  it('只删那一条，不做覆盖关系推断', async () => {
    const stub = stubStorage({ [DISABLED_KEY]: ['*://*.a.com/*', '*://*.www.a.com/*'] })
    await removeDisabledSite('*://*.www.a.com/*')
    expect(stub.data[DISABLED_KEY]).toEqual(['*://*.a.com/*'])
  })
})

describe('addDisabledSites（批量添加）', () => {
  it('逐条规范化入列；已被覆盖的算「已在名单」，认不出的原样报回', async () => {
    const stub = stubStorage({ [DISABLED_KEY]: [PATTERN] })
    const r = await addDisabledSites(['example.com', 'https://www.b.com/x', 'nope'])

    expect(r.added).toEqual(['*://*.www.b.com/*'])
    expect(r.existing).toEqual([PATTERN]) // example.com 已被现有条目覆盖
    expect(r.invalid).toEqual(['nope'])
    expect(stub.data[DISABLED_KEY]).toEqual([PATTERN, '*://*.www.b.com/*'])
  })

  it('同批里重复输入只入列一次', async () => {
    const stub = stubStorage()
    const r = await addDisabledSites(['a.com', 'a.com', '*.a.com'])
    expect(r.added).toEqual(['*://*.a.com/*'])
    expect(r.existing).toEqual(['*://*.a.com/*', '*://*.a.com/*'])
    expect(stub.data[DISABLED_KEY]).toEqual(['*://*.a.com/*'])
  })

  it('一条都没成：不写存储', async () => {
    const stub = stubStorage()
    const r = await addDisabledSites(['nope', '   '])
    expect(r).toEqual({ added: [], existing: [], invalid: ['nope', ''] })
    expect(stub.data[DISABLED_KEY]).toBeUndefined()
  })
})

describe('subscribeFloatSettings（变更通知）', () => {
  it('两个键任一变化都回调；无关键、非 local 区域不回调；退订后不再回调', () => {
    stubStorage()
    const cb = vi.fn()
    const off = subscribeFloatSettings(cb)

    fireChange({ [MASTER_KEY]: { newValue: false } }, 'local')
    expect(cb).toHaveBeenCalledTimes(1)

    fireChange({ [DISABLED_KEY]: { newValue: [] } }, 'local')
    expect(cb).toHaveBeenCalledTimes(2)

    fireChange({ 'duoling:other': { newValue: 1 } }, 'local')
    fireChange({ [MASTER_KEY]: { newValue: true } }, 'sync')
    expect(cb).toHaveBeenCalledTimes(2)

    off()
    fireChange({ [MASTER_KEY]: { newValue: true } }, 'local')
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('位置键变化不触发（位置只归写它的那个页面用）', () => {
    stubStorage()
    const cb = vi.fn()
    subscribeFloatSettings(cb)
    fireChange({ [POS_KEY]: { newValue: { 'a.com': { right: 1, bottom: 1 } } } }, 'local')
    expect(cb).not.toHaveBeenCalled()
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
