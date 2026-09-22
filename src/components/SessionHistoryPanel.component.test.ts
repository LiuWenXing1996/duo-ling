// 会话列表项上的「生成中」标记与就地停止。
//
// 这条链路的关键在职责边界：
//   · 「谁在跑」是 props.runningIds（数据源在 useChatRunning → SW 的内存快照），面板自己不认识；
//   · 「停止」只 emit，命令面由上层（SessionHistoryTab）去发 —— 面板不碰 chrome API。
// 所以这里只验三件事：命中即出现、不命中即不出现、点了会 emit。
import { describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import SessionHistoryPanel from './SessionHistoryPanel.vue'
import type { Conversation } from '@/shared/types'

// 只用到这一个纯函数，mock 掉整个 composable —— 真模块会牵进 ai SDK 与 transport
vi.mock('@/composables/use-global-conversation', () => ({
  formatSessionTime: () => '刚刚',
}))

const conv = (id: string, title: string): Conversation => ({
  id,
  title,
  createdAt: '2026-09-22T00:00:00.000Z',
  lastMessageAt: '2026-09-22T00:00:00.000Z',
})

function mountPanel(runningIds?: string[]): VueWrapper {
  return mount(SessionHistoryPanel, {
    props: {
      conversations: [conv('c1', '会话一'), conv('c2', '会话二')],
      activeConversationId: 'c1',
      ...(runningIds ? { runningIds } : {}),
    },
  })
}

/** 列表项（按出现顺序） */
const rows = (w: VueWrapper) => w.findAll('li')

describe('会话列表的生成中标记', () => {
  it('没有在跑的会话：一行标记都不渲染', () => {
    const w = mountPanel([])
    expect(w.findAll('[data-testid="session-running"]')).toHaveLength(0)
    expect(w.findAll('[data-testid="session-stop"]')).toHaveLength(0)
    w.unmount()
  })

  it('runningIds 缺省（调用方还没拉到状态）：同样不渲染', () => {
    const w = mountPanel()
    expect(w.findAll('[data-testid="session-running"]')).toHaveLength(0)
    w.unmount()
  })

  it('只有命中的那一行带标记与停止按钮', () => {
    const w = mountPanel(['c2'])

    expect(w.findAll('[data-testid="session-running"]')).toHaveLength(1)
    // 命中的是第二行（c2）；第一行（c1）不该有
    expect(rows(w)[0]!.find('[data-testid="session-running"]').exists()).toBe(false)
    expect(rows(w)[1]!.find('[data-testid="session-running"]').exists()).toBe(true)
    expect(rows(w)[1]!.find('[data-testid="session-stop"]').exists()).toBe(true)
    w.unmount()
  })

  it('点停止：emit stop 带上那条会话 id，且不触发选中该会话', async () => {
    const w = mountPanel(['c2'])

    await rows(w)[1]!.find('[data-testid="session-stop"]').trigger('click')

    expect(w.emitted('stop')).toEqual([['c2']])
    // 行本身是可点区域（activate）：停止按钮必须把冒泡挡住，否则会顺手切走选中
    expect(w.emitted('activate')).toBeUndefined()
    w.unmount()
  })
})
