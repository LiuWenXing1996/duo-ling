// 组件测试：HelpPanel（目录 / 过滤 / 跳转）。
//
// 正文走真实渲染链路（markdown-it 是同步的，happy-dom 里直接跑）：跳转按标题 id 匹配，只有真
// 渲染才能验证「目录项 id ↔ 正文标题 id」这对关系 —— 把渲染器 stub 掉等于让两边各造一套 id，
// 恰恰漏掉最容易坏的那条。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import HelpPanel from './HelpPanel.vue'
import helpContent from '@/lib/help/help-content.md?raw'
import { parseHelpSections } from '@/lib/help/help-sections'

const sections = parseHelpSections(helpContent)

/** happy-dom 不实现 scrollIntoView；记下每次滚动落在哪个元素上 */
const scrolled: Element[] = []
beforeEach(() => {
  scrolled.length = 0
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this)
  }
})

const wrappers: VueWrapper[] = []
function mountPanel(): VueWrapper {
  const wrapper = mount(HelpPanel)
  wrappers.push(wrapper)
  return wrapper
}
afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount()
  wrappers.length = 0
})

const navItems = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="help-nav-item"]')
const navTexts = (wrapper: VueWrapper) => navItems(wrapper).map((el) => el.text())
const searchBox = (wrapper: VueWrapper) => wrapper.find('[data-testid="help-search"]')

describe('HelpPanel 目录', () => {
  it('目录项与正文派生的章节一一对应', () => {
    const wrapper = mountPanel()
    expect(navItems(wrapper)).toHaveLength(sections.length)
    expect(navTexts(wrapper)[0]).toBe('快速上手')
    expect(navTexts(wrapper)).toContain('常见问题')
  })

  it('### 小节也进目录', () => {
    const wrapper = mountPanel()
    const subSections = sections.filter((s) => s.depth === 3)
    expect(subSections.length).toBeGreaterThan(0)
    for (const sub of subSections) expect(navTexts(wrapper)).toContain(sub.title)
  })
})

describe('HelpPanel 过滤', () => {
  it('输入关键词后只剩匹配项', async () => {
    const wrapper = mountPanel()
    await searchBox(wrapper).setValue('脚本')
    const texts = navTexts(wrapper)
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every((t) => t.includes('脚本'))).toBe(true)
  })

  it('清空关键词后目录恢复完整', async () => {
    const wrapper = mountPanel()
    await searchBox(wrapper).setValue('脚本')
    await searchBox(wrapper).setValue('')
    expect(navItems(wrapper)).toHaveLength(sections.length)
  })

  it('无匹配时给一句话而不是空白', async () => {
    const wrapper = mountPanel()
    await searchBox(wrapper).setValue('这个章节不存在')
    expect(navItems(wrapper)).toHaveLength(0)
    expect(wrapper.text()).toContain('没有匹配的章节')
  })
})

describe('HelpPanel 跳转', () => {
  it('点目录项滚到正文里的同名标题', async () => {
    const wrapper = mountPanel()
    const index = sections.findIndex((s) => s.title === '用户脚本')
    await navItems(wrapper)[index]!.trigger('click')
    expect(scrolled).toHaveLength(1)
    expect(scrolled[0]!.tagName).toBe('H2')
    expect(scrolled[0]!.textContent).toBe('用户脚本')
  })

  it('每个目录项都能在正文里命中对应标题', async () => {
    const wrapper = mountPanel()
    for (const [i, section] of sections.entries()) {
      scrolled.length = 0
      await navItems(wrapper)[i]!.trigger('click')
      expect(scrolled, `目录项「${section.title}」没跳到标题`).toHaveLength(1)
      expect(scrolled[0]!.id).toBe(section.id)
    }
  })
})
