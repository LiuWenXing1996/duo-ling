// UI 组件测试：DlApiPanel.vue 的三条核心语义。
//
// A. **清单来自静态目录**：渲染出来的就是 lib/dl-api-catalog.ts 那 28 条（与注入脚本世界的
//    window.DL 同源，一致性由 catalog 的类型层 + 源码反射单测兜，这里只验渲染）。
// B. **详情默认收起**：28 条全铺开没法扫；点标题行才展开签名 / 说明 / 返回。
// C. **搜索与分组**：关键词全库匹配（含中文名与说明），无命中给空态而不是白屏。
//
// 面板是纯静态渲染（零请求 / 零存储），无需 mock 任何 store。
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import DlApiPanel from './DlApiPanel.vue'
import { DL_API_ENTRIES } from '@/lib/dl-api-catalog'

let wrapper: VueWrapper

/** 卡片根元素（过滤掉同前缀的 toggle，两者的 testid 都以 dl-api-card- 开头） */
function cards(): ReturnType<VueWrapper['findAll']> {
  return wrapper
    .findAll('[data-testid^="dl-api-card-"]')
    .filter((n) => !(n.attributes('data-testid') ?? '').includes('-toggle-'))
}

afterEach(() => {
  wrapper?.unmount()
})

describe('DlApiPanel', () => {
  it('渲染目录全部条目；详情默认收起，展开后才出签名', async () => {
    wrapper = mount(DlApiPanel)
    await flushPromises()

    expect(cards()).toHaveLength(DL_API_ENTRIES.length)
    // 分组导航（全部 + 5 组）
    expect(wrapper.find('[data-testid="dl-api-group-all"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="dl-api-group-storage"]').exists()).toBe(true)

    const card = wrapper.find('[data-testid="dl-api-card-store.get"]')
    expect(card.text()).toContain('读私有存储')
    // 收起：签名（mono 代码块）不渲染
    expect(card.text()).not.toContain('DL.store.get(key, fallback?)')

    await wrapper.find('[data-testid="dl-api-card-toggle-store.get"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="dl-api-card-store.get"]').text()).toContain(
      'DL.store.get(key, fallback?)',
    )
    expect(wrapper.find('[data-testid="dl-api-card-store.get"]').text()).toContain('键空间按脚本 uuid 隔离')
  })

  it('搜索按中文名 / 说明匹配：命中收窄，无命中给空态', async () => {
    wrapper = mount(DlApiPanel)
    await flushPromises()

    await wrapper.find('[data-testid="dl-api-search"]').setValue('cookie')
    await flushPromises()
    // fetch 也命中：它的说明里提到了 Cookie 头覆写（搜的是全文本，不是只看方法名）
    const paths = cards().map((n) => n.attributes('data-testid'))
    expect(paths).toEqual([
      'dl-api-card-fetch',
      'dl-api-card-cookie.get',
      'dl-api-card-cookie.set',
      'dl-api-card-cookie.remove',
    ])

    await wrapper.find('[data-testid="dl-api-search"]').setValue('zzz-not-exist')
    await flushPromises()
    expect(cards()).toHaveLength(0)
    expect(wrapper.find('[data-testid="dl-api-empty"]').text()).toContain('zzz-not-exist')
  })

  it('切分组只显示该组条目', async () => {
    wrapper = mount(DlApiPanel)
    await flushPromises()

    await wrapper.find('[data-testid="dl-api-group-storage"]').trigger('click')
    await flushPromises()
    const paths = cards().map((n) => n.attributes('data-testid'))
    expect(paths).toContain('dl-api-card-store.get')
    expect(paths).toContain('dl-api-card-tab.all')
    expect(paths.some((p) => p?.startsWith('dl-api-card-cookie.'))).toBe(false)
    // 存储组 = store 6 + tab 3
    expect(paths).toHaveLength(9)
  })
})
