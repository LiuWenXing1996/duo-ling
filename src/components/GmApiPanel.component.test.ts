// UI 组件测试：GmApiPanel.vue 的三条核心语义。
//
// A. **清单来自静态目录**：渲染出来的就是 lib/gm-api-catalog.ts 的全部条目（与注入脚本世界的
//    `GM_*` / `GM.*` 同源，一致性由 catalog 的类型层 + 源码反射单测兜，这里只验渲染）。
// B. **关键词搜索**：命中条数随关键词收窄，搜不到给出空状态（不回退成全量）。
// C. **分组筛选**：只显示该组条目（左栏计数与右栏结果同源）。
import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import GmApiPanel from './GmApiPanel.vue'
import { GM_API_ENTRIES } from '@/lib/gm-api-catalog'

/** 卡片根元素（过滤掉同前缀的 toggle，两者的 testid 都以 gm-api-card- 开头） */
function cardPaths(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper
    .findAll('[data-testid^="gm-api-card-"]')
    .filter((el) => !el.attributes('data-testid')!.includes('-toggle-'))
    .map((el) => el.attributes('data-testid')!.replace('gm-api-card-', ''))
}

describe('GmApiPanel', () => {
  it('默认渲染全部条目（来自静态目录，不依赖任何请求）；展开后显示说明', async () => {
    const wrapper = mount(GmApiPanel)
    expect(cardPaths(wrapper)).toHaveLength(GM_API_ENTRIES.length)
    expect(wrapper.find('[data-testid="gm-api-group-all"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="gm-api-group-storage"]').exists()).toBe(true)

    // 收起态只有标题 + 一句话（说明段还没渲染）
    const collapsed = wrapper.find('[data-testid="gm-api-card-GM_getValue"]')
    expect(collapsed.exists()).toBe(true)
    expect(collapsed.text()).not.toContain('读的是脚本启动时的值快照')

    await wrapper.find('[data-testid="gm-api-card-toggle-GM_getValue"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="gm-api-card-GM_getValue"]').text()).toContain(
      '读的是脚本启动时的值快照',
    )
  })

  it('关键词搜索：命中即收窄，搜不到给空状态', async () => {
    const wrapper = mount(GmApiPanel)
    await wrapper.find('[data-testid="gm-api-search"]').setValue('cookie')
    const hit = cardPaths(wrapper)
    expect(hit).toContain('GM_cookie')
    expect(hit).toContain('GM_cookie.list')
    expect(hit).toContain('GM_cookie.set')
    expect(hit.length).toBeLessThan(GM_API_ENTRIES.length)

    await wrapper.find('[data-testid="gm-api-search"]').setValue('zzz-not-exist')
    expect(cardPaths(wrapper)).toHaveLength(0)
    expect(wrapper.find('[data-testid="gm-api-empty"]').text()).toContain('zzz-not-exist')
  })

  it('分组筛选：只显示该组条目', async () => {
    const wrapper = mount(GmApiPanel)
    await wrapper.find('[data-testid="gm-api-group-storage"]').trigger('click')
    const paths = cardPaths(wrapper)
    expect(paths).toContain('GM_getValue')
    expect(paths).toContain('GM.getValue')
    expect(paths).toContain('GM_getTab')
    expect(paths.some((p) => p.startsWith('GM_cookie'))).toBe(false)
    expect(paths).not.toContain('GM_xmlhttpRequest')
  })
})
