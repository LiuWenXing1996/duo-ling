// conversation-tab-map 单测：归属映射的读写往返，以及「这条会话是不是正被标签页用着」的判据。
//
// 后者是删除会话的前置门：判据必须是「映射里有 + 那个标签页还开着」两条都成立。
// 只查映射会把指向**已关闭**标签页的残留项算成「正在使用」，用户会删不掉又找不到是哪个
// 标签页；而不能判定 tab 存活时（没有 chrome.tabs）要保守算作「在用」，免得误删。
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as appDb from '@/lib/app-db'
import {
  bindTabToConversation,
  findTabsUsingConversation,
  getActiveTabBindings,
  getConversationIdForTab,
  getTabConversationMap,
  unbindAll,
  unbindConversation,
  unbindTab,
} from './conversation-tab-map'

/** 只让列出的 tabId 存在（其余 chrome.tabs.get 抛错，模拟标签页已关闭） */
function stubAliveTabs(alive: number[]): void {
  vi.stubGlobal('chrome', {
    tabs: {
      get: (tabId: number) =>
        alive.includes(tabId)
          ? Promise.resolve({ id: tabId })
          : Promise.reject(new Error(`No tab with id: ${tabId}`)),
    },
  })
}

beforeEach(async () => {
  vi.unstubAllGlobals()
  await appDb.clearAllForTests()
})

describe('归属映射读写', () => {
  it('登记后能按 tab 取回会话；解绑后取不到', async () => {
    await bindTabToConversation(7, 'conv-a')
    expect(await getConversationIdForTab(7)).toBe('conv-a')

    await unbindTab(7)
    expect(await getConversationIdForTab(7)).toBeNull()
  })

  it('不同 tab 各绑各的，互不覆盖（整表一个键，写的是同一份值）', async () => {
    await bindTabToConversation(1, 'conv-1')
    await bindTabToConversation(2, 'conv-2')

    expect(await getTabConversationMap()).toEqual({ '1': 'conv-1', '2': 'conv-2' })
  })

  it('解绑会话：清掉指向它的全部 tab，别的会话不动', async () => {
    await bindTabToConversation(1, 'conv-a')
    await bindTabToConversation(2, 'conv-a')
    await bindTabToConversation(3, 'conv-b')

    await unbindConversation('conv-a')

    expect(await getTabConversationMap()).toEqual({ '3': 'conv-b' })
  })

  it('清空整表', async () => {
    await bindTabToConversation(1, 'conv-a')
    await unbindAll()
    expect(await getTabConversationMap()).toEqual({})
  })
})

describe('「是否正被标签页使用」的判据', () => {
  it('标签页还开着 → 算在用', async () => {
    stubAliveTabs([42])
    await bindTabToConversation(42, 'conv-a')

    expect(await findTabsUsingConversation('conv-a')).toEqual([42])
    expect(await getActiveTabBindings()).toEqual({ '42': 'conv-a' })
  })

  it('标签页已关（关闭清理没跑成，映射是残留项）→ **不算在用**，且顺手把残留项清掉', async () => {
    stubAliveTabs([]) // 42 已不存在
    await bindTabToConversation(42, 'conv-a')

    expect(await findTabsUsingConversation('conv-a')).toEqual([])
    // 残留项被清掉：下次不必再验一遍 tab
    expect(await getTabConversationMap()).toEqual({})
  })

  it('清理残留项不会误删同时新建的绑定（写回只针对那一个键）', async () => {
    stubAliveTabs([9])
    await bindTabToConversation(42, 'conv-stale') // 42 已关
    await bindTabToConversation(9, 'conv-live')

    const alive = await getActiveTabBindings()

    expect(alive).toEqual({ '9': 'conv-live' })
    expect(await getTabConversationMap()).toEqual({ '9': 'conv-live' })
  })

  it('没有 chrome.tabs（无法判定）→ 保守算作在用，不误放行', async () => {
    vi.stubGlobal('chrome', undefined)
    await bindTabToConversation(5, 'conv-a')

    expect(await findTabsUsingConversation('conv-a')).toEqual([5])
  })

  it('没人用这条会话 → 空数组（可删）', async () => {
    stubAliveTabs([1])
    await bindTabToConversation(1, 'conv-other')

    expect(await findTabsUsingConversation('conv-a')).toEqual([])
  })
})
