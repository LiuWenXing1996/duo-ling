import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import HomePanel from './HomePanel.vue'
import type { ToolMeta } from '@/types/tool'

const tools: ToolMeta[] = [
  { id: 't-1', name: 'pdf-merge', title: 'PDF 合并器', description: '合并多个 PDF' },
  { id: 't-2', name: 'img-crop', title: '图片裁剪', description: '裁剪图片' },
  { id: 't-3', name: 'txt-clean', title: '文本清洗', description: '清洗文本' }
]

function mountPanel(pinnedIds: string[], groupMap: Record<string, string> = {}): ReturnType<typeof mount> {
  return mount(HomePanel, {
    props: { tools, groupMap, pinnedIds, error: '' }
  })
}

describe('HomePanel（主页：分组分区 + 置顶「常用」分区）', () => {
  it('无置顶工具时不出现「常用」分区', () => {
    const wrapper = mountPanel([])
    const titles = wrapper.findAll('.tool-section__title').map((el) => el.text())
    expect(titles).not.toContain('常用')
    expect(titles).toEqual(['未分组'])
  })

  it('置顶工具排在「常用」分区最前，且在原分组保留', () => {
    const wrapper = mountPanel(['t-2'], { 't-2': '设计' })
    const sections = wrapper.findAll('.tool-section')
    // 常用分区置顶：第一个分区标题为「常用」，包含置顶工具
    expect(sections[0].find('.tool-section__title').text()).toBe('常用')
    expect(sections[0].findAll('.tool-card__title').map((el) => el.text())).toEqual(['图片裁剪'])
    // 原分组「设计」中该工具仍保留（不消失、不困惑）
    const design = sections.find((s) => s.find('.tool-section__title').text() === '设计')
    expect(design?.findAll('.tool-card__title').map((el) => el.text())).toEqual(['图片裁剪'])
  })

  it('「常用」分区保持置顶顺序，忽略列表中不存在的工具 id', () => {
    const wrapper = mountPanel(['t-3', 'ghost', 't-1'])
    const sections = wrapper.findAll('.tool-section')
    expect(sections[0].find('.tool-section__title').text()).toBe('常用')
    expect(sections[0].findAll('.tool-card__title').map((el) => el.text())).toEqual([
      '文本清洗',
      'PDF 合并器'
    ])
  })

  it('置顶卡片显示 pin 按钮且标记激活态（取消置顶标题）', () => {
    const wrapper = mountPanel(['t-1'])
    const pinBtn = wrapper.find('.tool-card__action--pin')
    expect(pinBtn.exists()).toBe(true)
    expect(pinBtn.attributes('title')).toBe('取消置顶')
    expect(pinBtn.classes()).toContain('tool-card__action--pinned')
    // 置顶卡片操作组常显（依赖 actions--visible）
    expect(wrapper.find('.tool-card__actions').classes()).toContain('tool-card__actions--visible')
  })

  it('未置顶卡片 pin 按钮为「置顶工具」，点击派发 pin 事件', async () => {
    const wrapper = mountPanel(['t-2'])
    // 「常用」区第一个 pin 按钮属于已置顶的 t-2；定位未置顶的 t-1 卡片
    const cards = wrapper.findAll('.tool-card')
    const unPinnedCard = cards.find((c) => c.find('.tool-card__title').text() === 'PDF 合并器')
    expect(unPinnedCard).toBeTruthy()
    const pinBtn = unPinnedCard!.find('.tool-card__action--pin')
    expect(pinBtn.attributes('title')).toBe('置顶工具')
    await pinBtn.trigger('click')
    expect(wrapper.emitted('pin')).toBeTruthy()
    expect(wrapper.emitted('pin')?.[0]).toEqual([tools[0]])
  })
})
